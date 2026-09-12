import { type FileState, isValidVaultPath, normalisePath } from '@obsidian-sync/protocol';
import { bytesToText, hashBytes, textToBytes } from '../crypto/encoding.js';
import type { PurposeKeys } from '../crypto/keys.js';
import type { BaseCache } from '../state/base-cache.js';
import type { FileIndex } from '../state/file-index.js';
import type { LocalState } from '../state/local-state.js';
import type { PendingIntent, PendingQueue } from '../state/pending-queue.js';
import { type ApiClient, ConflictError } from '../transport/client.js';
import { classifyFailure, retryDelayMs } from './backoff.js';
import { decodeFile, encodeFile } from './codec.js';
import {
	type ConflictChoice,
	type ConflictOutcome,
	type ConflictRecord,
	resolveConflictInVault,
} from './conflict.js';
import { copyStamp, uniqueCopyPath } from './copy.js';
import { merge3 } from './merge.js';
import { planReconcile, type ReconcileSummary } from './reconcile.js';
import { isPathIncluded, type SelectiveSyncOptions } from './selective.js';
import { isTextPath } from './text.js';
import { StaleWriteError, type VaultAdapter, type VaultFile } from './vault.js';

export type { ConflictChoice, ConflictOutcome, ConflictRecord } from './conflict.js';
export type { ReconcileSummary } from './reconcile.js';

export type EngineStatus = 'idle' | 'syncing' | 'conflict' | 'error';

export interface SyncEngineDeps {
	vaultId: string;
	client: ApiClient;
	keys: PurposeKeys;
	vault: VaultAdapter;
	index: FileIndex;
	bases: BaseCache;
	local: LocalState;
	queue: PendingQueue;
	selective: SelectiveSyncOptions;
	deviceId: string;
	deviceLabel: string;
	onStatus?: (status: EngineStatus) => void;
	onConflict?: (conflict: ConflictRecord) => void;
}

interface RemoteVersion {
	fileId: string;
	path: string;
	bytes: Uint8Array;
	mtime: number;
	chunks: string[];
	headVersion: string;
}

interface PushOutcome {
	committed: boolean;
	forget: boolean;
}

/**
 * Coordinates push, pull, and client-side conflict resolution (spec §7–§8).
 *
 * The server only ever rejects a stale commit (409); every merge decision lives
 * here, using the cached ancestor, and no path destroys data without an explicit
 * user choice: an unmergeable local edit is always copied out before the remote
 * version takes the file.
 */
export class SyncEngine {
	readonly #deps: SyncEngineDeps;
	#selective: SelectiveSyncOptions;
	#deviceLabel: string;
	#sawVault = false;
	#retired = false;

	constructor(deps: SyncEngineDeps) {
		this.#deps = deps;
		this.#selective = deps.selective;
		this.#deviceLabel = deps.deviceLabel;
	}

	/** Applies a settings change to a running engine, so a category toggle takes effect at once. */
	updateSelective(selective: SelectiveSyncOptions): void {
		this.#selective = selective;
	}

	/** Renaming a device applies to versions committed from now on, never retroactively. */
	updateDeviceLabel(deviceLabel: string): void {
		this.#deviceLabel = deviceLabel;
	}

	#status(status: EngineStatus): void {
		this.#deps.onStatus?.(status);
	}

	/**
	 * Stand down: the plugin has built a replacement engine over the same index, base
	 * cache and queue files. A run already in flight keeps unwinding — there is nothing
	 * to interrupt it mid-await — so it must instead stop doing work and stop persisting.
	 * These stores are whole-file writes with no merge, so one save from this stale view
	 * would resurrect items the replacement already drained, or erase a persisted halt.
	 *
	 * Dropping the unsaved half is safe by the same reasoning that lets the watchdog
	 * abandon a run: a vault write whose index entry never landed is re-adopted byte-for
	 * byte on the next pull or reconcile.
	 */
	retire(): void {
		this.#retired = true;
	}

	/** Drain queued changes. Full scans are reserved for reconciliation and recovery. */
	async pushAll(options: { fullScan?: boolean } = { fullScan: true }): Promise<void> {
		const { index, queue } = this.#deps;
		this.#status('syncing');
		try {
			await (options.fullScan ? this.#enqueueFullScan() : this.#enqueueConfigScan());

			const now = Date.now();
			await this.#drainReady('delete', now);
			await this.#drainReady('upsert', now);
			// An upsert whose path disappeared after it was queued becomes a delete.
			await this.#drainReady('delete', now);
		} finally {
			// Saved here rather than after the drain so a halt thrown out of it still keeps
			// the commits that did land; replaying one costs a 409 and a /state fetch each.
			if (!this.#retired) {
				await index.save();
				await this.#deps.bases.save();
				await queue.save();
			}
			this.#status('idle');
		}
	}

	/**
	 * `ready()` is a snapshot, so a queue-wide pause raised by one item's failure is
	 * invisible to the rest of the pass unless it is re-checked between items. Without
	 * this an offline device re-reads and re-encrypts every queued file before stopping.
	 */
	async #drainReady(intent: PendingIntent, now: number): Promise<void> {
		const { queue } = this.#deps;
		for (const item of queue.ready(now, intent)) {
			if (this.#retired || queue.pausedUntil() > now) {
				return;
			}
			await this.#drain(item.path, intent, now);
		}
	}

	/**
	 * Config-dir paths raise no vault event, so the watcher can never queue one. Without
	 * a scan on every sync a theme, snippet or plugin-settings change would sit unsynced
	 * until the next full reconcile.
	 */
	async #enqueueConfigScan(): Promise<void> {
		const { vault, queue } = this.#deps;
		for (const file of await vault.listConfig()) {
			if (isPathIncluded(file.path, this.#selective)) {
				queue.enqueueScanned(file.path, 'upsert');
			}
		}
	}

	async #enqueueFullScan(): Promise<void> {
		const { vault, index, queue } = this.#deps;
		const listed = await vault.list();
		if (listed.length > 0) {
			this.#sawVault = true;
		}
		for (const file of listed) {
			if (isPathIncluded(file.path, this.#selective)) {
				queue.enqueueScanned(file.path, 'upsert');
			}
		}
		if (this.#sawVault) {
			for (const entry of index.entries()) {
				if (isPathIncluded(entry.path, this.#selective) && !(await vault.exists(entry.path))) {
					queue.enqueueScanned(entry.path, 'delete');
				}
			}
		}
	}

	async #drain(path: string, intent: PendingIntent, now: number): Promise<void> {
		const { queue } = this.#deps;
		try {
			const outcome =
				intent === 'delete' ? await this.#pushDelete(path) : await this.#pushPath(path);
			if (outcome.forget) {
				queue.forget(path);
			}
		} catch (error) {
			const failure = classifyFailure(error);
			const attempts = queue.all().find((item) => item.path === path)?.attempts ?? 0;
			const delay = retryDelayMs(attempts + 1);
			if (failure === 'halt') {
				// Held until credentials are re-established. `reloadEngine` resumes the queue on
				// every rebuild, which is what both a settings save and a plugin reload do — without
				// that lift this pause is persisted and no edit ever uploads again.
				queue.pause(Number.MAX_SAFE_INTEGER);
				throw error;
			}
			if (failure === 'pause' || failure === 'retry-all') {
				queue.pause(now + delay);
			}
			queue.fail(path, delay, now, error instanceof Error ? error.message : 'Push failed');
		}
	}

	async #pushPath(path: string): Promise<PushOutcome> {
		const { vault, index, queue } = this.#deps;
		const file = await vault.stat(path);
		if (file === undefined) {
			queue.enqueue(path, 'delete');
			return { committed: false, forget: false };
		}
		if (!isPathIncluded(path, this.#selective)) {
			return { committed: false, forget: true };
		}
		if (file.size > this.#selective.maxFileBytes) {
			queue.block(path, 'oversize');
			return { committed: false, forget: false };
		}
		const data = await vault.read(path);
		const known = index.get(path);
		if (known !== undefined && known.hash === (await hashBytes(data))) {
			return { committed: false, forget: true };
		}
		return this.#pushFile(file, data);
	}

	async #pushFile(file: VaultFile, data: Uint8Array, attempt = 0): Promise<PushOutcome> {
		const { vaultId, client, keys, index, bases, deviceId } = this.#deps;
		const known = index.get(file.path);
		const encoded = await encodeFile(keys, {
			path: file.path,
			data,
			mtime: file.mtime,
			ctime: file.ctime,
			mime: mimeFor(file.path),
			deviceLabel: this.#deviceLabel,
		});

		const missing = (
			await client.checkBlobs(
				vaultId,
				encoded.chunks.map((chunk) => chunk.address),
			)
		).missing;
		const missingSet = new Set(missing);
		for (const chunk of encoded.chunks) {
			if (missingSet.has(chunk.address)) {
				await client.putBlob(vaultId, chunk.address, chunk.blob);
			}
		}

		try {
			const committed = await client.commit(vaultId, encoded.fileId, {
				parentVersion: known?.versionId,
				metaBlob: encoded.metaBlob,
				chunks: encoded.chunks.map((chunk) => chunk.address),
				size: encoded.size,
				deviceId,
			});
			index.set({
				fileId: encoded.fileId,
				versionId: committed.versionId,
				path: file.path,
				hash: await hashBytes(data),
				mtime: file.mtime,
				chunks: encoded.chunks.map((chunk) => chunk.address),
			});
			if (isTextPath(file.path)) {
				bases.set(encoded.fileId, bytesToText(data));
			}
			return { committed: true, forget: true };
		} catch (error) {
			if (error instanceof ConflictError && attempt < 2) {
				// §7.1 step 7: pull the winning version, merge locally, retry the push.
				await this.#pullFileById(encoded.fileId);
				if (await this.#deps.vault.exists(file.path)) {
					const updated = await this.#deps.vault.read(file.path);
					return this.#pushFile({ ...file }, updated, attempt + 1);
				}
				return { committed: false, forget: true };
			}
			throw error;
		}
	}

	async #pushDelete(path: string): Promise<PushOutcome> {
		const { vaultId, client, vault, index, bases } = this.#deps;
		const known = index.get(path);
		if (known === undefined) {
			return { committed: false, forget: true };
		}
		// A queued delete is stale the moment the path exists again, whether a pull
		// restored it or the user recreated it. Pushing it anyway destroys live
		// content — and because the engine's own trash call is itself reported by the
		// watcher as a user delete, two devices will otherwise delete and recreate the
		// same file at each other indefinitely.
		if (await vault.exists(path)) {
			return { committed: false, forget: true };
		}
		try {
			await client.delete(vaultId, known.fileId, known.versionId);
		} catch (error) {
			if (!(error instanceof ConflictError)) {
				throw error;
			}
		}
		index.delete(path);
		bases.delete(known.fileId);
		return { committed: true, forget: true };
	}

	/**
	 * Pull and durably apply everything past the stored cursor (§7.2). Returns how many
	 * files ended up merged locally, which the caller pushes back (§8).
	 */
	async pullAll(): Promise<number> {
		const { vaultId, client, local } = this.#deps;
		this.#status('syncing');
		let merged = 0;
		try {
			let cursor = local.getCursor();
			let hasMore = true;
			while (hasMore && !this.#retired) {
				const page = await client.changes(vaultId, cursor, 0);
				// One snapshot per page. It is taken after the page, so every change in the
				// page is reflected in it, and anything newer arrives under a later cursor.
				if (page.changes.length > 0) {
					const snapshot = await client.state(vaultId);
					const byFileId = new Map(snapshot.files.map((file) => [file.fileId, file]));
					for (const change of page.changes) {
						if (change.kind === 'delete') {
							merged += await this.#applyRemoteDelete(change.fileId);
							continue;
						}
						const state = byFileId.get(change.fileId);
						// Absent means the file was deleted after this upsert; the delete change
						// later in the same page is what applies.
						if (state !== undefined) {
							merged += await this.#applyRemoteState(change.fileId, state);
						}
					}
				}
				cursor = page.seq;
				local.setCursor(cursor);
				hasMore = page.hasMore;
			}
			if (!this.#retired) {
				await this.#deps.index.save();
				await this.#deps.bases.save();
			}
			return merged;
		} finally {
			this.#status('idle');
		}
	}

	/**
	 * Compare the whole vault against `GET /state` (§7.4) and repair what the
	 * incremental path cannot see: changes made while the app was terminated, a
	 * cursor lost to a crash, and a state directory that was wiped or restored.
	 *
	 * Every apply goes through the same two methods a pull uses, so §8's resolution
	 * table governs reconcile identically — nothing here decides a conflict of its
	 * own. The local half is left to `pushAll`, which already re-derives a dirty
	 * file and a local delete from the vault itself.
	 */
	async reconcile(): Promise<ReconcileSummary> {
		const { vaultId, client, index, bases, local } = this.#deps;
		this.#status('syncing');
		try {
			const snapshot = await client.state(vaultId);
			const plan = planReconcile({
				remote: snapshot.files.map((file) => ({
					fileId: file.fileId,
					headVersion: file.headVersion,
					size: file.size,
				})),
				indexed: index
					.entries()
					.map((entry) => ({ fileId: entry.fileId, versionId: entry.versionId })),
				maxFileBytes: this.#selective.maxFileBytes,
			});

			const byFileId = new Map(snapshot.files.map((file) => [file.fileId, file]));
			let mergedLocally = 0;
			for (const fileId of plan.pull) {
				const state = byFileId.get(fileId);
				if (state === undefined) {
					continue;
				}
				mergedLocally += await this.#applyRemoteState(fileId, state);
			}

			let removed = 0;
			for (const fileId of plan.remoteDeletes) {
				// A non-zero return means the local file was modified and survived, so it
				// was not removed — it is dirty, and the following push republishes it.
				const preserved = await this.#applyRemoteDelete(fileId);
				mergedLocally += preserved;
				removed += preserved === 0 ? 1 : 0;
			}

			// The server reads its sequence before listing files, so anything landing
			// mid-read is re-delivered rather than skipped and this snapshot's seq is a
			// safe cursor. Raised only: a pull already further ahead must not replay.
			// Not raised at all when the plan skipped an oversized file: the incremental
			// path has no size limit and will deliver it, but only while the cursor still
			// sits behind it, so adopting the seq here would strand that file forever.
			if (plan.oversized.length === 0) {
				local.setCursor(Math.max(local.getCursor(), snapshot.seq));
			}

			if (!this.#retired) {
				await index.save();
				await bases.save();
			}

			return {
				remoteFiles: snapshot.files.length,
				pulled: plan.pull.length,
				mergedLocally,
				removed,
				skippedOversize: plan.oversized.length,
				massDeleteGuarded: plan.massDeleteGuarded,
			};
		} finally {
			this.#status('idle');
		}
	}

	/** Fetch one file's current server record. Used by the push path's 409 retry only. */
	async #pullFileById(fileId: string): Promise<number> {
		const { vaultId, client } = this.#deps;
		const snapshot = await client.state(vaultId);
		const state = snapshot.files.find((file) => file.fileId === fileId);
		return state === undefined ? 0 : this.#applyRemoteState(fileId, state);
	}

	/** Decrypt one server file record and apply it under §8. Returns 1 if it merged. */
	async #applyRemoteState(fileId: string, state: FileState): Promise<number> {
		const { vaultId, client, keys } = this.#deps;
		const decoded = await decodeFile(keys, fileId, state.metaBlob, (address) =>
			client.getBlob(vaultId, address),
		);
		// Anyone holding the vault key controls this string, and it is about to be a
		// filesystem write: `..` escapes the vault, and `.obsidian/../..` escapes it while
		// still satisfying the never-synced prefix test that guards our own state dir.
		const path = normalisePath(decoded.path);
		if (!isValidVaultPath(path) || !isPathIncluded(path, this.#selective)) {
			return 0;
		}
		return this.#applyRemoteFile({
			fileId,
			path,
			bytes: decoded.data,
			mtime: decoded.meta.mtime,
			chunks: decoded.meta.chunks,
			headVersion: state.headVersion,
		});
	}

	/** Apply one remote version to the local file under §8's resolution table. */
	async #applyRemoteFile(remote: RemoteVersion, attempt = 0): Promise<number> {
		const { vault, index, bases } = this.#deps;
		const { path, fileId, headVersion } = remote;
		const known = index.get(path);
		const localExists = await vault.exists(path);
		const localBytes = localExists ? await vault.read(path) : undefined;
		const localHash = localBytes === undefined ? undefined : await hashBytes(localBytes);

		const localChanged = known === undefined || localHash === undefined || known.hash !== localHash;

		if (known !== undefined && known.versionId === headVersion && !localChanged) {
			return 0;
		}

		// Identical bytes are never a conflict, however the two sides got there. Without
		// this, a file whose index entry was lost looks changed with no known ancestor
		// and takes the conflict-copy path, duplicating content that already matches.
		if (localBytes !== undefined && localHash === (await hashBytes(remote.bytes))) {
			await this.#recordRemote(remote);
			return 0;
		}

		try {
			if (!localChanged || localBytes === undefined) {
				await vault.write(path, remote.bytes, { mtime: remote.mtime, expected: localBytes });
				await this.#recordRemote(remote);
				return 0;
			}

			const base = bases.get(fileId);
			if (isTextPath(path) && base !== undefined) {
				const merged = merge3(base, bytesToText(localBytes), bytesToText(remote.bytes));
				if (merged.ok) {
					await vault.write(path, textToBytes(merged.text), {
						mtime: remote.mtime,
						expected: localBytes,
					});
					// The index records the remote ancestor, not the merged bytes, so the
					// merge stays dirty and the next push commits it against headVersion.
					await this.#recordRemote(remote);
					return 1;
				}
			}

			// Conflicted, binary, or no ancestor: keep the user's bytes out-of-band, then
			// let remote take the file. Merging without an ancestor invents changes.
			await this.#conflictCopy(path, localBytes);
			await vault.write(path, remote.bytes, { mtime: remote.mtime, expected: localBytes });
			await this.#recordRemote(remote);
			return 0;
		} catch (error) {
			if (error instanceof StaleWriteError && attempt < 2) {
				return this.#applyRemoteFile(remote, attempt + 1);
			}
			throw error;
		}
	}

	async #recordRemote(remote: RemoteVersion): Promise<void> {
		const { index, bases } = this.#deps;
		index.set({
			fileId: remote.fileId,
			versionId: remote.headVersion,
			path: remote.path,
			hash: await hashBytes(remote.bytes),
			mtime: remote.mtime,
			chunks: remote.chunks,
		});
		if (isTextPath(remote.path)) {
			bases.set(remote.fileId, bytesToText(remote.bytes));
		}
	}

	async #applyRemoteDelete(fileId: string): Promise<number> {
		const { index, bases, vault } = this.#deps;
		const entry = index.getByFileId(fileId);
		if (entry === undefined) {
			return 0;
		}

		let preserved = 0;
		if (isPathIncluded(entry.path, this.#selective) && (await vault.exists(entry.path))) {
			const localHash = await hashBytes(await vault.read(entry.path));
			// §8: deletion never beats an edit. Forgetting the remote identity leaves the
			// surviving file dirty, so the next push republishes it as a fresh version.
			if (localHash === entry.hash) {
				await vault.trash(entry.path);
			} else {
				preserved = 1;
			}
		}

		index.delete(entry.path);
		bases.delete(fileId);
		return preserved;
	}

	async #conflictCopy(path: string, localBytes: Uint8Array): Promise<void> {
		const copyPath = await uniqueCopyPath(
			(candidate) => this.#deps.vault.exists(candidate),
			path,
			`conflict ${copyStamp(Date.now())}`,
		);
		await this.#deps.vault.write(copyPath, localBytes);
		const record: ConflictRecord = { path, conflictCopyPath: copyPath };
		this.#status('conflict');
		this.#deps.onConflict?.(record);
	}

	/**
	 * Resolve a conflict and, for `mine`, queue the restored bytes for push. The vault
	 * half is `resolveConflictInVault`, which the plugin also calls directly when sync is
	 * switched off and there is no engine; the queueing is the part only an engine can do,
	 * because an ordinary sync drains the queue rather than rescanning, and a config-dir
	 * path raises no vault event for the watcher to pick up either.
	 */
	async resolveConflict(record: ConflictRecord, choice: ConflictChoice): Promise<ConflictOutcome> {
		const outcome = await resolveConflictInVault(this.#deps.vault, record, choice);
		if (outcome === 'resolved' && choice === 'mine') {
			this.#deps.queue.enqueue(record.path, 'upsert');
		}
		return outcome;
	}
}

function mimeFor(path: string): string {
	if (path.endsWith('.md') || path.endsWith('.markdown')) {
		return 'text/markdown';
	}
	if (path.endsWith('.json')) {
		return 'application/json';
	}
	if (path.endsWith('.css')) {
		return 'text/css';
	}
	return 'application/octet-stream';
}

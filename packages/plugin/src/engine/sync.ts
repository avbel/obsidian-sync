import { hashBytes } from '../crypto/encoding.js';
import type { PurposeKeys } from '../crypto/keys.js';
import type { BaseCache } from '../state/base-cache.js';
import type { FileIndex } from '../state/file-index.js';
import type { LocalState } from '../state/local-state.js';
import { type ApiClient, ConflictError } from '../transport/client.js';
import { decodeFile, encodeFile } from './codec.js';
import { merge3 } from './merge.js';
import { isPathIncluded, type SelectiveSyncOptions } from './selective.js';
import type { VaultAdapter, VaultFile } from './vault.js';

export type EngineStatus = 'idle' | 'syncing' | 'conflict' | 'error';

export interface ConflictRecord {
	path: string;
	conflictCopyPath: string;
}

export interface SyncEngineDeps {
	vaultId: string;
	client: ApiClient;
	keys: PurposeKeys;
	vault: VaultAdapter;
	index: FileIndex;
	bases: BaseCache;
	local: LocalState;
	selective: SelectiveSyncOptions;
	deviceId: string;
	onStatus?: (status: EngineStatus) => void;
	onConflict?: (conflict: ConflictRecord) => void;
}

const textExtensions = [
	'.md',
	'.markdown',
	'.txt',
	'.csv',
	'.json',
	'.css',
	'.js',
	'.html',
	'.yml',
	'.yaml',
];

function isTextPath(path: string): boolean {
	return textExtensions.some((extension) => path.endsWith(extension));
}

function bytesToText(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function textToBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
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

	constructor(deps: SyncEngineDeps) {
		this.#deps = deps;
	}

	#status(status: EngineStatus): void {
		this.#deps.onStatus?.(status);
	}

	/** Push every file whose bytes differ from the index, and every local delete. */
	async pushAll(deletedPaths: string[] = []): Promise<void> {
		const { vault, index, selective } = this.#deps;
		this.#status('syncing');
		try {
			// Deletes first (§9): draining a queue after a long offline period replays
			// coherently if removals precede content writes.
			for (const path of deletedPaths) {
				await this.#pushDelete(path);
			}

			for (const file of await vault.list()) {
				if (!isPathIncluded(file.path, selective) || file.size > selective.maxFileBytes) {
					continue;
				}
				const data = await vault.read(file.path);
				const hash = await hashBytes(data);
				const known = index.get(file.path);
				if (known !== undefined && known.hash === hash) {
					continue;
				}
				await this.#pushFile(file, data);
			}
			await index.save();
			await this.#deps.bases.save();
		} finally {
			this.#status('idle');
		}
	}

	async #pushFile(file: VaultFile, data: Uint8Array, attempt = 0): Promise<void> {
		const { vaultId, client, keys, index, bases, deviceId } = this.#deps;
		const known = index.get(file.path);
		const encoded = await encodeFile(
			keys,
			file.path,
			data,
			{ mtime: file.mtime, ctime: file.ctime },
			mimeFor(file.path),
		);

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
		} catch (error) {
			if (error instanceof ConflictError && attempt < 2) {
				// §7.1 step 7: pull the winning version, merge locally, retry the push.
				await this.#pullFileById(encoded.fileId);
				if (await this.#deps.vault.exists(file.path)) {
					const updated = await this.#deps.vault.read(file.path);
					await this.#pushFile({ ...file }, updated, attempt + 1);
				}
				return;
			}
			throw error;
		}
	}

	async #pushDelete(path: string): Promise<void> {
		const { vaultId, client, index, bases } = this.#deps;
		const known = index.get(path);
		if (known === undefined) {
			return;
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
	}

	/** Pull and durably apply everything past the stored cursor (§7.2). */
	async pullAll(): Promise<void> {
		const { vaultId, client, local } = this.#deps;
		this.#status('syncing');
		try {
			let cursor = local.getCursor();
			let hasMore = true;
			while (hasMore) {
				const page = await client.changes(vaultId, cursor, 0);
				for (const change of page.changes) {
					if (change.kind === 'delete') {
						await this.#applyRemoteDelete(change.fileId);
					} else {
						await this.#pullFileById(change.fileId);
					}
				}
				cursor = page.seq;
				local.setCursor(cursor);
				hasMore = page.hasMore;
			}
			await this.#deps.index.save();
			await this.#deps.bases.save();
		} finally {
			this.#status('idle');
		}
	}

	async #pullFileById(fileId: string): Promise<void> {
		const { vaultId, client, keys, index, selective } = this.#deps;
		const state = (await client.state(vaultId)).files.find((file) => file.fileId === fileId);
		if (state === undefined) {
			return;
		}
		const decoded = await decodeFile(keys, fileId, state.metaBlob, (address) =>
			client.getBlob(vaultId, address),
		);
		if (!isPathIncluded(decoded.path, selective)) {
			return;
		}
		await this.#applyRemoteFile(
			fileId,
			decoded.path,
			decoded.data,
			decoded.meta.mtime,
			decoded.meta.chunks,
			state.headVersion,
		);
	}

	/** Apply one remote version to the local file under §8's resolution table. */
	async #applyRemoteFile(
		fileId: string,
		path: string,
		remoteBytes: Uint8Array,
		remoteMtime: number,
		chunks: string[],
		headVersion: string,
	): Promise<void> {
		const { vault, index, bases } = this.#deps;
		const known = index.get(path);
		const localExists = await vault.exists(path);
		const localBytes = localExists ? await vault.read(path) : undefined;
		const localHash = localBytes === undefined ? undefined : await hashBytes(localBytes);

		const localChanged = known === undefined || localHash === undefined || known.hash !== localHash;

		// Local already matches what the server holds: nothing to do.
		if (known !== undefined && known.versionId === headVersion && !localChanged) {
			return;
		}

		if (!localChanged || localBytes === undefined) {
			await this.#writeRemote(path, remoteBytes, remoteMtime, fileId, headVersion, chunks);
			return;
		}

		// Deleted remotely then modified locally is never reached here: pullAll applies
		// the delete, and the surviving local edit re-pushes next cycle (deletion loses).

		const base = bases.get(fileId);
		if (isTextPath(path) && base !== undefined) {
			const merged = merge3(base, bytesToText(localBytes), bytesToText(remoteBytes));
			if (merged.ok) {
				const mergedBytes = textToBytes(merged.text);
				await vault.write(path, mergedBytes, remoteMtime);
				await this.#rememberMerge(path, mergedBytes, remoteMtime, fileId, headVersion, chunks);
				return;
			}
			// Conflicted: keep the user's bytes out-of-band, then let remote take the file.
			await this.#conflictCopy(path, localBytes);
			await this.#writeRemote(path, remoteBytes, remoteMtime, fileId, headVersion, chunks);
			return;
		}

		// Binary, or no ancestor: conflict copy always — merging without a base invents changes.
		await this.#conflictCopy(path, localBytes);
		await this.#writeRemote(path, remoteBytes, remoteMtime, fileId, headVersion, chunks);
	}

	async #writeRemote(
		path: string,
		bytes: Uint8Array,
		mtime: number,
		fileId: string,
		versionId: string,
		chunks: string[],
	): Promise<void> {
		const { vault, index, bases } = this.#deps;
		await vault.write(path, bytes, mtime);
		index.set({ fileId, versionId, path, hash: await hashBytes(bytes), mtime, chunks });
		if (isTextPath(path)) {
			bases.set(fileId, bytesToText(bytes));
		}
	}

	async #rememberMerge(
		path: string,
		bytes: Uint8Array,
		mtime: number,
		fileId: string,
		versionId: string,
		chunks: string[],
	): Promise<void> {
		const { index, bases } = this.#deps;
		index.set({ fileId, versionId, path, hash: await hashBytes(bytes), mtime, chunks });
		if (isTextPath(path)) {
			bases.set(fileId, bytesToText(bytes));
		}
	}

	async #applyRemoteDelete(fileId: string): Promise<void> {
		const { index, bases, vault, selective } = this.#deps;
		const entry = index.entries().find((candidate) => candidate.fileId === fileId);
		if (entry === undefined) {
			return;
		}
		if (isPathIncluded(entry.path, selective) && (await vault.exists(entry.path))) {
			await vault.trash(entry.path);
		}
		index.delete(entry.path);
		bases.delete(fileId);
	}

	async #conflictCopy(path: string, localBytes: Uint8Array): Promise<void> {
		const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, ' ').replace(/ /g, '-');
		const copyPath = `${path.replace(/\.[^.]+$/, '')} (conflict ${stamp}).md`;
		await this.#deps.vault.write(copyPath, localBytes);
		const record: ConflictRecord = { path, conflictCopyPath: copyPath };
		this.#status('conflict');
		this.#deps.onConflict?.(record);
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

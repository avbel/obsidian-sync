import type { VersionSummary } from '@obsidian-sync/protocol';
import { sameBytes } from '../crypto/encoding.js';
import { computeFileId } from '../crypto/identity.js';
import type { PurposeKeys } from '../crypto/keys.js';
import { decryptFileMeta } from '../crypto/meta.js';
import type { FileIndex } from '../state/file-index.js';
import { type ApiClient, ServerError } from '../transport/client.js';
import { decodeFile } from './codec.js';
import { copyStamp, uniqueCopyPath } from './copy.js';
import type { VaultAdapter } from './vault.js';

/** A version whose chunks are no longer on the server: retention drift, or a swept blob. */
export class VersionContentUnavailableError extends Error {
	constructor(versionId: string) {
		super(`the content of version ${versionId} is no longer stored on the server`);
		this.name = 'VersionContentUnavailableError';
	}
}

/** A version whose meta envelope will not decrypt under the current passphrase. */
export class VersionUnreadableError extends Error {
	constructor(versionId: string) {
		super(`version ${versionId} cannot be decrypted with the current passphrase`);
		this.name = 'VersionUnreadableError';
	}
}

/** Why a version cannot be previewed or restored. An old server reads very differently from a bad passphrase. */
export type HistoryUnreadable = 'undecryptable' | 'no-metadata';

export interface HistoryEntry extends VersionSummary {
	/** From the encrypted meta; undefined on versions committed before labels existed. */
	deviceLabel: string | undefined;
	/** False when the meta envelope did not decrypt; such a version cannot be restored. */
	readable: boolean;
	/** Set whenever `readable` is false, so the UI does not blame the passphrase for an old server. */
	unreadableReason: HistoryUnreadable | undefined;
	/** The version this device's index last reconciled with. */
	isCurrent: boolean;
	isLocalDevice: boolean;
}

export interface HistoryPage {
	fileId: string;
	path: string;
	entries: HistoryEntry[];
	hasMore: boolean;
}

export interface RestoreRequest {
	path: string;
	fileId: string;
	entry: HistoryEntry;
}

export type RestoreOutcome = { status: 'restored' } | { status: 'unchanged' };

export interface VersionHistoryDeps {
	vaultId: string;
	client: ApiClient;
	keys: PurposeKeys;
	vault: VaultAdapter;
	index: FileIndex;
	deviceId: string;
	/** Queues the restored path and persists it; an ordinary sync drains the queue and never rescans. */
	enqueue: (path: string) => Promise<void>;
	/** Pushes restored bytes; injected so the service never owns the sync loop. */
	requestSync: () => Promise<void>;
}

const defaultPageSize = 50;

/**
 * Version history and restore (§6.3.5).
 *
 * Restore deliberately goes through the vault and the ordinary push, never straight
 * to the server: that is what makes a restore a new version committed against the
 * current head, and what lets it inherit stale-write detection, merge, and the
 * offline path instead of reimplementing them.
 */
export class VersionHistoryService {
	readonly #deps: VersionHistoryDeps;

	constructor(deps: VersionHistoryDeps) {
		this.#deps = deps;
	}

	async list(path: string, window?: { limit?: number; offset?: number }): Promise<HistoryPage> {
		const { client, vaultId, index, keys, deviceId } = this.#deps;
		const indexed = index.get(path);
		const fileId = indexed?.fileId ?? (await computeFileId(keys.nameMacKey, path));
		const response = await client.versions(vaultId, fileId, {
			limit: window?.limit ?? defaultPageSize,
			offset: window?.offset ?? 0,
		});

		const entries: HistoryEntry[] = [];
		for (const version of response.versions) {
			const label = await this.#readLabel(fileId, version.metaBlob);
			entries.push({
				...version,
				deviceLabel: label.deviceLabel,
				readable: label.unreadableReason === undefined,
				unreadableReason: label.unreadableReason,
				isCurrent: version.versionId === indexed?.versionId,
				isLocalDevice: version.deviceId === deviceId,
			});
		}

		// Coerced rather than trusted: a server predating this field sends nothing, and an
		// undefined here would render as a permanently missing "load older" button.
		return { fileId, path, entries, hasMore: response.hasMore === true };
	}

	async #readLabel(
		fileId: string,
		metaBlob: string | undefined,
	): Promise<{ deviceLabel: string | undefined; unreadableReason: HistoryUnreadable | undefined }> {
		// A server older than the version-history release returns no meta at all. Calling that
		// a decryption failure sends the user hunting for a passphrase problem they do not have.
		if (metaBlob === undefined || metaBlob === '') {
			return { deviceLabel: undefined, unreadableReason: 'no-metadata' };
		}
		try {
			const meta = await decryptFileMeta(this.#deps.keys.contentCryptoKey, fileId, metaBlob);
			return { deviceLabel: meta.deviceLabel, unreadableReason: undefined };
		} catch {
			return { deviceLabel: undefined, unreadableReason: 'undecryptable' };
		}
	}

	/** The bytes on disk now, so a preview can diff against the live file. */
	async readCurrent(path: string): Promise<Uint8Array | undefined> {
		const { vault } = this.#deps;
		return (await vault.exists(path)) ? vault.read(path) : undefined;
	}

	/** The plaintext bytes of one version, integrity-checked chunk by chunk. */
	async read(fileId: string, entry: HistoryEntry): Promise<Uint8Array> {
		if (!entry.readable) {
			throw new VersionUnreadableError(entry.versionId);
		}
		const { client, vaultId, keys } = this.#deps;
		try {
			return (
				await decodeFile(keys, fileId, entry.metaBlob, (address) =>
					client.getBlob(vaultId, address),
				)
			).data;
		} catch (error) {
			if (error instanceof ServerError && error.status === 404) {
				throw new VersionContentUnavailableError(entry.versionId);
			}
			throw error;
		}
	}

	/** Write a historical version over the live file and commit it as a new head version. */
	async restore(request: RestoreRequest): Promise<RestoreOutcome> {
		const { vault } = this.#deps;
		const bytes = await this.read(request.fileId, request.entry);
		const current = (await vault.exists(request.path)) ? await vault.read(request.path) : undefined;

		if (current !== undefined && sameBytes(current, bytes)) {
			return { status: 'unchanged' };
		}

		await vault.write(request.path, bytes, { mtime: Date.now(), expected: current });
		await this.#deps.enqueue(request.path);
		// The bytes are on disk and the path is durably queued, so a sync failing here is a
		// delayed push, not a failed restore — saying "restore failed" would send the user
		// looking for a note that was in fact restored. Sync reports its own errors.
		await this.#deps.requestSync().catch(() => undefined);
		return { status: 'restored' };
	}

	/** Write the version alongside the live file instead of over it. */
	async restoreAsCopy(request: RestoreRequest): Promise<{ copyPath: string }> {
		const { vault } = this.#deps;
		const bytes = await this.read(request.fileId, request.entry);
		const copyPath = await uniqueCopyPath(
			(candidate) => vault.exists(candidate),
			request.path,
			`restored ${copyStamp(request.entry.createdAt)}`,
		);
		await vault.write(copyPath, bytes);
		await this.#deps.enqueue(copyPath);
		// The bytes are on disk and the path is durably queued, so a sync failing here is a
		// delayed push, not a failed restore — saying "restore failed" would send the user
		// looking for a note that was in fact restored. Sync reports its own errors.
		await this.#deps.requestSync().catch(() => undefined);
		return { copyPath };
	}
}

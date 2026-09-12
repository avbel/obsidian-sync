import type { VersionSummary } from '@obsidian-sync/protocol';
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

export interface HistoryEntry extends VersionSummary {
	/** From the encrypted meta; undefined on versions committed before labels existed. */
	deviceLabel: string | undefined;
	/** False when the meta envelope did not decrypt; such a version cannot be restored. */
	readable: boolean;
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
	/** Queues the restored path: an ordinary sync drains the queue and never rescans. */
	enqueue: (path: string) => void;
	/** Pushes restored bytes; injected so the service never owns the sync loop. */
	requestSync: () => Promise<void>;
}

const defaultPageSize = 50;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

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
				readable: label.readable,
				isCurrent: version.versionId === indexed?.versionId,
				isLocalDevice: version.deviceId === deviceId,
			});
		}

		return { fileId, path, entries, hasMore: response.hasMore };
	}

	async #readLabel(
		fileId: string,
		metaBlob: string,
	): Promise<{ deviceLabel: string | undefined; readable: boolean }> {
		try {
			const meta = await decryptFileMeta(this.#deps.keys.contentCryptoKey, fileId, metaBlob);
			return { deviceLabel: meta.deviceLabel, readable: true };
		} catch {
			return { deviceLabel: undefined, readable: false };
		}
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
		this.#deps.enqueue(request.path);
		await this.#deps.requestSync();
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
		this.#deps.enqueue(copyPath);
		await this.#deps.requestSync();
		return { copyPath };
	}
}

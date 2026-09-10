import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const addressPattern = /^[0-9a-f]{64}$/;
const vaultIdPattern = /^[0-9a-zA-Z_-]+$/;

export class BlobStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BlobStoreError';
	}
}

export interface BlobStore {
	has(vaultId: string, address: string): Promise<boolean>;
	put(vaultId: string, address: string, data: Uint8Array): Promise<void>;
	get(vaultId: string, address: string): Promise<Uint8Array | undefined>;
	remove(vaultId: string, address: string): Promise<void>;
	writtenAt(vaultId: string, address: string): Promise<number | undefined>;
}

function assertSafe(vaultId: string, address: string): void {
	if (!vaultIdPattern.test(vaultId)) {
		throw new BlobStoreError(`invalid vault id "${vaultId}"`);
	}
	if (!addressPattern.test(address)) {
		throw new BlobStoreError('blob address must be 64 lowercase hex characters');
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function createBlobStore(rootDir: string): BlobStore {
	const shardDir = (vaultId: string, address: string): string =>
		join(rootDir, vaultId, address.slice(0, 2));

	const blobPath = (vaultId: string, address: string): string =>
		join(shardDir(vaultId, address), address);

	return {
		async has(vaultId, address) {
			if (!vaultIdPattern.test(vaultId) || !addressPattern.test(address)) {
				return false;
			}
			try {
				await stat(blobPath(vaultId, address));
				return true;
			} catch (error) {
				if (isMissing(error)) {
					return false;
				}
				throw error;
			}
		},

		async put(vaultId, address, data) {
			assertSafe(vaultId, address);

			const directory = shardDir(vaultId, address);
			await mkdir(directory, { recursive: true });

			// Write to a temporary name, fsync, then rename. Rename is atomic within
			// a directory, so a reader never observes a partially written blob and a
			// crash leaves at most a stray temp file.
			const temporaryPath = join(directory, `.tmp-${randomUUID()}`);
			const handle = await open(temporaryPath, 'w');
			try {
				await handle.writeFile(data);
				await handle.sync();
			} finally {
				await handle.close();
			}

			try {
				await rename(temporaryPath, blobPath(vaultId, address));
			} catch (error) {
				await rm(temporaryPath, { force: true });
				throw error;
			}
		},

		async get(vaultId, address) {
			if (!vaultIdPattern.test(vaultId) || !addressPattern.test(address)) {
				return undefined;
			}
			try {
				return new Uint8Array(await readFile(blobPath(vaultId, address)));
			} catch (error) {
				if (isMissing(error)) {
					return undefined;
				}
				throw error;
			}
		},

		async remove(vaultId, address) {
			if (!vaultIdPattern.test(vaultId) || !addressPattern.test(address)) {
				return;
			}
			await rm(blobPath(vaultId, address), { force: true });
		},

		async writtenAt(vaultId, address) {
			if (!vaultIdPattern.test(vaultId) || !addressPattern.test(address)) {
				return undefined;
			}
			try {
				return (await stat(blobPath(vaultId, address))).mtimeMs;
			} catch (error) {
				if (isMissing(error)) {
					return undefined;
				}
				throw error;
			}
		},
	};
}

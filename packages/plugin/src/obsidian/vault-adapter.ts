import { type App, normalizePath, TFile } from 'obsidian';
import {
	StaleWriteError,
	type VaultAdapter,
	type VaultFile,
	type WriteOptions,
} from '../engine/vault.js';

function isTextFile(path: string): boolean {
	return /\.(md|markdown|txt|csv|json|css|js|html|yml|yaml|svg)$/i.test(path);
}

function toVaultFile(file: TFile): VaultFile {
	return { path: file.path, mtime: file.stat.mtime, size: file.stat.size, ctime: file.stat.ctime };
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(buffer).set(data);
	return buffer;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	return left.every((byte, index) => byte === right[index]);
}

/**
 * VaultAdapter over Obsidian's `app.vault`.
 *
 * Paths under the config directory are invisible to the TFile APIs, so they are
 * routed through `vault.adapter` instead; everything else uses the file tree so
 * Obsidian's caches stay coherent. Text writes go through `process`, whose
 * read-modify-write is atomic, which is what makes the `expected` guard sound.
 */
export function createVaultAdapter(app: App): VaultAdapter {
	const adapter = app.vault.adapter;
	const configDir = normalizePath(app.vault.configDir);

	const isConfig = (path: string): boolean =>
		path === configDir || path.startsWith(`${configDir}/`);

	const asTFile = (path: string): TFile | null => {
		const found = app.vault.getAbstractFileByPath(path);
		return found instanceof TFile ? found : null;
	};

	const listConfigFiles = async (): Promise<VaultFile[]> => {
		const collected: VaultFile[] = [];
		const walk = async (directory: string): Promise<void> => {
			const listed = await adapter.list(directory).catch(() => undefined);
			if (listed === undefined) {
				return;
			}
			for (const path of listed.files) {
				const found = await adapter.stat(path).catch(() => null);
				if (found !== null && found.type === 'file') {
					collected.push({
						path,
						mtime: found.mtime,
						size: found.size,
						ctime: found.ctime,
					});
				}
			}
			for (const folder of listed.folders) {
				await walk(folder);
			}
		};
		await walk(configDir);
		return collected;
	};

	const ensureParentFolder = async (target: string): Promise<void> => {
		const slash = target.lastIndexOf('/');
		if (slash <= 0) {
			return;
		}
		const parent = target.slice(0, slash);
		if (isConfig(target)) {
			await adapter.mkdir(parent).catch(() => undefined);
			return;
		}
		let current = '';
		for (const segment of parent.split('/')) {
			current = current === '' ? segment : `${current}/${segment}`;
			if (app.vault.getFolderByPath(current) === null) {
				await app.vault.createFolder(current).catch(() => undefined);
			}
		}
	};

	return {
		async list() {
			return [...app.vault.getFiles().map(toVaultFile), ...(await listConfigFiles())];
		},

		async listConfig() {
			return listConfigFiles();
		},

		async exists(path) {
			const target = normalizePath(path);
			return isConfig(target) ? adapter.exists(target) : asTFile(target) !== null;
		},

		async stat(path) {
			const target = normalizePath(path);
			if (isConfig(target)) {
				const found = await adapter.stat(target).catch(() => null);
				if (found === null || found.type !== 'file') {
					return undefined;
				}
				return { path: target, mtime: found.mtime, size: found.size, ctime: found.ctime };
			}
			const file = asTFile(target);
			return file === null ? undefined : toVaultFile(file);
		},

		async read(path) {
			const target = normalizePath(path);
			if (isConfig(target)) {
				return new Uint8Array(await adapter.readBinary(target));
			}
			const file = asTFile(target);
			if (file === null) {
				throw new Error(`cannot read missing file ${target}`);
			}
			return new Uint8Array(await app.vault.readBinary(file));
		},

		async write(path, data, options?: WriteOptions) {
			const target = normalizePath(path);
			const expected = options?.expected;
			const config = isConfig(target);
			const file = config ? null : asTFile(target);
			const present = config ? await adapter.exists(target) : file !== null;

			if (!present) {
				await ensureParentFolder(target);
				if (config) {
					await adapter.writeBinary(target, toArrayBuffer(data));
				} else {
					await app.vault.createBinary(target, toArrayBuffer(data));
				}
				return;
			}

			if (isTextFile(target)) {
				const replacement = decode(data);
				const guard = (current: string): string => {
					if (expected !== undefined && current !== decode(expected)) {
						throw new StaleWriteError(target);
					}
					return replacement;
				};
				if (file === null) {
					await adapter.process(target, guard);
				} else {
					await app.vault.process(file, guard);
				}
				return;
			}

			if (expected !== undefined) {
				const current = config
					? new Uint8Array(await adapter.readBinary(target))
					: new Uint8Array(await app.vault.readBinary(file as TFile));
				if (!sameBytes(current, expected)) {
					throw new StaleWriteError(target);
				}
			}
			if (file === null) {
				await adapter.writeBinary(target, toArrayBuffer(data));
			} else {
				await app.vault.modifyBinary(file, toArrayBuffer(data));
			}
		},

		async remove(path) {
			const target = normalizePath(path);
			if (isConfig(target)) {
				if (await adapter.exists(target)) {
					await adapter.remove(target);
				}
				return;
			}
			const file = asTFile(target);
			if (file !== null) {
				await app.fileManager.trashFile(file);
			}
		},

		async trash(path) {
			const target = normalizePath(path);
			if (isConfig(target)) {
				if (await adapter.exists(target)) {
					await adapter.trashLocal(target).catch(() => adapter.remove(target));
				}
				return;
			}
			const file = asTFile(target);
			if (file !== null) {
				await app.fileManager.trashFile(file);
			}
		},
	};
}

export { isTextFile };

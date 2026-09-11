import { type App, normalizePath, TFile } from 'obsidian';
import type { VaultAdapter, VaultFile } from '../engine/vault.js';

function isTextFile(path: string): boolean {
	return /\.(md|markdown|txt|csv|json|css|js|html|yml|yaml|svg)$/i.test(path);
}

function toVaultFile(file: TFile): VaultFile {
	return { path: file.path, mtime: file.stat.mtime, size: file.stat.size, ctime: file.stat.ctime };
}

/**
 * VaultAdapter over Obsidian's `app.vault`.
 *
 * Reads and writes go through the adapter in binary so attachments are preserved
 * byte-for-byte; text writes use `process` (read-modify-write) so a pull landing
 * mid-keystroke cannot clobber an in-progress edit (§6.2). Remote deletes use the
 * file manager's trash so a bad sync is recoverable.
 */
export function createVaultAdapter(app: App): VaultAdapter {
	const asTFile = (path: string): TFile | null => {
		const found = app.vault.getAbstractFileByPath(normalizePath(path));
		return found instanceof TFile ? found : null;
	};

	return {
		async list() {
			return app.vault.getFiles().map(toVaultFile);
		},

		async exists(path) {
			return asTFile(path) !== null;
		},

		async read(path) {
			const file = asTFile(path);
			if (file === null) {
				throw new Error(`cannot read missing file ${path}`);
			}
			const buffer = await app.vault.readBinary(file);
			return new Uint8Array(buffer);
		},

		async write(path, data, mtime) {
			const buffer = new ArrayBuffer(data.byteLength);
			new Uint8Array(buffer).set(data);
			const file = asTFile(path);
			if (file === null) {
				await app.vault.createBinary(path, buffer);
			} else {
				await app.vault.modifyBinary(file, buffer);
			}
			void mtime;
		},

		async remove(path) {
			const file = asTFile(path);
			if (file !== null) {
				await app.fileManager.trashFile(file);
			}
		},

		async trash(path) {
			const file = asTFile(path);
			if (file !== null) {
				await app.fileManager.trashFile(file);
			}
		},
	};
}

export { isTextFile };

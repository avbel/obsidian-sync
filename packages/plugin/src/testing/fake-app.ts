import type { App } from 'obsidian';
import { TFile } from 'obsidian';

interface StoredFile {
	data: Uint8Array;
	mtime: number;
	ctime: number;
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function toBuffer(data: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(buffer).set(data);
	return buffer;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash <= 0 ? '' : path.slice(0, slash);
}

/**
 * An in-memory App covering the vault surface the adapter uses. It reproduces the
 * two behaviours that matter for correctness: createBinary refuses a path whose
 * folder does not exist, and the TFile APIs cannot see the config directory.
 */
export class FakeApp {
	readonly files = new Map<string, StoredFile>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	readonly configDir = '.obsidian';
	/** Obsidian's per-device localStorage, where the conflict list and cursor live. */
	readonly local = new Map<string, string>();
	/** Obsidian's secret storage, which holds the token and passphrase. */
	readonly secrets = new Map<string, string>();

	put(path: string, text: string): void {
		this.files.set(path, { data: encode(text), mtime: 1, ctime: 1 });
		let current = '';
		for (const segment of parentOf(path).split('/').filter(Boolean)) {
			current = current === '' ? segment : `${current}/${segment}`;
			this.folders.add(current);
		}
	}

	text(path: string): string | undefined {
		const file = this.files.get(path);
		return file === undefined ? undefined : new TextDecoder().decode(file.data);
	}

	#isConfig(path: string): boolean {
		return path === this.configDir || path.startsWith(`${this.configDir}/`);
	}

	#tfile(path: string): TFile | null {
		const stored = this.files.get(path);
		if (stored === undefined || this.#isConfig(path)) {
			return null;
		}
		const file = new TFile();
		file.path = path;
		file.name = path.slice(path.lastIndexOf('/') + 1);
		file.stat = { mtime: stored.mtime, ctime: stored.ctime, size: stored.data.byteLength };
		return file;
	}

	#requireFolder(path: string): void {
		const parent = parentOf(path);
		if (parent !== '' && !this.folders.has(parent)) {
			throw new Error(`folder does not exist: ${parent}`);
		}
	}

	asApp(): App {
		const self = this;
		const adapter = {
			async exists(path: string) {
				return self.files.has(path) || self.folders.has(path);
			},
			async list(directory: string) {
				const files: string[] = [];
				const folders: string[] = [];
				for (const path of self.files.keys()) {
					if (parentOf(path) === directory) {
						files.push(path);
					}
				}
				for (const path of self.folders) {
					if (parentOf(path) === directory) {
						folders.push(path);
					}
				}
				return { files, folders };
			},
			async stat(path: string) {
				const stored = self.files.get(path);
				if (stored === undefined) {
					return self.folders.has(path)
						? { type: 'folder' as const, mtime: 0, ctime: 0, size: 0 }
						: null;
				}
				return {
					type: 'file' as const,
					mtime: stored.mtime,
					ctime: stored.ctime,
					size: stored.data.byteLength,
				};
			},
			async readBinary(path: string) {
				const stored = self.files.get(path);
				if (stored === undefined) {
					throw new Error(`no such file: ${path}`);
				}
				return toBuffer(stored.data);
			},
			async read(path: string) {
				const stored = self.files.get(path);
				if (stored === undefined) {
					throw new Error(`no such file: ${path}`);
				}
				return new TextDecoder().decode(stored.data);
			},
			async write(path: string, text: string) {
				self.#requireFolder(path);
				const existing = self.files.get(path);
				self.files.set(path, { data: encode(text), mtime: 2, ctime: existing?.ctime ?? 2 });
			},
			async writeBinary(path: string, data: ArrayBuffer) {
				self.#requireFolder(path);
				const existing = self.files.get(path);
				self.files.set(path, {
					data: new Uint8Array(data),
					mtime: 2,
					ctime: existing?.ctime ?? 2,
				});
			},
			async process(path: string, fn: (data: string) => string) {
				const stored = self.files.get(path);
				if (stored === undefined) {
					throw new Error(`no such file: ${path}`);
				}
				const next = fn(new TextDecoder().decode(stored.data));
				self.files.set(path, { data: encode(next), mtime: 2, ctime: stored.ctime });
				return next;
			},
			async mkdir(path: string) {
				let current = '';
				for (const segment of path.split('/').filter(Boolean)) {
					current = current === '' ? segment : `${current}/${segment}`;
					self.folders.add(current);
				}
			},
			async remove(path: string) {
				self.files.delete(path);
			},
			async trashLocal(path: string) {
				self.trashed.push(path);
				self.files.delete(path);
			},
		};

		const vault = {
			configDir: this.configDir,
			adapter,
			getFiles() {
				return [...self.files.keys()]
					.map((path) => self.#tfile(path))
					.filter((file): file is TFile => file !== null);
			},
			getAbstractFileByPath(path: string) {
				return self.#tfile(path);
			},
			getFileByPath(path: string) {
				return self.#tfile(path);
			},
			on() {
				return {};
			},
			offref() {},
			getFolderByPath(path: string) {
				return self.folders.has(path) ? { path } : null;
			},
			async createFolder(path: string) {
				self.folders.add(path);
				return { path };
			},
			async createBinary(path: string, data: ArrayBuffer) {
				self.#requireFolder(path);
				self.files.set(path, { data: new Uint8Array(data), mtime: 2, ctime: 2 });
			},
			async modifyBinary(file: TFile, data: ArrayBuffer) {
				const existing = self.files.get(file.path);
				self.files.set(file.path, {
					data: new Uint8Array(data),
					mtime: 2,
					ctime: existing?.ctime ?? 2,
				});
			},
			async readBinary(file: TFile) {
				return adapter.readBinary(file.path);
			},
			async process(file: TFile, fn: (data: string) => string) {
				return adapter.process(file.path, fn);
			},
		};

		return {
			vault,
			fileManager: {
				async trashFile(file: TFile) {
					self.trashed.push(file.path);
					self.files.delete(file.path);
				},
			},
			workspace: {
				getLeavesOfType() {
					return [];
				},
				onLayoutReady(fn: () => void) {
					fn();
				},
			},
			secretStorage: {
				getSecret(id: string) {
					return self.secrets.get(id) ?? null;
				},
				setSecret(id: string, value: string) {
					self.secrets.set(id, value);
				},
			},
			loadLocalStorage(key: string) {
				return self.local.get(key) ?? null;
			},
			saveLocalStorage(key: string, value: string) {
				self.local.set(key, value);
			},
		} as unknown as App;
	}
}

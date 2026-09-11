import type { StateStorage } from './storage.js';

/**
 * The locally-known sync state for one path (§6.1): the server head version this
 * device last reconciled with, the ordered chunk addresses of that version, and a
 * content hash used to decide, cheaply, whether the file is dirty.
 */
export interface IndexEntry {
	fileId: string;
	versionId: string;
	path: string;
	hash: string;
	mtime: number;
	chunks: string[];
}

export class FileIndex {
	readonly #storage: StateStorage;
	readonly #key = 'index.json';
	#entries = new Map<string, IndexEntry>();
	#loaded = false;

	constructor(storage: StateStorage) {
		this.#storage = storage;
	}

	async load(): Promise<void> {
		const raw = await this.#storage.read(this.#key);
		if (raw === undefined) {
			this.#entries = new Map();
		} else {
			const parsed = JSON.parse(raw) as { entries: IndexEntry[] };
			this.#entries = new Map(parsed.entries.map((entry) => [entry.path, entry]));
		}
		this.#loaded = true;
	}

	#assertLoaded(): void {
		if (!this.#loaded) {
			throw new Error('FileIndex used before load(); await load() first');
		}
	}

	get(path: string): IndexEntry | undefined {
		this.#assertLoaded();
		return this.#entries.get(path);
	}

	set(entry: IndexEntry): void {
		this.#assertLoaded();
		this.#entries.set(entry.path, entry);
	}

	delete(path: string): void {
		this.#assertLoaded();
		this.#entries.delete(path);
	}

	getByFileId(fileId: string): IndexEntry | undefined {
		this.#assertLoaded();
		for (const entry of this.#entries.values()) {
			if (entry.fileId === fileId) {
				return entry;
			}
		}
		return undefined;
	}

	forgetFileId(fileId: string): void {
		this.#assertLoaded();
		for (const [path, entry] of this.#entries) {
			if (entry.fileId === fileId) {
				this.#entries.delete(path);
			}
		}
	}

	entries(): IndexEntry[] {
		this.#assertLoaded();
		return [...this.#entries.values()];
	}

	async save(): Promise<void> {
		this.#assertLoaded();
		const payload = { entries: [...this.#entries.values()] };
		await this.#storage.write(this.#key, JSON.stringify(payload));
	}

	async clear(): Promise<void> {
		this.#entries = new Map();
		this.#loaded = true;
		await this.#storage.remove(this.#key);
	}
}

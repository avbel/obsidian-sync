import type { StateStorage } from './storage.js';

/**
 * The common-ancestor content per fileId, required for three-way merge (§6.4).
 *
 * Without an ancestor only last-write-wins is possible, which would silently drop
 * one side's edit. Stored as text keyed by fileId so the merge can look up the base
 * regardless of a rename (a rename is delete-old + create-new, and the old identity's
 * base simply ages out with the index).
 */
export class BaseCache {
	readonly #storage: StateStorage;
	readonly #key = 'base-cache.json';
	#bases = new Map<string, string>();
	#loaded = false;

	constructor(storage: StateStorage) {
		this.#storage = storage;
	}

	async load(): Promise<void> {
		const raw = await this.#storage.read(this.#key);
		this.#bases =
			raw === undefined
				? new Map()
				: new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
		this.#loaded = true;
	}

	#assertLoaded(): void {
		if (!this.#loaded) {
			throw new Error('BaseCache used before load(); await load() first');
		}
	}

	get(fileId: string): string | undefined {
		this.#assertLoaded();
		return this.#bases.get(fileId);
	}

	set(fileId: string, content: string): void {
		this.#assertLoaded();
		this.#bases.set(fileId, content);
	}

	delete(fileId: string): void {
		this.#assertLoaded();
		this.#bases.delete(fileId);
	}

	async save(): Promise<void> {
		this.#assertLoaded();
		await this.#storage.write(this.#key, JSON.stringify(Object.fromEntries(this.#bases)));
	}

	async clear(): Promise<void> {
		this.#bases = new Map();
		this.#loaded = true;
		await this.#storage.remove(this.#key);
	}
}

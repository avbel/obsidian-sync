import type { VaultAdapter, VaultFile } from '../engine/vault.js';
import type { StateStorage } from '../state/storage.js';

export class MemoryStorage implements StateStorage {
	readonly #map = new Map<string, string>();
	async read(key: string): Promise<string | undefined> {
		return this.#map.get(key);
	}
	async write(key: string, value: string): Promise<void> {
		this.#map.set(key, value);
	}
	async remove(key: string): Promise<void> {
		this.#map.delete(key);
	}
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export class MemoryVault implements VaultAdapter {
	readonly #files = new Map<string, { data: Uint8Array; mtime: number; ctime: number }>();

	putText(path: string, text: string): void {
		const now = Date.now();
		const existing = this.#files.get(path);
		this.#files.set(path, { data: encode(text), mtime: now, ctime: existing?.ctime ?? now });
	}

	getText(path: string): string | undefined {
		const file = this.#files.get(path);
		return file === undefined ? undefined : new TextDecoder().decode(file.data);
	}

	async list(): Promise<VaultFile[]> {
		return [...this.#files.entries()].map(([path, file]) => ({
			path,
			mtime: file.mtime,
			size: file.data.length,
			ctime: file.ctime,
		}));
	}

	async exists(path: string): Promise<boolean> {
		return this.#files.has(path);
	}

	async read(path: string): Promise<Uint8Array> {
		const file = this.#files.get(path);
		if (file === undefined) {
			throw new Error(`no such file: ${path}`);
		}
		return file.data;
	}

	async write(path: string, data: Uint8Array): Promise<void> {
		const now = Date.now();
		const existing = this.#files.get(path);
		this.#files.set(path, { data, mtime: now, ctime: existing?.ctime ?? now });
	}

	async remove(path: string): Promise<void> {
		this.#files.delete(path);
	}

	async trash(path: string): Promise<void> {
		this.#files.delete(path);
	}
}

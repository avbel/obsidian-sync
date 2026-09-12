import {
	StaleWriteError,
	type VaultAdapter,
	type VaultFile,
	type WriteOptions,
} from '../engine/vault.js';
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

function same(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export class MemoryVault implements VaultAdapter {
	readonly #files = new Map<string, { data: Uint8Array; mtime: number; ctime: number }>();
	#race: { path: string; text: string } | undefined;
	#blind = false;

	/** Stands in for Obsidian's file cache before it is populated: contents exist, but nothing is visible. */
	setBlind(blind: boolean): void {
		this.#blind = blind;
	}

	/** Rewrites `path` the next time it is read, standing in for a keystroke landing mid-apply. */
	raceOnce(path: string, text: string): void {
		this.#race = { path, text };
	}

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
		if (this.#blind) {
			return [];
		}
		return [...this.#files.entries()].map(([path, file]) => ({
			path,
			mtime: file.mtime,
			size: file.data.length,
			ctime: file.ctime,
		}));
	}

	/** Deliberately not gated on `#blind`: the real one reads through `vault.adapter`, which works before the file cache fills. */
	async listConfig(): Promise<VaultFile[]> {
		return [...this.#files.entries()]
			.filter(([path]) => path.startsWith('.obsidian/'))
			.map(([path, file]) => ({
				path,
				mtime: file.mtime,
				size: file.data.length,
				ctime: file.ctime,
			}));
	}

	async exists(path: string): Promise<boolean> {
		return this.#blind ? false : this.#files.has(path);
	}

	async stat(path: string): Promise<VaultFile | undefined> {
		const file = this.#files.get(path);
		if (this.#blind || file === undefined) {
			return undefined;
		}
		return { path, mtime: file.mtime, size: file.data.length, ctime: file.ctime };
	}

	async read(path: string): Promise<Uint8Array> {
		const file = this.#files.get(path);
		if (file === undefined) {
			throw new Error(`no such file: ${path}`);
		}
		if (this.#race?.path === path) {
			const { text } = this.#race;
			this.#race = undefined;
			this.putText(path, text);
		}
		return file.data;
	}

	async write(path: string, data: Uint8Array, options?: WriteOptions): Promise<void> {
		const now = Date.now();
		const existing = this.#files.get(path);
		const expected = options?.expected;
		if (expected !== undefined && (existing === undefined || !same(existing.data, expected))) {
			throw new StaleWriteError(path);
		}
		this.#files.set(path, { data, mtime: now, ctime: existing?.ctime ?? now });
	}

	async remove(path: string): Promise<void> {
		this.#files.delete(path);
	}

	async trash(path: string): Promise<void> {
		this.#files.delete(path);
	}
}

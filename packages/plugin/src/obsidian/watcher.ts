import { type EventRef, TFile, type Vault } from 'obsidian';

export interface DirtyBatch {
	changed: string[];
	deleted: string[];
}

/**
 * Collects vault create/modify/delete/rename events into a per-path dirty set and
 * flushes it after the debounce window (§7.1 step 2). Repeated edits to the same
 * path collapse to one entry, so a burst of keystrokes costs one sync.
 */
export class DebouncedWatcher {
	readonly #vault: Vault;
	readonly #debounceMs: number;
	readonly #onFlush: (batch: DirtyBatch) => void;
	readonly #changed = new Set<string>();
	readonly #deleted = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#refs: EventRef[] = [];

	constructor(vault: Vault, debounceMs: number, onFlush: (batch: DirtyBatch) => void) {
		this.#vault = vault;
		this.#debounceMs = debounceMs;
		this.#onFlush = onFlush;
	}

	start(): void {
		const touch = (path: string): void => {
			this.#changed.add(path);
			this.#schedule();
		};
		const drop = (path: string): void => {
			this.#deleted.add(path);
			this.#changed.delete(path);
			this.#schedule();
		};

		this.#refs.push(
			this.#vault.on('create', (file) => {
				if (file instanceof TFile) {
					touch(file.path);
				}
			}),
			this.#vault.on('modify', (file) => {
				if (file instanceof TFile) {
					touch(file.path);
				}
			}),
			this.#vault.on('delete', (file) => {
				if (file instanceof TFile) {
					drop(file.path);
				}
			}),
			this.#vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) {
					touch(file.path);
					drop(oldPath);
				}
			}),
		);
	}

	stop(): void {
		for (const ref of this.#refs) {
			this.#vault.offref(ref);
		}
		this.#refs = [];
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
		}
	}

	#schedule(): void {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
		}
		this.#timer = setTimeout(() => {
			const batch: DirtyBatch = { changed: [...this.#changed], deleted: [...this.#deleted] };
			this.#changed.clear();
			this.#deleted.clear();
			this.#onFlush(batch);
		}, this.#debounceMs);
	}
}

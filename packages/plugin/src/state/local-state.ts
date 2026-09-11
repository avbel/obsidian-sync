/** get/set narrowed to Obsidian's per-vault localStorage, injected for testability. */
export interface LocalStateStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}

const deviceKey = 'obsidian-sync/deviceId';
const cursorKey = 'obsidian-sync/cursor';

/** Device identity and the durable last-seen sequence, kept outside data.json (§6.4). */
export class LocalState {
	readonly #store: LocalStateStore;

	constructor(store: LocalStateStore) {
		this.#store = store;
	}

	getDeviceId(): string | undefined {
		return this.#store.get(deviceKey) ?? undefined;
	}

	ensureDeviceId(factory: () => string): string {
		const existing = this.getDeviceId();
		if (existing !== undefined) {
			return existing;
		}
		const created = factory();
		this.#store.set(deviceKey, created);
		return created;
	}

	getCursor(): number {
		const raw = this.#store.get(cursorKey);
		if (raw === null) {
			return 0;
		}
		const parsed = Number(raw);
		return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
	}

	/**
	 * Persist the cursor after a batch applies, never before (§7.2 step 6): a crash
	 * then replays the batch rather than skipping it.
	 */
	setCursor(seq: number): void {
		this.#store.set(cursorKey, String(seq));
	}
}

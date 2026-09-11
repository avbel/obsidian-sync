import type { ConflictRecord } from '../engine/sync.js';
import type { LocalStateStore } from './local-state.js';

const conflictsKey = 'obsidian-sync/conflicts';

function isRecord(value: unknown): value is ConflictRecord {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<ConflictRecord>;
	return typeof candidate.path === 'string' && typeof candidate.conflictCopyPath === 'string';
}

/**
 * Unresolved conflicts, per device, outside data.json (§6.4).
 *
 * Durable because the conflict copies themselves are durable: losing the list on
 * restart leaves copies sitting in the vault that nothing will ever offer to resolve.
 * Keyed by path — a second conflict on one note supersedes the first, since the newer
 * copy is the one holding the bytes the user has not seen yet.
 */
export class ConflictList {
	readonly #store: LocalStateStore;

	constructor(store: LocalStateStore) {
		this.#store = store;
	}

	all(): ConflictRecord[] {
		const raw = this.#store.get(conflictsKey);
		if (raw === null) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
		} catch {
			return [];
		}
	}

	add(record: ConflictRecord): void {
		this.#write([...this.all().filter((entry) => entry.path !== record.path), record]);
	}

	remove(path: string): void {
		this.#write(this.all().filter((entry) => entry.path !== path));
	}

	/** Drops records whose copy the user deleted or renamed behind the plugin's back. */
	async prune(exists: (path: string) => Promise<boolean>): Promise<void> {
		const kept: ConflictRecord[] = [];
		for (const entry of this.all()) {
			if (await exists(entry.conflictCopyPath)) {
				kept.push(entry);
			}
		}
		this.#write(kept);
	}

	#write(records: ConflictRecord[]): void {
		this.#store.set(conflictsKey, JSON.stringify(records));
	}
}

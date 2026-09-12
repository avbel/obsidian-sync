import type { StateStorage } from './storage.js';

export type PendingIntent = 'upsert' | 'delete';
export type BlockReason = 'oversize';

export interface PendingItem {
	path: string;
	intent: PendingIntent;
	attempts: number;
	nextAttemptAt: number;
	blocked?: BlockReason | undefined;
	lastError?: string | undefined;
}

export interface DirtyPaths {
	changed: string[];
	deleted: string[];
}

export interface QueueDepth {
	upserts: number;
	deletes: number;
	blocked: number;
}

const queueKey = 'queue.json';

function isIntent(value: unknown): value is PendingIntent {
	return value === 'upsert' || value === 'delete';
}

function isItem(value: unknown): value is PendingItem {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<PendingItem>;
	return (
		typeof candidate.path === 'string' &&
		isIntent(candidate.intent) &&
		typeof candidate.attempts === 'number' &&
		typeof candidate.nextAttemptAt === 'number'
	);
}

/** Durable, latest-intent-per-path push queue stored outside the synced vault. */
export class PendingQueue {
	readonly #storage: StateStorage;
	#items = new Map<string, PendingItem>();
	#pausedUntil = 0;
	#loaded = false;

	constructor(storage: StateStorage) {
		this.#storage = storage;
	}

	async load(): Promise<void> {
		const raw = await this.#storage.read(queueKey);
		this.#items = new Map();
		this.#pausedUntil = 0;
		if (raw !== undefined) {
			try {
				const shape = JSON.parse(raw) as { items?: unknown; pausedUntil?: unknown };
				const items = Array.isArray(shape.items) ? shape.items.filter(isItem) : [];
				this.#items = new Map(items.map((item) => [item.path, item]));
				this.#pausedUntil = typeof shape.pausedUntil === 'number' ? shape.pausedUntil : 0;
			} catch {
				this.#items = new Map();
			}
		}
		this.#loaded = true;
	}

	#assertLoaded(): void {
		if (!this.#loaded) {
			throw new Error('PendingQueue used before load(); await load() first');
		}
	}

	enqueue(path: string, intent: PendingIntent): void {
		this.#assertLoaded();
		this.#items.set(path, { path, intent, attempts: 0, nextAttemptAt: 0 });
	}

	/**
	 * Queue a path a scan found rather than one the user just edited. An entry already
	 * waiting out its backoff keeps it: a scan runs on every sync, so resetting the
	 * clock here would let a permanently failing file retry at full speed forever. A
	 * blocked entry is re-queued, so shrinking an oversize file lets it through again.
	 */
	enqueueScanned(path: string, intent: PendingIntent): void {
		this.#assertLoaded();
		const existing = this.#items.get(path);
		if (existing !== undefined && existing.intent === intent && existing.blocked === undefined) {
			return;
		}
		this.enqueue(path, intent);
	}

	enqueueBatch(batch: DirtyPaths): void {
		for (const path of batch.deleted) {
			this.enqueue(path, 'delete');
		}
		for (const path of batch.changed) {
			this.enqueue(path, 'upsert');
		}
	}

	ready(now: number, intent: PendingIntent): PendingItem[] {
		this.#assertLoaded();
		if (now < this.#pausedUntil) {
			return [];
		}
		return [...this.#items.values()].filter(
			(item) => item.intent === intent && item.blocked === undefined && item.nextAttemptAt <= now,
		);
	}

	succeed(path: string): void {
		this.#assertLoaded();
		this.#items.delete(path);
	}

	fail(path: string, delayMs: number, now: number, message: string): void {
		this.#assertLoaded();
		const item = this.#items.get(path);
		if (item === undefined) {
			return;
		}
		this.#items.set(path, {
			...item,
			attempts: item.attempts + 1,
			nextAttemptAt: now + delayMs,
			lastError: message,
			blocked: undefined,
		});
	}

	block(path: string, reason: BlockReason): void {
		this.#assertLoaded();
		const item = this.#items.get(path);
		if (item !== undefined) {
			this.#items.set(path, { ...item, blocked: reason });
		}
	}

	forget(path: string): void {
		this.#assertLoaded();
		this.#items.delete(path);
	}

	pause(until: number): void {
		this.#assertLoaded();
		this.#pausedUntil = Math.max(this.#pausedUntil, until);
	}

	resume(): void {
		this.#assertLoaded();
		this.#pausedUntil = 0;
	}

	pausedUntil(): number {
		this.#assertLoaded();
		return this.#pausedUntil;
	}

	readyAt(): number | undefined {
		this.#assertLoaded();
		let earliest: number | undefined;
		for (const item of this.#items.values()) {
			if (item.blocked !== undefined) {
				continue;
			}
			const at = Math.max(item.nextAttemptAt, this.#pausedUntil);
			if (earliest === undefined || at < earliest) {
				earliest = at;
			}
		}
		return earliest;
	}

	depth(): QueueDepth {
		this.#assertLoaded();
		const items = [...this.#items.values()];
		const live = items.filter((item) => item.blocked === undefined);
		return {
			upserts: live.filter((item) => item.intent === 'upsert').length,
			deletes: live.filter((item) => item.intent === 'delete').length,
			blocked: items.length - live.length,
		};
	}

	blockedItems(): PendingItem[] {
		this.#assertLoaded();
		return [...this.#items.values()].filter((item) => item.blocked !== undefined);
	}

	all(): PendingItem[] {
		this.#assertLoaded();
		return [...this.#items.values()];
	}

	async save(): Promise<void> {
		this.#assertLoaded();
		await this.#storage.write(
			queueKey,
			JSON.stringify({ items: [...this.#items.values()], pausedUntil: this.#pausedUntil }),
		);
	}

	async clear(): Promise<void> {
		this.#items = new Map();
		this.#pausedUntil = 0;
		this.#loaded = true;
		await this.#storage.remove(queueKey);
	}
}

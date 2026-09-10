import type { DatabaseSync } from 'node:sqlite';
import type { ChangeEntry, ChangeKind } from '@obsidian-sync/protocol';

interface ChangeRow {
	seq: number;
	file_id: string;
	version_id: string | null;
	kind: string;
	size: number;
	created_at: number;
}

export interface AppendChangeInput {
	vaultId: string;
	fileId: string;
	versionId: string | undefined;
	kind: ChangeKind;
	size: number;
}

/**
 * Synchronous by design: callers invoke this inside their own transaction so a
 * change row and the version row it describes commit together or not at all.
 */
export function appendChange(db: DatabaseSync, entry: AppendChangeInput): number {
	const result = db
		.prepare(
			'INSERT INTO change_log (vault_id, file_id, version_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
		)
		.run(entry.vaultId, entry.fileId, entry.versionId ?? null, entry.kind, entry.size, Date.now());

	return Number(result.lastInsertRowid);
}

export function readChangesSince(
	db: DatabaseSync,
	vaultId: string,
	since: number,
	limit: number,
): { changes: ChangeEntry[]; hasMore: boolean } {
	// One extra row tells us whether another page exists without a COUNT query.
	const rows = db
		.prepare(
			'SELECT seq, file_id, version_id, kind, size, created_at FROM change_log WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?',
		)
		.all(vaultId, since, limit + 1) as unknown as ChangeRow[];

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;

	return {
		hasMore,
		changes: page.map((row) => ({
			seq: row.seq,
			fileId: row.file_id,
			kind: row.kind as ChangeKind,
			versionId: row.version_id ?? undefined,
			size: row.size,
			createdAt: row.created_at,
		})),
	};
}

export function latestSeq(db: DatabaseSync, vaultId: string): number {
	const row = db
		.prepare('SELECT MAX(seq) AS seq FROM change_log WHERE vault_id = ?')
		.get(vaultId) as { seq: number | null } | undefined;

	return row?.seq ?? 0;
}

export class ChangeNotifier {
	readonly #waiters = new Map<string, Set<() => void>>();

	notify(vaultId: string): void {
		const waiting = this.#waiters.get(vaultId);
		if (waiting === undefined) {
			return;
		}

		// Copy before iterating: each resolver removes itself from the live set.
		for (const resolve of [...waiting]) {
			resolve();
		}
	}

	async waitForChange(vaultId: string, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const waiting = this.#waiters.get(vaultId) ?? new Set<() => void>();
			this.#waiters.set(vaultId, waiting);

			const settle = (): void => {
				clearTimeout(timer);
				waiting.delete(settle);
				if (waiting.size === 0) {
					this.#waiters.delete(vaultId);
				}
				resolve();
			};

			const timer = setTimeout(settle, timeoutMs);
			// Never hold the event loop open on an idle long-poll during shutdown.
			timer.unref();
			waiting.add(settle);
		});
	}

	waiterCount(vaultId: string): number {
		return this.#waiters.get(vaultId)?.size ?? 0;
	}
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { appendChange, ChangeNotifier, latestSeq, readChangesSince } from './changes.js';
import { closeDatabase, openDatabase } from './db/database.js';

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-changes-'));
	db = openDatabase(join(directory, 'sync.db'));
	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run('v1', 'personal', 'alice', Buffer.alloc(16), Date.now());
	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run('v2', 'work', 'alice', Buffer.alloc(16), Date.now());
});

afterEach(async () => {
	closeDatabase(db);
	await rm(directory, { recursive: true, force: true });
});

describe('appendChange', () => {
	test('returns an increasing sequence number', () => {
		const first = appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: undefined,
			kind: 'upsert',
			size: 10,
		});
		const second = appendChange(db, {
			vaultId: 'v1',
			fileId: 'f2',
			versionId: undefined,
			kind: 'upsert',
			size: 20,
		});
		expect(second).toBeGreaterThan(first);
	});
});

describe('readChangesSince', () => {
	test('returns nothing for an empty vault', () => {
		expect(readChangesSince(db, 'v1', 0, 10).changes).toEqual([]);
	});

	test('returns changes after the cursor only', () => {
		const first = appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: 'ver-1',
			kind: 'upsert',
			size: 10,
		});
		appendChange(db, {
			vaultId: 'v1',
			fileId: 'f2',
			versionId: 'ver-2',
			kind: 'upsert',
			size: 20,
		});

		const result = readChangesSince(db, 'v1', first, 10);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.fileId).toBe('f2');
	});

	test('maps a SQL NULL version to undefined', () => {
		appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: undefined,
			kind: 'delete',
			size: 0,
		});
		expect(readChangesSince(db, 'v1', 0, 10).changes[0]?.versionId).toBeUndefined();
	});

	test('does not leak changes across vaults', () => {
		appendChange(db, {
			vaultId: 'v2',
			fileId: 'other',
			versionId: undefined,
			kind: 'upsert',
			size: 1,
		});
		expect(readChangesSince(db, 'v1', 0, 10).changes).toEqual([]);
	});

	test('flags more results when the limit is reached', () => {
		for (let index = 0; index < 5; index += 1) {
			appendChange(db, {
				vaultId: 'v1',
				fileId: `f${index}`,
				versionId: undefined,
				kind: 'upsert',
				size: 1,
			});
		}
		const result = readChangesSince(db, 'v1', 0, 2);
		expect(result.changes).toHaveLength(2);
		expect(result.hasMore).toBe(true);
	});

	test('does not flag more results on the final page', () => {
		appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: undefined,
			kind: 'upsert',
			size: 1,
		});
		expect(readChangesSince(db, 'v1', 0, 10).hasMore).toBe(false);
	});
});

describe('latestSeq', () => {
	test('is zero for a vault with no changes', () => {
		expect(latestSeq(db, 'v1')).toBe(0);
	});

	test('tracks the newest change', () => {
		const seq = appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: undefined,
			kind: 'upsert',
			size: 1,
		});
		expect(latestSeq(db, 'v1')).toBe(seq);
	});
});

describe('ChangeNotifier', () => {
	test('resolves a waiter when its vault is notified', async () => {
		const notifier = new ChangeNotifier();
		const waiting = notifier.waitForChange('v1', 5000);
		notifier.notify('v1');
		await expect(waiting).resolves.toBeUndefined();
	});

	test('resolves on timeout when nothing happens', async () => {
		const notifier = new ChangeNotifier();
		await expect(notifier.waitForChange('v1', 20)).resolves.toBeUndefined();
	});

	test('does not wake a waiter on a different vault', async () => {
		const notifier = new ChangeNotifier();
		let woken = false;
		const wait = async (): Promise<void> => {
			await notifier.waitForChange('v1', 60);
			woken = true;
		};
		const waiting = wait();
		notifier.notify('v2');
		expect(notifier.waiterCount('v1')).toBe(1);
		expect(woken).toBe(false);
		await waiting;
	});

	test('wakes every waiter on the same vault', async () => {
		const notifier = new ChangeNotifier();
		const waiters = [
			notifier.waitForChange('v1', 5000),
			notifier.waitForChange('v1', 5000),
			notifier.waitForChange('v1', 5000),
		];
		expect(notifier.waiterCount('v1')).toBe(3);
		notifier.notify('v1');
		await expect(Promise.all(waiters)).resolves.toHaveLength(3);
	});

	// A leak here would grow without bound on a long-lived server.
	test('releases waiters after they settle', async () => {
		const notifier = new ChangeNotifier();
		await notifier.waitForChange('v1', 10);
		expect(notifier.waiterCount('v1')).toBe(0);

		const waiting = notifier.waitForChange('v1', 5000);
		notifier.notify('v1');
		await waiting;
		expect(notifier.waiterCount('v1')).toBe(0);
	});
});

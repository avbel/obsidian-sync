import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, currentSchemaVersion, openDatabase } from './database.js';

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-db-'));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('openDatabase', () => {
	test('creates the file and stamps the schema version', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
		expect(row.user_version).toBe(currentSchemaVersion);
		closeDatabase(db);
	});

	test('enables write-ahead logging', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
		expect(row.journal_mode).toBe('wal');
		closeDatabase(db);
	});

	test('enforces foreign keys', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
		expect(row.foreign_keys).toBe(1);
		closeDatabase(db);
	});

	test('creates every expected table', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		const names = (
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((row) => row.name);
		for (const expected of ['vault', 'device', 'file', 'version', 'change_log', 'blob_ref']) {
			expect(names).toContain(expected);
		}
		closeDatabase(db);
	});

	test('is idempotent when reopening an existing database', () => {
		const path = join(directory, 'sync.db');
		closeDatabase(openDatabase(path));
		const db = openDatabase(path);
		const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
		expect(row.user_version).toBe(currentSchemaVersion);
		closeDatabase(db);
	});

	test('assigns change_log sequence numbers monotonically', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		db.prepare(
			'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
		).run('v1', 'personal', 'alice', Buffer.alloc(16), 0);

		const insert = db.prepare(
			'INSERT INTO change_log (vault_id, file_id, version_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
		);
		const first = insert.run('v1', 'f1', null, 'upsert', 0, 0).lastInsertRowid;
		const second = insert.run('v1', 'f2', null, 'upsert', 0, 0).lastInsertRowid;
		expect(Number(second)).toBeGreaterThan(Number(first));
		closeDatabase(db);
	});

	test('rejects a change_log row for an unknown vault', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		expect(() =>
			db
				.prepare(
					'INSERT INTO change_log (vault_id, file_id, version_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
				)
				.run('ghost', 'f1', null, 'upsert', 0, 0),
		).toThrow();
		closeDatabase(db);
	});
});

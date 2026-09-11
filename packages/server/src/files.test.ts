import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readChangesSince } from './changes.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { commitVersion, deleteFile, listVersions, readVaultState } from './files.js';

const fileId = 'f'.repeat(64);
const otherFileId = 'e'.repeat(64);
const chunkOne = '1'.repeat(64);
const chunkTwo = '2'.repeat(64);

let directory: string;
let db: DatabaseSync;

function knownChunk(address: string): void {
	db.prepare('INSERT INTO blob_ref (vault_id, addr, bytes, refcount) VALUES (?, ?, ?, 0)').run(
		'v1',
		address,
		100,
	);
}

function commit(parentVersion: string | undefined, chunks: string[] = [chunkOne]) {
	return commitVersion(db, {
		vaultId: 'v1',
		fileId,
		parentVersion,
		metaBlob: 'bWV0YQ==',
		chunks,
		size: 100,
		deviceId: 'device-1',
	});
}

function refcountOf(address: string): number {
	const row = db
		.prepare('SELECT refcount FROM blob_ref WHERE vault_id = ? AND addr = ?')
		.get('v1', address) as { refcount: number } | undefined;
	return row?.refcount ?? -1;
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-files-'));
	db = openDatabase(join(directory, 'sync.db'));
	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run('v1', 'personal', 'alice', Buffer.alloc(16), Date.now());
	knownChunk(chunkOne);
	knownChunk(chunkTwo);
});

afterEach(async () => {
	closeDatabase(db);
	await rm(directory, { recursive: true, force: true });
});

describe('commitVersion', () => {
	test('creates a file when no parent is supplied', () => {
		const outcome = commit(undefined);
		expect(outcome.status).toBe('committed');
	});

	test('appends a change row for the commit', () => {
		commit(undefined);
		const { changes } = readChangesSince(db, 'v1', 0, 10);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ fileId, kind: 'upsert', size: 100 });
	});

	test('increments the refcount of each referenced chunk', () => {
		commit(undefined, [chunkOne, chunkTwo]);
		expect(refcountOf(chunkOne)).toBe(1);
		expect(refcountOf(chunkTwo)).toBe(1);
	});

	test('counts a repeated chunk once per version', () => {
		commit(undefined, [chunkOne, chunkOne]);
		expect(refcountOf(chunkOne)).toBe(1);
	});

	test('accepts a commit whose parent is the current head', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		expect(commit(first.versionId).status).toBe('committed');
	});

	test('rejects a commit whose parent is stale, reporting the real head', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		commit(first.versionId);

		const outcome = commit(first.versionId);
		expect(outcome).toEqual({ status: 'conflict', headVersion: expect.any(String) });
		if (outcome.status === 'conflict') {
			expect(outcome.headVersion).not.toBe(first.versionId);
		}
	});

	test('rejects a create when the file already exists', () => {
		commit(undefined);
		expect(commit(undefined).status).toBe('conflict');
	});

	test('writes nothing when a commit conflicts', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		const before = refcountOf(chunkOne);
		commit(undefined);
		expect(refcountOf(chunkOne)).toBe(before);
		expect(readChangesSince(db, 'v1', 0, 10).changes).toHaveLength(1);
	});

	test('reports unknown chunks instead of committing', () => {
		const outcome = commit(undefined, [chunkOne, '9'.repeat(64)]);
		expect(outcome).toEqual({ status: 'missingChunks', missing: ['9'.repeat(64)] });
		expect(readChangesSince(db, 'v1', 0, 10).changes).toHaveLength(0);
	});

	test('accepts a zero-byte file with no chunks', () => {
		const outcome = commitVersion(db, {
			vaultId: 'v1',
			fileId: otherFileId,
			parentVersion: undefined,
			metaBlob: 'bWV0YQ==',
			chunks: [],
			size: 0,
			deviceId: 'device-1',
		});
		expect(outcome.status).toBe('committed');
	});
});

describe('deleteFile', () => {
	test('tombstones a file and appends a delete change', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}

		const outcome = deleteFile(db, { vaultId: 'v1', fileId, parentVersion: first.versionId });
		expect(outcome.status).toBe('committed');

		const { changes } = readChangesSince(db, 'v1', first.seq, 10);
		expect(changes[0]).toMatchObject({ kind: 'delete', versionId: undefined });
	});

	test('rejects a delete with a stale parent', () => {
		commit(undefined);
		expect(
			deleteFile(db, {
				vaultId: 'v1',
				fileId,
				parentVersion: '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
			}).status,
		).toBe('conflict');
	});

	test('rejects a delete for a file that never existed', () => {
		expect(deleteFile(db, { vaultId: 'v1', fileId, parentVersion: undefined }).status).toBe(
			'conflict',
		);
	});

	test('allows recreating a deleted file with no parent', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		deleteFile(db, { vaultId: 'v1', fileId, parentVersion: first.versionId });
		expect(commit(undefined).status).toBe('committed');
	});
});

describe('readVaultState', () => {
	test('is empty for a new vault', () => {
		expect(readVaultState(db, 'v1')).toEqual([]);
	});

	test('lists a live file with its head metadata', () => {
		commit(undefined);
		const state = readVaultState(db, 'v1');
		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({ fileId, metaBlob: 'bWV0YQ==', size: 100 });
	});

	test('omits a deleted file', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		deleteFile(db, { vaultId: 'v1', fileId, parentVersion: first.versionId });
		expect(readVaultState(db, 'v1')).toEqual([]);
	});
});

describe('listVersions', () => {
	test('returns newest first with the committed meta blob', () => {
		const first = commit(undefined);
		const second = commit(first.status === 'committed' ? first.versionId : undefined);

		const page = listVersions(db, 'v1', fileId, { limit: 50, offset: 0 });

		expect(page.versions).toHaveLength(2);
		expect(page.versions[0]?.versionId).toBe(
			second.status === 'committed' ? second.versionId : 'unreachable',
		);
		expect(page.versions[0]?.metaBlob).toBe('bWV0YQ==');
		expect(page.versions[1]?.parentVersion).toBeUndefined();
		expect(page.hasMore).toBe(false);
	});

	test('orders versions committed in the same millisecond by insertion, newest first', () => {
		// created_at has millisecond resolution, so a scripted restore or a fast
		// rebuild can land two versions on the same tick. rowid is the tiebreak;
		// without it history renders in an order the user did not edit in.
		let parent: string | undefined;
		const committed: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const outcome = commit(parent);
			if (outcome.status !== 'committed') {
				throw new Error('setup commit rejected');
			}
			parent = outcome.versionId;
			committed.push(outcome.versionId);
		}

		const page = listVersions(db, 'v1', fileId, { limit: 50, offset: 0 });

		expect(page.versions.map((version) => version.versionId)).toEqual([...committed].reverse());
	});

	test('pages, and reports that more remain', () => {
		let parent: string | undefined;
		for (let index = 0; index < 5; index += 1) {
			const outcome = commit(parent);
			parent = outcome.status === 'committed' ? outcome.versionId : undefined;
		}

		const first = listVersions(db, 'v1', fileId, { limit: 2, offset: 0 });
		const second = listVersions(db, 'v1', fileId, { limit: 2, offset: 2 });
		const last = listVersions(db, 'v1', fileId, { limit: 2, offset: 4 });

		expect(first.versions).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		expect(second.versions).toHaveLength(2);
		expect(second.hasMore).toBe(true);
		expect(last.versions).toHaveLength(1);
		expect(last.hasMore).toBe(false);
	});

	test('keeps the versions of a deleted file', () => {
		const created = commit(undefined);
		deleteFile(db, {
			vaultId: 'v1',
			fileId,
			parentVersion: created.status === 'committed' ? created.versionId : undefined,
		});

		expect(listVersions(db, 'v1', fileId, { limit: 50, offset: 0 }).versions).toHaveLength(1);
	});

	test('never crosses a vault boundary', () => {
		commit(undefined);

		expect(listVersions(db, 'v2', fileId, { limit: 50, offset: 0 }).versions).toHaveLength(0);
	});
});

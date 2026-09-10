import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type BlobStore, createBlobStore } from './blobs.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { commitVersion } from './files.js';
import { pruneVersions, sweepOrphanBlobs } from './retention.js';

const fileId = 'f'.repeat(64);
const dayMs = 24 * 60 * 60 * 1000;

let directory: string;
let db: DatabaseSync;
let blobs: BlobStore;

function chunkAddress(index: number): string {
	return index.toString(16).padStart(64, '0');
}

async function knownChunk(address: string): Promise<void> {
	await blobs.put('v1', address, new Uint8Array([1]));
	db.prepare('INSERT INTO blob_ref (vault_id, addr, bytes, refcount) VALUES (?, ?, 1, 0)').run(
		'v1',
		address,
	);
}

function ageVersion(versionId: string, days: number): void {
	db.prepare('UPDATE version SET created_at = ? WHERE version_id = ?').run(
		Date.now() - days * dayMs,
		versionId,
	);
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-retention-'));
	db = openDatabase(join(directory, 'sync.db'));
	blobs = createBlobStore(join(directory, 'blobs'));
	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run('v1', 'personal', 'alice', Buffer.alloc(16), Date.now());
});

afterEach(async () => {
	closeDatabase(db);
	await rm(directory, { recursive: true, force: true });
});

async function buildChain(length: number): Promise<string[]> {
	const versionIds: string[] = [];
	let parent: string | undefined;

	for (let index = 0; index < length; index += 1) {
		const address = chunkAddress(index);
		await knownChunk(address);
		const outcome = commitVersion(db, {
			vaultId: 'v1',
			fileId,
			parentVersion: parent,
			metaBlob: 'bWV0YQ==',
			chunks: [address],
			size: 1,
			deviceId: 'device-1',
		});
		if (outcome.status !== 'committed') {
			throw new Error(`commit ${index} failed with ${outcome.status}`);
		}
		versionIds.push(outcome.versionId);
		parent = outcome.versionId;
	}
	return versionIds;
}

describe('pruneVersions', () => {
	test('keeps everything when nothing is old enough', async () => {
		await buildChain(5);
		expect(pruneVersions(db, 'v1', { retentionDays: 90, retentionMin: 2 })).toBe(0);
	});

	test('removes versions older than the retention window', async () => {
		const versions = await buildChain(5);
		for (const versionId of versions.slice(0, 3)) {
			ageVersion(versionId, 200);
		}
		expect(pruneVersions(db, 'v1', { retentionDays: 90, retentionMin: 1 })).toBe(3);
	});

	test('always keeps the configured minimum, however old they are', async () => {
		const versions = await buildChain(5);
		for (const versionId of versions) {
			ageVersion(versionId, 200);
		}
		pruneVersions(db, 'v1', { retentionDays: 90, retentionMin: 3 });
		const remaining = db
			.prepare('SELECT COUNT(*) AS total FROM version WHERE vault_id = ?')
			.get('v1') as { total: number };
		expect(remaining.total).toBe(3);
	});

	test('never removes the head version', async () => {
		const versions = await buildChain(3);
		for (const versionId of versions) {
			ageVersion(versionId, 500);
		}
		pruneVersions(db, 'v1', { retentionDays: 1, retentionMin: 1 });

		const head = db
			.prepare('SELECT head_version FROM file WHERE vault_id = ? AND file_id = ?')
			.get('v1', fileId) as { head_version: string };
		const survivor = db
			.prepare('SELECT version_id FROM version WHERE vault_id = ? AND file_id = ?')
			.all('v1', fileId) as { version_id: string }[];

		expect(survivor.map((row) => row.version_id)).toContain(head.head_version);
	});

	test('releases the chunk references of pruned versions', async () => {
		const versions = await buildChain(3);
		ageVersion(versions[0] as string, 200);
		pruneVersions(db, 'v1', { retentionDays: 90, retentionMin: 1 });

		const released = db
			.prepare('SELECT refcount FROM blob_ref WHERE vault_id = ? AND addr = ?')
			.get('v1', chunkAddress(0)) as { refcount: number };
		expect(released.refcount).toBe(0);
	});
});

describe('sweepOrphanBlobs', () => {
	test('leaves referenced blobs alone', async () => {
		await buildChain(1);
		expect(await sweepOrphanBlobs(db, blobs, 'v1', 0)).toBe(0);
		await expect(blobs.has('v1', chunkAddress(0))).resolves.toBe(true);
	});

	test('reclaims an unreferenced blob past the grace period', async () => {
		await knownChunk(chunkAddress(9));
		expect(await sweepOrphanBlobs(db, blobs, 'v1', 0)).toBe(1);
		await expect(blobs.has('v1', chunkAddress(9))).resolves.toBe(false);
	});

	test('removes the blob_ref row alongside the blob', async () => {
		await knownChunk(chunkAddress(9));
		await sweepOrphanBlobs(db, blobs, 'v1', 0);
		expect(
			db
				.prepare('SELECT 1 FROM blob_ref WHERE vault_id = ? AND addr = ?')
				.get('v1', chunkAddress(9)),
		).toBeUndefined();
	});

	// An upload sits at refcount 0 until its commit lands; reclaiming it mid-flight
	// would corrupt the version being written.
	test('spares a freshly uploaded blob still inside the grace period', async () => {
		await knownChunk(chunkAddress(9));
		expect(await sweepOrphanBlobs(db, blobs, 'v1', 60_000)).toBe(0);
		await expect(blobs.has('v1', chunkAddress(9))).resolves.toBe(true);
	});
});

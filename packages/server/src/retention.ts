import type { DatabaseSync } from 'node:sqlite';
import type { BlobStore } from './blobs.js';
import type { SerialWriter } from './db/writer.js';

const dayMs = 24 * 60 * 60 * 1000;

export function pruneVersions(
	db: DatabaseSync,
	vaultId: string,
	options: { retentionDays: number; retentionMin: number },
): number {
	const cutoff = Date.now() - options.retentionDays * dayMs;

	db.exec('BEGIN IMMEDIATE');
	try {
		// Rank newest-first per file, then drop only rows that are both beyond the
		// keep-count and older than the cutoff, and never the current head.
		const candidates = db
			.prepare(
				`SELECT v.file_id, v.version_id, v.chunks
				 FROM (
				   SELECT file_id, version_id, chunks, created_at,
				          ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, rowid DESC) AS rank
				   FROM version WHERE vault_id = ?
				 ) v
				 LEFT JOIN file f ON f.vault_id = ? AND f.file_id = v.file_id
				 WHERE v.rank > ? AND v.created_at < ?
				   AND (f.head_version IS NULL OR f.head_version <> v.version_id)`,
			)
			.all(vaultId, vaultId, options.retentionMin, cutoff) as {
			file_id: string;
			version_id: string;
			chunks: string;
		}[];

		const removeVersion = db.prepare(
			'DELETE FROM version WHERE vault_id = ? AND file_id = ? AND version_id = ?',
		);
		const release = db.prepare(
			'UPDATE blob_ref SET refcount = MAX(refcount - 1, 0) WHERE vault_id = ? AND addr = ?',
		);

		for (const candidate of candidates) {
			removeVersion.run(vaultId, candidate.file_id, candidate.version_id);
			for (const address of new Set(JSON.parse(candidate.chunks) as string[])) {
				release.run(vaultId, address);
			}
		}

		db.exec('COMMIT');
		return candidates.length;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export interface SweepOptions {
	db: DatabaseSync;
	writer: SerialWriter;
	blobs: BlobStore;
	vaultId: string;
	graceMs: number;
}

export async function sweepOrphanBlobs(options: SweepOptions): Promise<number> {
	const { db, writer, blobs, vaultId, graceMs } = options;
	const orphans = db
		.prepare('SELECT addr FROM blob_ref WHERE vault_id = ? AND refcount <= 0')
		.all(vaultId) as { addr: string }[];

	const youngerThan = Date.now() - graceMs;
	let reclaimed = 0;

	for (const { addr } of orphans) {
		const found = await blobs.stat(vaultId, addr);
		if (found !== undefined && found.writtenAt > youngerThan) {
			continue;
		}

		// Row first, blob second — the reverse of an upload. A commit racing the sweep
		// either bumps the refcount (releasing nothing) or loses its blob_ref and is
		// rejected as missing_chunks, which the client recovers by re-uploading.
		const released = await writer.run(() => {
			const row = db
				.prepare('SELECT refcount FROM blob_ref WHERE vault_id = ? AND addr = ?')
				.get(vaultId, addr) as { refcount: number } | undefined;
			if (row === undefined || row.refcount > 0) {
				return false;
			}
			db.prepare('DELETE FROM blob_ref WHERE vault_id = ? AND addr = ?').run(vaultId, addr);
			return true;
		});

		if (!released) {
			continue;
		}

		await blobs.remove(vaultId, addr);
		reclaimed += 1;
	}

	return reclaimed;
}

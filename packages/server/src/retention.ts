import type { DatabaseSync } from 'node:sqlite';
import type { BlobStore } from './blobs.js';

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

export async function sweepOrphanBlobs(
	db: DatabaseSync,
	blobs: BlobStore,
	vaultId: string,
	graceMs: number,
): Promise<number> {
	const orphans = db
		.prepare('SELECT addr FROM blob_ref WHERE vault_id = ? AND refcount <= 0')
		.all(vaultId) as { addr: string }[];

	const youngerThan = Date.now() - graceMs;
	const forget = db.prepare('DELETE FROM blob_ref WHERE vault_id = ? AND addr = ?');
	let reclaimed = 0;

	for (const { addr } of orphans) {
		const writtenAt = await blobs.writtenAt(vaultId, addr);
		if (writtenAt !== undefined && writtenAt > youngerThan) {
			continue;
		}

		// Blob first, row second — the same ordering as an upload, for the same
		// reason: a row without a blob is corruption, a blob without a row is litter.
		await blobs.remove(vaultId, addr);
		forget.run(vaultId, addr);
		reclaimed += 1;
	}

	return reclaimed;
}

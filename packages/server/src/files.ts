import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FileState, VersionSummary } from '@obsidian-sync/protocol';
import { appendChange } from './changes.js';

export type CommitOutcome =
	| { status: 'committed'; versionId: string; seq: number }
	| { status: 'conflict'; headVersion: string | undefined }
	| { status: 'missingChunks'; missing: string[] };

export interface CommitInput {
	vaultId: string;
	fileId: string;
	parentVersion: string | undefined;
	metaBlob: string;
	chunks: string[];
	size: number;
	deviceId: string;
}

/**
 * The version a client must name as its parent, or undefined when the file does
 * not exist or has been tombstoned. A tombstone reads as absent so that
 * recreating a deleted path is a plain create rather than a special case.
 */
function currentHead(db: DatabaseSync, vaultId: string, fileId: string): string | undefined {
	const row = db
		.prepare('SELECT head_version, deleted FROM file WHERE vault_id = ? AND file_id = ?')
		.get(vaultId, fileId) as { head_version: string | null; deleted: number } | undefined;

	if (row === undefined || row.deleted === 1) {
		return undefined;
	}
	return row.head_version ?? undefined;
}

function findUnknownChunks(db: DatabaseSync, vaultId: string, chunks: string[]): string[] {
	const lookup = db.prepare('SELECT 1 AS present FROM blob_ref WHERE vault_id = ? AND addr = ?');
	const missing: string[] = [];

	for (const address of new Set(chunks)) {
		if (lookup.get(vaultId, address) === undefined) {
			missing.push(address);
		}
	}
	return missing;
}

export function commitVersion(db: DatabaseSync, input: CommitInput): CommitOutcome {
	db.exec('BEGIN IMMEDIATE');
	try {
		const missing = findUnknownChunks(db, input.vaultId, input.chunks);
		if (missing.length > 0) {
			db.exec('ROLLBACK');
			return { status: 'missingChunks', missing };
		}

		const headVersion = currentHead(db, input.vaultId, input.fileId);
		if (headVersion !== input.parentVersion) {
			db.exec('ROLLBACK');
			return { status: 'conflict', headVersion };
		}

		const versionId = randomUUID();
		db.prepare(
			'INSERT INTO version (vault_id, file_id, version_id, parent_version, meta_blob, chunks, size, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		).run(
			input.vaultId,
			input.fileId,
			versionId,
			input.parentVersion ?? null,
			input.metaBlob,
			JSON.stringify(input.chunks),
			input.size,
			input.deviceId,
			Date.now(),
		);

		const seq = appendChange(db, {
			vaultId: input.vaultId,
			fileId: input.fileId,
			versionId,
			kind: 'upsert',
			size: input.size,
		});

		db.prepare(
			'INSERT INTO file (vault_id, file_id, head_version, deleted, updated_seq) VALUES (?, ?, ?, 0, ?) ON CONFLICT (vault_id, file_id) DO UPDATE SET head_version = excluded.head_version, deleted = 0, updated_seq = excluded.updated_seq',
		).run(input.vaultId, input.fileId, versionId, seq);

		// Distinct addresses only: a file repeating a chunk holds one reference to
		// it, so pruning that version releases the reference exactly once.
		const bump = db.prepare(
			'UPDATE blob_ref SET refcount = refcount + 1 WHERE vault_id = ? AND addr = ?',
		);
		for (const address of new Set(input.chunks)) {
			bump.run(input.vaultId, address);
		}

		db.exec('COMMIT');
		return { status: 'committed', versionId, seq };
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function deleteFile(
	db: DatabaseSync,
	input: { vaultId: string; fileId: string; parentVersion: string | undefined },
): CommitOutcome {
	db.exec('BEGIN IMMEDIATE');
	try {
		const headVersion = currentHead(db, input.vaultId, input.fileId);
		if (headVersion === undefined || headVersion !== input.parentVersion) {
			db.exec('ROLLBACK');
			return { status: 'conflict', headVersion };
		}

		const seq = appendChange(db, {
			vaultId: input.vaultId,
			fileId: input.fileId,
			versionId: undefined,
			kind: 'delete',
			size: 0,
		});

		// The version rows survive: history and restore outlive the tombstone, and
		// retention is what eventually releases the chunks.
		db.prepare(
			'UPDATE file SET deleted = 1, head_version = NULL, updated_seq = ? WHERE vault_id = ? AND file_id = ?',
		).run(seq, input.vaultId, input.fileId);

		db.exec('COMMIT');
		return { status: 'committed', versionId: '', seq };
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function readVaultState(db: DatabaseSync, vaultId: string): FileState[] {
	const rows = db
		.prepare(
			`SELECT f.file_id, f.head_version, f.updated_seq, v.meta_blob, v.size
			 FROM file f
			 JOIN version v ON v.vault_id = f.vault_id AND v.file_id = f.file_id AND v.version_id = f.head_version
			 WHERE f.vault_id = ? AND f.deleted = 0
			 ORDER BY f.updated_seq`,
		)
		.all(vaultId) as {
		file_id: string;
		head_version: string;
		updated_seq: number;
		meta_blob: string;
		size: number;
	}[];

	return rows.map((row) => ({
		fileId: row.file_id,
		headVersion: row.head_version,
		metaBlob: row.meta_blob,
		size: row.size,
		updatedSeq: row.updated_seq,
	}));
}

export interface VersionWindow {
	limit: number;
	offset: number;
}

export interface VersionPage {
	versions: VersionSummary[];
	hasMore: boolean;
}

export function listVersions(
	db: DatabaseSync,
	vaultId: string,
	fileId: string,
	window: VersionWindow,
): VersionPage {
	// One row beyond the window answers hasMore without a second COUNT query.
	const rows = db
		.prepare(
			'SELECT version_id, parent_version, meta_blob, size, device_id, created_at FROM version WHERE vault_id = ? AND file_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
		)
		.all(vaultId, fileId, window.limit + 1, window.offset) as {
		version_id: string;
		parent_version: string | null;
		meta_blob: string;
		size: number;
		device_id: string;
		created_at: number;
	}[];

	const hasMore = rows.length > window.limit;
	return {
		versions: rows.slice(0, window.limit).map((row) => ({
			versionId: row.version_id,
			parentVersion: row.parent_version ?? undefined,
			metaBlob: row.meta_blob,
			size: row.size,
			deviceId: row.device_id,
			createdAt: row.created_at,
		})),
		hasMore,
	};
}

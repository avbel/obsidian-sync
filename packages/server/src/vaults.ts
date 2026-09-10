import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { kdfSaltBytes, type VaultSummary } from '@obsidian-sync/protocol';

interface VaultRow {
	id: string;
	name: string;
	kdf_salt: Uint8Array;
}

export class VaultNameTakenError extends Error {
	constructor(name: string) {
		super(`vault "${name}" already exists for this user`);
		this.name = 'VaultNameTakenError';
	}
}

function toSummary(row: VaultRow): VaultSummary {
	return {
		id: row.id,
		name: row.name,
		kdfSalt: Buffer.from(row.kdf_salt).toString('base64'),
	};
}

export function listVaultsForOwner(db: DatabaseSync, owner: string): VaultSummary[] {
	const rows = db
		.prepare('SELECT id, name, kdf_salt FROM vault WHERE owner = ? ORDER BY name')
		.all(owner) as unknown as VaultRow[];

	return rows.map(toSummary);
}

export function findVaultForOwner(
	db: DatabaseSync,
	vaultId: string,
	owner: string,
): VaultSummary | undefined {
	const row = db
		.prepare('SELECT id, name, kdf_salt FROM vault WHERE id = ? AND owner = ?')
		.get(vaultId, owner) as VaultRow | undefined;

	return row === undefined ? undefined : toSummary(row);
}

export function createVault(db: DatabaseSync, owner: string, name: string): VaultSummary {
	const existing = db.prepare('SELECT id FROM vault WHERE owner = ? AND name = ?').get(owner, name);

	if (existing !== undefined) {
		throw new VaultNameTakenError(name);
	}

	const id = randomUUID();
	const salt = randomBytes(kdfSaltBytes);

	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run(id, name, owner, salt, Date.now());

	return { id, name, kdfSalt: salt.toString('base64') };
}

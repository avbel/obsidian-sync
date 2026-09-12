import { StaleWriteError, type VaultAdapter } from './vault.js';

export interface ConflictRecord {
	path: string;
	conflictCopyPath: string;
}

export type ConflictChoice = 'mine' | 'remote' | 'both';

/**
 * `missing-copy`: the user deleted or renamed the copy themselves — the record is
 * stale and should be dropped. `stale`: the note changed between reading it and
 * writing the resolution, so nothing was written and the user must choose again.
 */
export type ConflictOutcome = 'resolved' | 'missing-copy' | 'stale';

/**
 * Apply a user's choice to an already-copied conflict (§8). Both sides are plain vault
 * files by this point, so this touches no network, no keys and no server version.
 *
 * That is why it lives here rather than on `SyncEngine`: a conflict copy outlives the
 * sync that produced it, and the user must still be able to clear one after switching
 * sync off — the point at which there is no engine, client or queue to reach for.
 *
 * `mine` deliberately leaves the index recording the remote version. That is what makes
 * the restored bytes read as dirty, so the next push commits them against the current
 * head instead of needing a second commit path here.
 */
export async function resolveConflictInVault(
	vault: VaultAdapter,
	record: ConflictRecord,
	choice: ConflictChoice,
): Promise<ConflictOutcome> {
	if (choice === 'both') {
		return 'resolved';
	}
	if (!(await vault.exists(record.conflictCopyPath))) {
		return 'missing-copy';
	}
	if (choice === 'remote') {
		await vault.trash(record.conflictCopyPath);
		return 'resolved';
	}

	const mine = await vault.read(record.conflictCopyPath);
	const current = (await vault.exists(record.path)) ? await vault.read(record.path) : undefined;
	try {
		await vault.write(record.path, mine, { expected: current });
	} catch (error) {
		if (error instanceof StaleWriteError) {
			return 'stale';
		}
		throw error;
	}
	await vault.trash(record.conflictCopyPath);
	return 'resolved';
}

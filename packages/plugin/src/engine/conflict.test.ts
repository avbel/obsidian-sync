import { describe, expect, test } from 'vitest';
import { MemoryVault } from '../testing/memory-fixtures.js';
import { type ConflictRecord, resolveConflictInVault } from './conflict.js';

const record: ConflictRecord = {
	path: 'note.md',
	conflictCopyPath: 'note (conflict 2026-01-01 00-00-00).md',
};

function conflicted(): MemoryVault {
	const vault = new MemoryVault();
	vault.putText(record.path, 'remote\n');
	vault.putText(record.conflictCopyPath, 'mine\n');
	return vault;
}

// Every case runs on a bare vault: no engine, no client, no queue. That is the point —
// a conflict copy outlives the sync that produced it, and the user must still be able to
// clear one after switching sync off.
describe('resolveConflictInVault', () => {
	test('keeping mine restores the copy over the note and drops the copy', async () => {
		const vault = conflicted();

		expect(await resolveConflictInVault(vault, record, 'mine')).toBe('resolved');
		expect(vault.getText(record.path)).toBe('mine\n');
		expect(await vault.exists(record.conflictCopyPath)).toBe(false);
	});

	test('keeping theirs leaves the note and drops the copy', async () => {
		const vault = conflicted();

		expect(await resolveConflictInVault(vault, record, 'remote')).toBe('resolved');
		expect(vault.getText(record.path)).toBe('remote\n');
		expect(await vault.exists(record.conflictCopyPath)).toBe(false);
	});

	test('keeping both leaves every file exactly where it is', async () => {
		const vault = conflicted();

		expect(await resolveConflictInVault(vault, record, 'both')).toBe('resolved');
		expect(vault.getText(record.path)).toBe('remote\n');
		expect(vault.getText(record.conflictCopyPath)).toBe('mine\n');
	});

	test('reports a copy the user already deleted instead of acting', async () => {
		const vault = new MemoryVault();
		vault.putText(record.path, 'remote\n');

		expect(await resolveConflictInVault(vault, record, 'mine')).toBe('missing-copy');
		expect(vault.getText(record.path)).toBe('remote\n');
	});

	test('refuses to clobber a note that changed while the choice was being made', async () => {
		const vault = conflicted();
		vault.raceOnce(record.path, 'edited while the modal was open\n');

		expect(await resolveConflictInVault(vault, record, 'mine')).toBe('stale');
		expect(vault.getText(record.path)).toBe('edited while the modal was open\n');
		// The copy survives a refused resolution, so the choice can be made again.
		expect(vault.getText(record.conflictCopyPath)).toBe('mine\n');
	});
});

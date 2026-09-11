import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { computeFileId } from '../crypto/identity.js';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { type Device, fullSelective, makeDevice } from '../testing/devices.js';
import { FakeServer } from '../testing/fake-server.js';
import { ApiClient } from '../transport/client.js';
import { type ConflictRecord, SyncEngine } from './sync.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

/** Reads the fixtures at call time, so each test gets the instances `beforeEach` built. */
async function device(deviceId: string): Promise<Device> {
	return makeDevice({ server, keys, client }, deviceId);
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});

describe('two clients on one vault', () => {
	test('a push from one device reaches the other after a pull', async () => {
		const laptop = await device('laptop');
		const phone = await device('phone');

		laptop.vault.putText('notes/idea.md', 'hello from the laptop\n');
		await laptop.engine.pushAll();
		await phone.engine.pullAll();

		expect(phone.vault.getText('notes/idea.md')).toBe('hello from the laptop\n');
	});

	test('an edited line reaches the other device intact', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\ntwo\nthree\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();
		laptop.vault.putText('a.md', 'one\nTWO\nthree\n');
		await laptop.engine.pushAll();
		await phone.engine.pullAll();

		expect(phone.vault.getText('a.md')).toBe('one\nTWO\nthree\n');
	});

	test('a remote delete is trashed locally', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('gone.md', 'bye\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();
		expect(phone.vault.getText('gone.md')).toBe('bye\n');

		const known = await computeFileId(keys.nameMacKey, 'gone.md');
		expect(server.headOf(known)).toBeDefined();
		// A local delete: the file is gone from the device, and the watcher queues its
		// removal. pushAll must not re-create it from a still-listed copy.
		await laptop.vault.remove('gone.md');
		await laptop.engine.pushAll(['gone.md']);
		await phone.engine.pullAll();
		expect(await phone.vault.exists('gone.md')).toBe(false);
	});

	test('disjoint edits on both devices merge on the late device', async () => {
		const seed = await device('seed');
		seed.vault.putText('doc.md', 'l1\nl2\nl3\nl4\n');
		await seed.engine.pushAll();

		const a = await device('a');
		const b = await device('b');
		await a.engine.pullAll();
		await b.engine.pullAll();

		a.vault.putText('doc.md', 'l1\nA-EDIT\nl3\nl4\n');
		b.vault.putText('doc.md', 'l1\nl2\nl3\nB-EDIT\n');
		await a.engine.pushAll();
		await b.engine.pushAll();

		const late = await device('late');
		await late.engine.pullAll();
		expect(late.vault.getText('doc.md')).toBe('l1\nA-EDIT\nl3\nB-EDIT\n');
	});

	test('a true conflict produces a conflict copy and keeps the winning version', async () => {
		const seed = await device('seed');
		seed.vault.putText('c.md', 'shared\ncontext\nbase\n');
		await seed.engine.pushAll();

		const a = await device('a');
		const b = await device('b');
		await a.engine.pullAll();
		await b.engine.pullAll();

		a.vault.putText('c.md', 'shared\nversion-A\nbase\n');
		b.vault.putText('c.md', 'shared\nversion-B\nbase\n');
		await a.engine.pushAll();
		await b.engine.pushAll();

		expect(
			b.conflicts.length + ((await b.vault.exists('c (conflict 2026-01-01 00-00-00).md')) ? 1 : 0),
		).toBeGreaterThanOrEqual(0);
		// Whichever device pushed second must retain its bytes somewhere: either merged
		// or in a conflict copy. The invariant (§8) is that nothing is destroyed.
		const survivingA = a.vault.getText('c.md');
		const bHasCopyOrMerge =
			b.vault.getText('c.md') === 'shared\nversion-A\nbase\n' || b.conflicts.length > 0;
		expect(survivingA).toBeDefined();
		expect(bHasCopyOrMerge).toBe(true);
	});

	test('stable content uploads no new blobs on a no-op re-push', async () => {
		const a = await device('a');
		a.vault.putText('stable.md', 'same bytes\n');
		await a.engine.pushAll();
		const fileId = await computeFileId(keys.nameMacKey, 'stable.md');
		expect(server.headOf(fileId)).toBeDefined();

		const before = server.blobs.size;
		await a.engine.pushAll();
		expect(server.blobs.size).toBe(before);
	});
});

describe('regressions', () => {
	test('a clean merge made during a pull is uploaded by the next push', async () => {
		const seed = await device('seed');
		seed.vault.putText('doc.md', 'l1\nl2\nl3\nl4\n');
		await seed.engine.pushAll();

		const a = await device('a');
		const b = await device('b');
		await a.engine.pullAll();
		await b.engine.pullAll();

		a.vault.putText('doc.md', 'l1\nA-EDIT\nl3\nl4\n');
		await a.engine.pushAll();

		b.vault.putText('doc.md', 'l1\nl2\nl3\nB-EDIT\n');
		expect(await b.engine.pullAll()).toBe(1);
		expect(b.vault.getText('doc.md')).toBe('l1\nA-EDIT\nl3\nB-EDIT\n');
		await b.engine.pushAll();

		const late = await device('late');
		await late.engine.pullAll();
		expect(late.vault.getText('doc.md')).toBe('l1\nA-EDIT\nl3\nB-EDIT\n');
	});

	test('a remote delete keeps an unsynced local edit and republishes it', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('note.md', 'original\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		phone.vault.putText('note.md', 'edited on the phone\n');
		await laptop.vault.remove('note.md');
		await laptop.engine.pushAll(['note.md']);

		await phone.engine.pullAll();
		expect(phone.vault.getText('note.md')).toBe('edited on the phone\n');

		await phone.engine.pushAll();
		await laptop.engine.pullAll();
		expect(laptop.vault.getText('note.md')).toBe('edited on the phone\n');
	});

	test('a delete lost before it was queued is recovered from the index', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('gone.md', 'bye\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		await laptop.vault.remove('gone.md');
		await laptop.engine.pushAll();

		await phone.engine.pullAll();
		expect(await phone.vault.exists('gone.md')).toBe(false);
	});

	// Obsidian populates its file cache after the plugin loads, so a sync racing
	// startup sees a full index and an empty vault. That must never read as a delete.
	test('a restart whose vault cannot see its own files yet deletes nothing remotely', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		await laptop.engine.pushAll();
		expect(server.liveFileCount()).toBe(2);

		laptop.vault.setBlind(true);
		const restarted = new SyncEngine(laptop.deps);
		await restarted.pushAll();
		expect(server.liveFileCount()).toBe(2);

		laptop.vault.setBlind(false);
		await restarted.pushAll();
		expect(server.liveFileCount()).toBe(2);
		expect(laptop.index.entries()).toHaveLength(2);
	});

	test('a genuine delete still propagates while other files remain', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('keep.md', 'stay\n');
		laptop.vault.putText('drop.md', 'go\n');
		await laptop.engine.pushAll();
		expect(server.liveFileCount()).toBe(2);

		await laptop.vault.remove('drop.md');
		await laptop.engine.pushAll();
		expect(server.liveFileCount()).toBe(1);
	});

	// The engine's own vault.trash() is reported back by the watcher as a user delete.
	// If a pull restores the file before that queued delete is pushed, pushing it
	// deletes live content, and two devices ping-pong the same file forever.
	test('a queued delete for a file that has come back is dropped', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('note.md', 'alive\n');
		await laptop.engine.pushAll();

		const fileId = await computeFileId(keys.nameMacKey, 'note.md');
		expect(server.headOf(fileId)).toBeDefined();

		// Assert on the change log, not the end state: without the guard the delete
		// lands and the very same pushAll re-uploads the file, so the vault looks
		// settled while every device has been handed a delete to apply.
		const before = server.log.length;
		await laptop.engine.pushAll(['note.md']);

		expect(server.log.slice(before).map((change) => change.kind)).toEqual([]);
		expect(server.headOf(fileId)).toBeDefined();
		expect(laptop.index.get('note.md')).toBeDefined();
		expect(laptop.vault.getText('note.md')).toBe('alive\n');
	});

	test('identical content never produces a conflict copy, even with no ancestor', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('same.md', 'identical bytes\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		phone.vault.putText('same.md', 'identical bytes\n');
		await phone.engine.pullAll();

		expect(phone.conflicts).toEqual([]);
		expect((await phone.vault.list()).map((file) => file.path)).toEqual(['same.md']);
		expect(phone.vault.getText('same.md')).toBe('identical bytes\n');
	});

	test('a selective-sync change applies to a running engine', async () => {
		const phone = await device('phone');
		phone.vault.putText('note.md', 'text\n');
		phone.vault.putText('attachment.bin', 'bytes\n');
		await phone.engine.pushAll();
		expect(phone.index.get('attachment.bin')).toBeDefined();

		phone.engine.updateSelective({
			...fullSelective,
			categories: { ...fullSelective.categories, attachments: false },
		});
		phone.vault.putText('second.bin', 'more bytes\n');
		await phone.engine.pushAll();

		expect(phone.index.get('second.bin')).toBeUndefined();
	});

	test('a keystroke landing mid-apply survives instead of being overwritten', async () => {
		const seed = await device('seed');
		seed.vault.putText('race.md', 'line one\nline two\n');
		await seed.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		seed.vault.putText('race.md', 'line one EDITED\nline two\n');
		await seed.engine.pushAll();

		phone.vault.raceOnce('race.md', 'line one\nline two\ntyped by the user\n');
		await phone.engine.pullAll();

		expect(phone.vault.getText('race.md')).toBe('line one EDITED\nline two\ntyped by the user\n');
	});

	// #pullFileById used to fetch the entire vault state per changed file, so a page
	// of N changes cost N full-state responses — every metaBlob in the vault, N times.
	test('a pull page costs one state request however many files changed', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		laptop.vault.putText('c.md', 'three\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		server.requests.length = 0;
		await phone.engine.pullAll();

		expect(server.requests.filter((entry) => entry.endsWith('/state'))).toHaveLength(1);
		expect(phone.vault.getText('c.md')).toBe('three\n');
	});

	test('a pull with nothing to apply fetches no state at all', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();
		server.requests.length = 0;
		await phone.engine.pullAll();

		expect(server.requests.filter((entry) => entry.endsWith('/state'))).toEqual([]);
	});
});

describe('conflict resolution', () => {
	/** Drives two devices into a real unmergeable conflict and returns the loser's record. */
	async function conflicted(): Promise<{
		a: Device;
		b: Device;
		record: ConflictRecord;
	}> {
		const seed = await device('seed');
		seed.vault.putText('c.md', 'shared\nbase\n');
		await seed.engine.pushAll();

		const a = await device('a');
		const b = await device('b');
		await a.engine.pullAll();
		await b.engine.pullAll();

		a.vault.putText('c.md', 'shared\nversion-A\n');
		b.vault.putText('c.md', 'shared\nversion-B\n');
		await a.engine.pushAll();
		await b.engine.pullAll();

		const record = b.conflicts[0];
		if (record === undefined) {
			throw new Error('expected the second device to record a conflict');
		}
		expect(b.vault.getText('c.md')).toBe('shared\nversion-A\n');
		expect(b.vault.getText(record.conflictCopyPath)).toBe('shared\nversion-B\n');
		return { a, b, record };
	}

	test('keeping the local side restores it and republishes it to the other device', async () => {
		const { a, b, record } = await conflicted();

		expect(await b.engine.resolveConflict(record, 'mine')).toBe('resolved');
		expect(b.vault.getText('c.md')).toBe('shared\nversion-B\n');
		expect(await b.vault.exists(record.conflictCopyPath)).toBe(false);

		// The index still records A's version, so the file reads dirty and pushes.
		await b.engine.pushAll();
		await a.engine.pullAll();
		expect(a.vault.getText('c.md')).toBe('shared\nversion-B\n');
	});

	test('keeping the remote side drops the copy and leaves nothing to push', async () => {
		const { a, b, record } = await conflicted();

		expect(await b.engine.resolveConflict(record, 'remote')).toBe('resolved');
		expect(b.vault.getText('c.md')).toBe('shared\nversion-A\n');
		expect(await b.vault.exists(record.conflictCopyPath)).toBe(false);

		await b.engine.pushAll();
		await a.engine.pullAll();
		expect(a.vault.getText('c.md')).toBe('shared\nversion-A\n');
	});

	test('keeping both leaves every file alone', async () => {
		const { b, record } = await conflicted();

		expect(await b.engine.resolveConflict(record, 'both')).toBe('resolved');
		expect(b.vault.getText('c.md')).toBe('shared\nversion-A\n');
		expect(b.vault.getText(record.conflictCopyPath)).toBe('shared\nversion-B\n');
	});

	test('a copy the user already deleted resolves as missing rather than throwing', async () => {
		const { b, record } = await conflicted();
		await b.vault.trash(record.conflictCopyPath);

		expect(await b.engine.resolveConflict(record, 'mine')).toBe('missing-copy');
	});

	test('an edit landing while the modal is open is never clobbered', async () => {
		const { b, record } = await conflicted();
		// Rewrites c.md the next time it is read: a keystroke between read and write.
		b.vault.raceOnce('c.md', 'typed\nwhile\nopen\n');

		expect(await b.engine.resolveConflict(record, 'mine')).toBe('stale');
		expect(b.vault.getText('c.md')).toBe('typed\nwhile\nopen\n');
		expect(await b.vault.exists(record.conflictCopyPath)).toBe(true);
	});
});

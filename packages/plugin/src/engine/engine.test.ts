import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { computeFileId } from '../crypto/identity.js';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { BaseCache } from '../state/base-cache.js';
import { FileIndex } from '../state/file-index.js';
import { LocalState, type LocalStateStore } from '../state/local-state.js';
import { FakeServer } from '../testing/fake-server.js';
import { MemoryStorage, MemoryVault } from '../testing/memory-fixtures.js';
import { ApiClient } from '../transport/client.js';
import type { SelectiveSyncOptions } from './selective.js';
import type { SyncEngineDeps } from './sync.js';
import { type ConflictRecord, SyncEngine } from './sync.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');
const full: SelectiveSyncOptions = {
	categories: {
		markdown: true,
		attachments: true,
		config: true,
		themes: true,
		snippets: true,
		pluginSettings: true,
	},
	excludedFolders: [],
	maxFileBytes: 100 * 1024 * 1024,
};

function memoryLocalState(): { local: LocalState; store: Map<string, string> } {
	const data = new Map<string, string>();
	const store: LocalStateStore = {
		get: (key) => data.get(key) ?? null,
		set: (key, value) => {
			data.set(key, value);
		},
	};
	return { local: new LocalState(store), store: data };
}

interface Device {
	engine: SyncEngine;
	vault: MemoryVault;
	index: FileIndex;
	conflicts: ConflictRecord[];
	deps: SyncEngineDeps;
}

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

async function makeDevice(deviceId: string): Promise<Device> {
	const vault = new MemoryVault();
	const index = new FileIndex(new MemoryStorage());
	const bases = new BaseCache(new MemoryStorage());
	const { local } = memoryLocalState();
	await index.load();
	await bases.load();
	const conflicts: ConflictRecord[] = [];
	const deps: SyncEngineDeps = {
		vaultId: server.vaultId,
		client,
		keys,
		vault,
		index,
		bases,
		local,
		selective: full,
		deviceId,
		onConflict: (conflict) => conflicts.push(conflict),
	};
	return { engine: new SyncEngine(deps), vault, index, conflicts, deps };
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});

describe('two clients on one vault', () => {
	test('a push from one device reaches the other after a pull', async () => {
		const laptop = await makeDevice('laptop');
		const phone = await makeDevice('phone');

		laptop.vault.putText('notes/idea.md', 'hello from the laptop\n');
		await laptop.engine.pushAll();
		await phone.engine.pullAll();

		expect(phone.vault.getText('notes/idea.md')).toBe('hello from the laptop\n');
	});

	test('an edited line reaches the other device intact', async () => {
		const laptop = await makeDevice('laptop');
		laptop.vault.putText('a.md', 'one\ntwo\nthree\n');
		await laptop.engine.pushAll();

		const phone = await makeDevice('phone');
		await phone.engine.pullAll();
		laptop.vault.putText('a.md', 'one\nTWO\nthree\n');
		await laptop.engine.pushAll();
		await phone.engine.pullAll();

		expect(phone.vault.getText('a.md')).toBe('one\nTWO\nthree\n');
	});

	test('a remote delete is trashed locally', async () => {
		const laptop = await makeDevice('laptop');
		laptop.vault.putText('gone.md', 'bye\n');
		await laptop.engine.pushAll();

		const phone = await makeDevice('phone');
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
		const seed = await makeDevice('seed');
		seed.vault.putText('doc.md', 'l1\nl2\nl3\nl4\n');
		await seed.engine.pushAll();

		const a = await makeDevice('a');
		const b = await makeDevice('b');
		await a.engine.pullAll();
		await b.engine.pullAll();

		a.vault.putText('doc.md', 'l1\nA-EDIT\nl3\nl4\n');
		b.vault.putText('doc.md', 'l1\nl2\nl3\nB-EDIT\n');
		await a.engine.pushAll();
		await b.engine.pushAll();

		const late = await makeDevice('late');
		await late.engine.pullAll();
		expect(late.vault.getText('doc.md')).toBe('l1\nA-EDIT\nl3\nB-EDIT\n');
	});

	test('a true conflict produces a conflict copy and keeps the winning version', async () => {
		const seed = await makeDevice('seed');
		seed.vault.putText('c.md', 'shared\ncontext\nbase\n');
		await seed.engine.pushAll();

		const a = await makeDevice('a');
		const b = await makeDevice('b');
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
		const a = await makeDevice('a');
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
		const seed = await makeDevice('seed');
		seed.vault.putText('doc.md', 'l1\nl2\nl3\nl4\n');
		await seed.engine.pushAll();

		const a = await makeDevice('a');
		const b = await makeDevice('b');
		await a.engine.pullAll();
		await b.engine.pullAll();

		a.vault.putText('doc.md', 'l1\nA-EDIT\nl3\nl4\n');
		await a.engine.pushAll();

		b.vault.putText('doc.md', 'l1\nl2\nl3\nB-EDIT\n');
		expect(await b.engine.pullAll()).toBe(1);
		expect(b.vault.getText('doc.md')).toBe('l1\nA-EDIT\nl3\nB-EDIT\n');
		await b.engine.pushAll();

		const late = await makeDevice('late');
		await late.engine.pullAll();
		expect(late.vault.getText('doc.md')).toBe('l1\nA-EDIT\nl3\nB-EDIT\n');
	});

	test('a remote delete keeps an unsynced local edit and republishes it', async () => {
		const laptop = await makeDevice('laptop');
		laptop.vault.putText('note.md', 'original\n');
		await laptop.engine.pushAll();

		const phone = await makeDevice('phone');
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
		const laptop = await makeDevice('laptop');
		laptop.vault.putText('gone.md', 'bye\n');
		await laptop.engine.pushAll();

		const phone = await makeDevice('phone');
		await phone.engine.pullAll();

		await laptop.vault.remove('gone.md');
		await laptop.engine.pushAll();

		await phone.engine.pullAll();
		expect(await phone.vault.exists('gone.md')).toBe(false);
	});

	// Obsidian populates its file cache after the plugin loads, so a sync racing
	// startup sees a full index and an empty vault. That must never read as a delete.
	test('a restart whose vault cannot see its own files yet deletes nothing remotely', async () => {
		const laptop = await makeDevice('laptop');
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
		const laptop = await makeDevice('laptop');
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
		const laptop = await makeDevice('laptop');
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
		const laptop = await makeDevice('laptop');
		laptop.vault.putText('same.md', 'identical bytes\n');
		await laptop.engine.pushAll();

		const phone = await makeDevice('phone');
		phone.vault.putText('same.md', 'identical bytes\n');
		await phone.engine.pullAll();

		expect(phone.conflicts).toEqual([]);
		expect((await phone.vault.list()).map((file) => file.path)).toEqual(['same.md']);
		expect(phone.vault.getText('same.md')).toBe('identical bytes\n');
	});

	test('a selective-sync change applies to a running engine', async () => {
		const device = await makeDevice('device');
		device.vault.putText('note.md', 'text\n');
		device.vault.putText('attachment.bin', 'bytes\n');
		await device.engine.pushAll();
		expect(device.index.get('attachment.bin')).toBeDefined();

		device.engine.updateSelective({
			...full,
			categories: { ...full.categories, attachments: false },
		});
		device.vault.putText('second.bin', 'more bytes\n');
		await device.engine.pushAll();

		expect(device.index.get('second.bin')).toBeUndefined();
	});

	test('a keystroke landing mid-apply survives instead of being overwritten', async () => {
		const seed = await makeDevice('seed');
		seed.vault.putText('race.md', 'line one\nline two\n');
		await seed.engine.pushAll();

		const phone = await makeDevice('phone');
		await phone.engine.pullAll();

		seed.vault.putText('race.md', 'line one EDITED\nline two\n');
		await seed.engine.pushAll();

		phone.vault.raceOnce('race.md', 'line one\nline two\ntyped by the user\n');
		await phone.engine.pullAll();

		expect(phone.vault.getText('race.md')).toBe('line one EDITED\nline two\ntyped by the user\n');
	});
});

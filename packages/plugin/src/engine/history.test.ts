import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { bytesToText, textToBytes } from '../crypto/encoding.js';
import { computeFileId } from '../crypto/identity.js';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { type Device, makeDevice } from '../testing/devices.js';
import { FakeServer } from '../testing/fake-server.js';
import { ApiClient } from '../transport/client.js';
import {
	type HistoryEntry,
	VersionContentUnavailableError,
	VersionHistoryService,
	VersionUnreadableError,
} from './history.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

interface HistoryDevice extends Device {
	history: VersionHistoryService;
}

async function device(deviceId: string, deviceLabel: string): Promise<HistoryDevice> {
	const built = await makeDevice({ server, keys, client }, deviceId);
	built.engine.updateDeviceLabel(deviceLabel);
	return {
		...built,
		history: new VersionHistoryService({
			...built.deps,
			enqueue: (path) => built.queue.enqueue(path, 'upsert'),
			// `fullScan: false` is what an ordinary sync does; the no-arg default rescans the
			// whole vault and would hide a restore that forgot to queue its own path.
			requestSync: () => built.engine.pushAll({ fullScan: false }),
		}),
	};
}

function entryAt(entries: HistoryEntry[], index: number): HistoryEntry {
	const entry = entries[index];
	if (entry === undefined) {
		throw new Error(`expected version at index ${index}`);
	}
	return entry;
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});

describe('VersionHistoryService', () => {
	test('lists versions newest first, labelled with the committing device', async () => {
		const local = await device('device-1', 'Studio Mac');
		await local.vault.write('note.md', textToBytes('one\n'));
		await local.engine.pushAll();
		await local.vault.write('note.md', textToBytes('one\ntwo\n'));
		await local.engine.pushAll();

		const page = await local.history.list('note.md');

		expect(page.entries).toHaveLength(2);
		expect(entryAt(page.entries, 0).isCurrent).toBe(true);
		expect(entryAt(page.entries, 0).deviceLabel).toBe('Studio Mac');
		expect(entryAt(page.entries, 1).parentVersion).toBeUndefined();
		expect(page.path).toBe('note.md');
	});

	test('reads a historical version back to its exact bytes', async () => {
		const local = await device('device-1', 'Studio Mac');
		await local.vault.write('note.md', textToBytes('one\n'));
		await local.engine.pushAll();
		await local.vault.write('note.md', textToBytes('one\ntwo\n'));
		await local.engine.pushAll();

		const page = await local.history.list('note.md');
		expect(bytesToText(await local.history.read(page.fileId, entryAt(page.entries, 1)))).toBe(
			'one\n',
		);
	});

	test('restore writes old bytes and commits them as a new head version', async () => {
		const local = await device('device-1', 'Studio Mac');
		await local.vault.write('note.md', textToBytes('one\n'));
		await local.engine.pushAll();
		await local.vault.write('note.md', textToBytes('one\ntwo\n'));
		await local.engine.pushAll();

		const page = await local.history.list('note.md');
		const oldest = entryAt(page.entries, 1);
		const headBefore = server.headOf(page.fileId);

		const outcome = await local.history.restore({
			path: 'note.md',
			fileId: page.fileId,
			entry: oldest,
		});

		expect(outcome.status).toBe('restored');
		expect(bytesToText(await local.vault.read('note.md'))).toBe('one\n');
		const headAfter = server.headOf(page.fileId);
		if (headAfter === undefined) {
			throw new Error('expected restored version to be the new head');
		}
		expect(headAfter).not.toBe(headBefore);
		expect(headAfter).not.toBe(oldest.versionId);
		expect(server.versions.get(headAfter)?.parentVersion).toBe(headBefore);
		expect((await local.history.list('note.md')).entries).toHaveLength(3);
	});

	test('does not commit when restoring the version already on disk', async () => {
		const local = await device('device-1', 'Studio Mac');
		await local.vault.write('note.md', textToBytes('one\n'));
		await local.engine.pushAll();

		const page = await local.history.list('note.md');
		expect(
			(
				await local.history.restore({
					path: 'note.md',
					fileId: page.fileId,
					entry: entryAt(page.entries, 0),
				})
			).status,
		).toBe('unchanged');
		expect((await local.history.list('note.md')).entries).toHaveLength(1);
	});

	test('restore as a copy leaves the live note untouched', async () => {
		const local = await device('device-1', 'Studio Mac');
		await local.vault.write('note.md', textToBytes('one\n'));
		await local.engine.pushAll();
		await local.vault.write('note.md', textToBytes('rewritten\n'));
		await local.engine.pushAll();

		const page = await local.history.list('note.md');
		const copy = await local.history.restoreAsCopy({
			path: 'note.md',
			fileId: page.fileId,
			entry: entryAt(page.entries, 1),
		});

		expect(bytesToText(await local.vault.read('note.md'))).toBe('rewritten\n');
		expect(bytesToText(await local.vault.read(copy.copyPath))).toBe('one\n');
		expect(copy.copyPath).toMatch(/^note \(restored .+\)\.md$/);
	});

	test('lists history for a file the local index has forgotten', async () => {
		const local = await device('device-1', 'Studio Mac');
		await local.vault.write('note.md', textToBytes('one\n'));
		await local.engine.pushAll();
		local.index.delete('note.md');

		const page = await local.history.list('note.md');

		expect(page.entries).toHaveLength(1);
		expect(entryAt(page.entries, 0).isCurrent).toBe(false);
	});

	test('surfaces a pruned version as unavailable rather than a raw 404', async () => {
		const local = await device('device-1', 'Studio Mac');
		await local.vault.write('note.md', textToBytes('one\n'));
		await local.engine.pushAll();

		const page = await local.history.list('note.md');
		server.blobs.clear();

		await expect(local.history.read(page.fileId, entryAt(page.entries, 0))).rejects.toBeInstanceOf(
			VersionContentUnavailableError,
		);
	});

	test('marks a version whose meta will not decrypt as unreadable', async () => {
		const local = await device('device-1', 'Studio Mac');
		await local.vault.write('note.md', textToBytes('one\n'));
		await local.engine.pushAll();

		const fileId = await computeFileId(keys.nameMacKey, 'note.md');
		const stored = [...server.versions.values()].find((version) => version.fileId === fileId);
		if (stored === undefined) {
			throw new Error('expected a stored version');
		}
		stored.metaBlob = Buffer.from('not a meta envelope').toString('base64');

		const page = await local.history.list('note.md');
		const unreadable = entryAt(page.entries, 0);

		expect(unreadable.readable).toBe(false);
		await expect(
			local.history.restore({ path: 'note.md', fileId, entry: unreadable }),
		).rejects.toBeInstanceOf(VersionUnreadableError);
	});
});

import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import {
	type Device,
	type DeviceOverrides,
	fullSelective,
	makeDevice,
} from '../testing/devices.js';
import { FakeServer } from '../testing/fake-server.js';
import { ApiClient } from '../transport/client.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

async function device(deviceId: string, overrides?: DeviceOverrides): Promise<Device> {
	return makeDevice({ server, keys, client }, deviceId, overrides);
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});

describe('full reconcile', () => {
	// The recovery case reconcile exists for: state directory wiped, files intact.
	// Every file looks changed with no known ancestor, which is the conflict-copy
	// path — unless identical bytes are adopted first.
	test('a device that lost its index adopts its files instead of duplicating them', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();
		expect(phone.index.entries()).toHaveLength(2);

		const amnesiac = await device('phone', { vault: phone.vault });
		const summary = await amnesiac.engine.reconcile();

		expect(summary.pulled).toBe(2);
		expect(amnesiac.conflicts).toEqual([]);
		expect((await amnesiac.vault.list()).map((file) => file.path).sort()).toEqual(['a.md', 'b.md']);
		expect(amnesiac.index.entries()).toHaveLength(2);
	});

	test('a file created while the device was terminated arrives', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('first.md', 'one\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		laptop.vault.putText('second.md', 'two\n');
		await laptop.engine.pushAll();

		// The cursor jumped the change: a crash between applying a batch and persisting
		// it, or a change log the server has since pruned.
		phone.local.setCursor(server.log.length);
		await phone.engine.pullAll();
		expect(await phone.vault.exists('second.md')).toBe(false);

		await phone.engine.reconcile();
		expect(phone.vault.getText('second.md')).toBe('two\n');
	});

	test('a remote delete the change log no longer covers is applied', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('gone.md', 'bye\n');
		laptop.vault.putText('stay.md', 'here\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		await laptop.vault.remove('gone.md');
		laptop.queue.enqueue('gone.md', 'delete');
		await laptop.engine.pushAll();

		phone.local.setCursor(server.log.length);
		await phone.engine.pullAll();
		expect(await phone.vault.exists('gone.md')).toBe(true);

		const summary = await phone.engine.reconcile();
		expect(summary.removed).toBe(1);
		expect(await phone.vault.exists('gone.md')).toBe(false);
		expect(phone.vault.getText('stay.md')).toBe('here\n');
	});

	// §8: deletion never beats an edit, on the reconcile path as on the pull path.
	test('a locally edited file is kept when the server no longer holds it', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('note.md', 'original\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();
		phone.vault.putText('note.md', 'edited on the phone\n');

		await laptop.vault.remove('note.md');
		laptop.queue.enqueue('note.md', 'delete');
		await laptop.engine.pushAll();

		phone.local.setCursor(server.log.length);
		await phone.engine.reconcile();

		expect(phone.vault.getText('note.md')).toBe('edited on the phone\n');
		await phone.engine.pushAll();
		await laptop.engine.pullAll();
		expect(laptop.vault.getText('note.md')).toBe('edited on the phone\n');
	});

	test('an empty server listing never trashes a populated vault', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		await laptop.engine.pushAll();

		server.files.clear();
		const summary = await laptop.engine.reconcile();

		expect(summary.massDeleteGuarded).toBe(true);
		expect(summary.removed).toBe(0);
		expect(await laptop.vault.exists('a.md')).toBe(true);
		expect(laptop.index.entries()).toHaveLength(2);
	});

	test('the cursor adopts the snapshot sequence and is never lowered', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		expect(phone.local.getCursor()).toBe(0);
		await phone.engine.reconcile();
		expect(phone.local.getCursor()).toBe(server.log.length);

		const ahead = server.log.length + 5;
		phone.local.setCursor(ahead);
		await phone.engine.reconcile();
		expect(phone.local.getCursor()).toBe(ahead);
	});

	test('a remote file past the size limit is skipped rather than pulled', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('big.md', 'x'.repeat(4096));
		await laptop.engine.pushAll();

		const phone = await device('phone', {
			selective: { ...fullSelective, maxFileBytes: 1024 },
		});
		const summary = await phone.engine.reconcile();

		expect(summary.skippedOversize).toBe(1);
		expect(summary.pulled).toBe(0);
		expect(await phone.vault.exists('big.md')).toBe(false);
	});

	test('a settled vault reconciles without fetching a single blob', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		server.requests.length = 0;
		const summary = await phone.engine.reconcile();

		expect(summary.pulled).toBe(0);
		expect(server.requests.filter((entry) => entry.includes('/blobs/'))).toEqual([]);
		expect(server.requests.filter((entry) => entry.endsWith('/state'))).toHaveLength(1);
	});
});

describe('a file this device will not pull', () => {
	// Reconcile skips an oversized file but the incremental path has no size limit, so the
	// cursor is the only thing keeping that change reachable. Adopting the snapshot seq
	// here used to strand the file on this device until someone edited it again elsewhere.
	test('leaves the cursor behind the change that would deliver it', async () => {
		const seed = await device('seed');
		seed.vault.putText('big.md', 'x'.repeat(2000));
		await seed.engine.pushAll();

		const laptop = await device('laptop', {
			selective: { ...fullSelective, maxFileBytes: 100 },
		});
		const summary = await laptop.engine.reconcile();
		expect(summary.skippedOversize).toBe(1);
		expect(await laptop.vault.exists('big.md')).toBe(false);

		await laptop.engine.pullAll();
		expect(laptop.vault.getText('big.md')).toBe('x'.repeat(2000));
	});
});

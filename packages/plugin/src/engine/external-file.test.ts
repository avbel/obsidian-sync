import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { computeFileId } from '../crypto/identity.js';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { fullSelective, makeDevice } from '../testing/devices.js';
import { FakeServer } from '../testing/fake-server.js';
import { MemoryVault } from '../testing/memory-fixtures.js';
import { ApiClient } from '../transport/client.js';
import { encodeFile } from './codec.js';
import { isPathIncluded } from './selective.js';
import type { WriteOptions } from './vault.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');
// Obsidian 1.15's "Open file from outside the vault" lists the file under this path.
const externalPath = 'file:/Users/someone/Projects/app/docs/DEPLOYMENT.md';

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

/** Obsidian on iOS refuses a `:` in a file name, so the external path cannot be created there. */
class PhoneVault extends MemoryVault {
	override async write(path: string, data: Uint8Array, options?: WriteOptions): Promise<void> {
		if (path.includes(':')) {
			throw new Error(
				'File name cannot contain any of the following characters: * " \\ / < > : | ?',
			);
		}
		return super.write(path, data, options);
	}
}

/** A commit from a desktop build that predates the filter, which is how the live server got one. */
async function commitAsOldClient(path: string, text: string): Promise<void> {
	const encoded = await encodeFile(keys, {
		path,
		data: new TextEncoder().encode(text),
		mtime: Date.now(),
		ctime: Date.now(),
		mime: 'text/markdown',
		deviceLabel: 'old desktop',
		compress: false,
	});
	for (const chunk of encoded.chunks) {
		await client.putBlob(server.vaultId, chunk.address, chunk.blob);
	}
	await client.commit(server.vaultId, encoded.fileId, {
		chunks: encoded.chunks.map((chunk) => chunk.address),
		metaBlob: encoded.metaBlob,
		size: encoded.size,
		deviceId: 'old-desktop',
	});
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});

describe('files opened from outside the vault', () => {
	test('are never synced, on any platform', () => {
		expect(isPathIncluded(externalPath, fullSelective)).toBe(false);
		expect(isPathIncluded('file:C:/Users/someone/notes.md', fullSelective)).toBe(false);
		expect(isPathIncluded('file-notes/a.md', fullSelective)).toBe(true);
		expect(isPathIncluded('notes/file:.md', fullSelective)).toBe(true);
	});

	test('a desktop does not upload one', async () => {
		const laptop = await makeDevice({ server, keys, client }, 'laptop');
		laptop.vault.putText(externalPath, '# deploy\n');
		laptop.vault.putText('note.md', 'mine\n');
		await laptop.engine.pushAll();

		expect(server.headOf(await computeFileId(keys.nameMacKey, externalPath))).toBeUndefined();
		expect(server.headOf(await computeFileId(keys.nameMacKey, 'note.md'))).toBeDefined();
		expect(laptop.queue.all()).toEqual([]);
	});

	// The live failure: one unwritable path aborted every reconcile, so the phone never
	// got past it and nothing committed after it ever arrived.
	test('one already on the server does not wedge a phone reconcile', async () => {
		await commitAsOldClient(externalPath, '# deploy\n');
		const laptop = await makeDevice({ server, keys, client }, 'laptop');
		laptop.vault.putText('later.md', 'after\n');
		await laptop.engine.pushAll();

		const phone = await makeDevice({ server, keys, client }, 'phone', { vault: new PhoneVault() });
		await phone.engine.reconcile();

		expect(phone.vault.getText('later.md')).toBe('after\n');
		expect(await phone.vault.exists(externalPath)).toBe(false);
		expect(phone.local.getCursor()).toBe(server.log.length);
	});

	test('one already on the server does not wedge a phone pull', async () => {
		await commitAsOldClient(externalPath, '# deploy\n');
		const laptop = await makeDevice({ server, keys, client }, 'laptop');
		laptop.vault.putText('later.md', 'after\n');
		await laptop.engine.pushAll();

		const phone = await makeDevice({ server, keys, client }, 'phone', { vault: new PhoneVault() });
		await phone.engine.pullAll();

		expect(phone.vault.getText('later.md')).toBe('after\n');
		expect(phone.local.getCursor()).toBe(server.log.length);
	});
});

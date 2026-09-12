import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { computeFileId } from '../crypto/identity.js';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { decryptFileMeta } from '../crypto/meta.js';
import { type Device, makeDevice } from '../testing/devices.js';
import { FakeServer } from '../testing/fake-server.js';
import { ApiClient } from '../transport/client.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');
const compressible = '# Note\n\nthe same sentence, over and over. '.repeat(80);

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

async function device(deviceId: string, compressUploads: boolean): Promise<Device> {
	return makeDevice({ server, keys, client }, deviceId, { compressUploads });
}

/** The meta as the server holds it, decrypted the way any client would. */
async function committedMeta(path: string) {
	const fileId = await computeFileId(keys.nameMacKey, path);
	const head = server.headOf(fileId);
	const stored = server.versions.get(head as string);
	return decryptFileMeta(keys.contentCryptoKey, fileId, (stored as { metaBlob: string }).metaBlob);
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});

describe('compressed uploads', () => {
	// The whole compatibility story: a reader must not care what the writer chose.
	test('a device that does not compress still reads a compressed note', async () => {
		const writer = await device('writer', true);
		writer.vault.putText('note.md', compressible);
		await writer.engine.pushAll();

		const reader = await device('reader', false);
		await reader.engine.pullAll();

		expect(reader.vault.getText('note.md')).toBe(compressible);
	});

	test('compressing actually shrinks what the server stores', async () => {
		// One file, two isolated servers. Pushing the same bytes to one server twice would
		// prove nothing: chunks are content-addressed, so the second push stores nothing at
		// all and the comparison passes whether or not anything was ever compressed.
		async function storedFor(compressUploads: boolean): Promise<number> {
			const isolated = new FakeServer();
			const writer = await makeDevice(
				{ server: isolated, keys, client: new ApiClient(isolated) },
				'writer',
				{ compressUploads },
			);
			writer.vault.putText('note.md', compressible);
			await writer.engine.pushAll();
			return [...isolated.blobs.values()].reduce((total, blob) => total + blob.byteLength, 0);
		}

		const packed = await storedFor(true);
		const plain = await storedFor(false);

		expect(packed).toBeLessThan(plain / 2);
	});

	test('records the format in the meta, where only a key holder can read it', async () => {
		const writer = await device('writer', true);
		writer.vault.putText('note.md', compressible);
		await writer.engine.pushAll();

		expect((await committedMeta('note.md')).compression).toBe('deflate-raw');
	});

	// Already-compressed attachments grow; storing the larger result would be a net loss.
	test('leaves incompressible bytes alone and says so', async () => {
		const writer = await device('writer', true);
		const noise = crypto.getRandomValues(new Uint8Array(4096));
		await writer.vault.write('random.bin', noise);
		await writer.engine.pushAll();

		const meta = await committedMeta('random.bin');
		expect(meta.compression).toBeUndefined();
		expect(meta.size).toBe(4096);
	});

	// maxFileBytes is a user-facing limit; it must not change meaning because a file packed well.
	test('reports the plaintext size, not the compressed size', async () => {
		const writer = await device('writer', true);
		writer.vault.putText('note.md', compressible);
		await writer.engine.pushAll();

		const meta = await committedMeta('note.md');
		expect(meta.size).toBe(new TextEncoder().encode(compressible).byteLength);
	});

	test('a note written uncompressed is still readable by a compressing device', async () => {
		const plain = await device('plain', false);
		plain.vault.putText('note.md', compressible);
		await plain.engine.pushAll();

		const packed = await device('packed', true);
		await packed.engine.pullAll();

		expect(packed.vault.getText('note.md')).toBe(compressible);
	});
});

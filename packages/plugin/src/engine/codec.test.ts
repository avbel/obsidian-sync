import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { compress } from '../crypto/compress.js';
import { blobAddress, encryptChunkBlob } from '../crypto/content.js';
import { textToBytes } from '../crypto/encoding.js';
import { computeFileId, encryptPath } from '../crypto/identity.js';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { encryptFileMeta, type FileMeta } from '../crypto/meta.js';
import { decodeFile } from './codec.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');
let keys: PurposeKeys;

beforeEach(async () => {
	keys = await derivePurposeKeys('passphrase', salt16);
});

/** Seals one version by hand, so the read path can be tested without the write path. */
async function seal(
	path: string,
	body: Uint8Array,
	compression: FileMeta['compression'],
): Promise<{ fileId: string; metaBlob: string; blobs: Map<string, Uint8Array> }> {
	const fileId = await computeFileId(keys.nameMacKey, path);
	const address = await blobAddress(keys.contentMacKey, body);
	const blobs = new Map([
		[address, await encryptChunkBlob(keys.contentCryptoKey, keys.contentMacKey, body)],
	]);
	const meta: FileMeta = {
		encryptedPath: await encryptPath(keys.pathCryptoKey, path),
		mtime: 1,
		ctime: 1,
		mime: 'text/markdown',
		size: body.byteLength,
		chunks: [address],
		...(compression === undefined ? {} : { compression }),
	};
	return { fileId, metaBlob: await encryptFileMeta(keys.contentCryptoKey, fileId, meta), blobs };
}

describe('decodeFile', () => {
	test('inflates a version whose meta says it was compressed', async () => {
		const original = textToBytes('# Note\n\nrepeating prose. '.repeat(200));
		const packed = await compress(original);
		const { fileId, metaBlob, blobs } = await seal('note.md', packed as Uint8Array, 'deflate-raw');

		const decoded = await decodeFile(
			keys,
			fileId,
			metaBlob,
			async (a) => blobs.get(a) as Uint8Array,
		);

		expect(decoded.data).toEqual(original);
	});

	// Every version in an existing vault predates the field; they must read untouched.
	test('returns a version with no compression field exactly as stored', async () => {
		const original = textToBytes('plain bytes, never packed\n');
		const { fileId, metaBlob, blobs } = await seal('plain.md', original, undefined);

		const decoded = await decodeFile(
			keys,
			fileId,
			metaBlob,
			async (a) => blobs.get(a) as Uint8Array,
		);

		expect(decoded.data).toEqual(original);
		expect(decoded.meta.compression).toBeUndefined();
	});
});

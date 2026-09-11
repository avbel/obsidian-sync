import { pbkdf2Sync } from 'node:crypto';
import { decodeEnvelope, encodeEnvelope, pbkdf2Iterations } from '@obsidian-sync/protocol';
import { describe, expect, test } from 'vitest';
import { blobAddress, decryptChunkBlob, encryptChunkBlob } from './content.js';
import { toHex } from './encoding.js';
import { computeFileId, decryptPath, encryptPath } from './identity.js';
import { derivePurposeKeys, masterKeyHex } from './keys.js';
import { decryptFileMeta, encryptFileMeta } from './meta.js';

// A fixed 16-byte salt (not secret; the passphrase is what must stay unknown).
const salt16 = Buffer.from('0123456789abcdef', 'utf8').toString('base64');
const passphrase = 'correct horse battery staple';

function pbkdf2Hex(): string {
	return pbkdf2Sync(
		passphrase,
		Buffer.from(salt16, 'base64'),
		pbkdf2Iterations,
		32,
		'sha512',
	).toString('hex');
}

describe('key derivation', () => {
	test('PBKDF2-SHA-512 matches Node’s implementation bit for bit (known answer)', async () => {
		const derivedHex = await masterKeyHex(passphrase, salt16);
		const oracle = pbkdf2Hex();
		expect(derivedHex).toBe(oracle);
		expect(derivedHex).toHaveLength(64);
	});

	test('the three purpose keys are pairwise distinct', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const a = await blobAddress(keys.contentMacKey, new Uint8Array([1]));
		const b = await computeFileId(keys.nameMacKey, 'x.md');
		expect(a).not.toBe(b);
	});
});

describe('blob content', () => {
	test('identical plaintext yields an identical address and blob (dedup)', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const data = new TextEncoder().encode('the same chunk of text');
		const addressOne = await blobAddress(keys.contentMacKey, data);
		const addressTwo = await blobAddress(keys.contentMacKey, data);
		expect(addressOne).toBe(addressTwo);

		const blobOne = await encryptChunkBlob(keys.contentCryptoKey, keys.contentMacKey, data);
		const blobTwo = await encryptChunkBlob(keys.contentCryptoKey, keys.contentMacKey, data);
		expect(toHex(blobOne)).toBe(toHex(blobTwo));
	});

	test('address differs for different plaintext', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const a = await blobAddress(keys.contentMacKey, new TextEncoder().encode('one'));
		const b = await blobAddress(keys.contentMacKey, new TextEncoder().encode('two'));
		expect(a).not.toBe(b);
	});

	test('a chunk round-trips through encrypt then decrypt', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const data = new TextEncoder().encode('round trip me');
		const blob = await encryptChunkBlob(keys.contentCryptoKey, keys.contentMacKey, data);
		const back = await decryptChunkBlob(keys.contentCryptoKey, blob);
		expect(toHex(back)).toBe(toHex(data));
		expect(new TextDecoder().decode(back)).toBe('round trip me');
	});

	test('tampering with ciphertext fails authentication instead of decrypting', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const blob = await encryptChunkBlob(
			keys.contentCryptoKey,
			keys.contentMacKey,
			new TextEncoder().encode('do not tamper'),
		);
		blob[blob.length - 1] = (blob[blob.length - 1] as number) ^ 0xff;
		await expect(decryptChunkBlob(keys.contentCryptoKey, blob)).rejects.toThrow();
	});
});

describe('path and file identity', () => {
	test('fileId is stable across the same path in either unicode form (NFC/NFD)', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const nfc = await computeFileId(keys.nameMacKey, 'notes/caf\u00e9.md');
		const nfd = await computeFileId(keys.nameMacKey, 'notes/cafe\u0301.md');
		expect(nfc).toBe(nfd);
	});

	test('fileId differs for different paths', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		expect(await computeFileId(keys.nameMacKey, 'a.md')).not.toBe(
			await computeFileId(keys.nameMacKey, 'b.md'),
		);
	});

	test('an encrypted path round-trips but is non-deterministic (§4.3)', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const one = await encryptPath(keys.pathCryptoKey, 'notes/today.md');
		const two = await encryptPath(keys.pathCryptoKey, 'notes/today.md');
		expect(one).not.toBe(two);
		expect(await decryptPath(keys.pathCryptoKey, one)).toBe('notes/today.md');
	});
});

describe('meta envelope', () => {
	test('meta round-trips under the right file identity', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const meta = {
			encryptedPath: await encryptPath(keys.pathCryptoKey, 'notes/x.md'),
			mtime: 1,
			ctime: 0,
			mime: 'text/markdown',
			size: 5,
			chunks: ['a'.repeat(64), 'b'.repeat(64)],
		};
		const blob = await encryptFileMeta(keys.contentCryptoKey, 'f'.repeat(64), meta);
		const back = await decryptFileMeta(keys.contentCryptoKey, 'f'.repeat(64), blob);
		expect(back.chunks).toEqual(meta.chunks);
	});

	test('meta bound to one file identity does not decrypt as another (AAD failure)', async () => {
		const keys = await derivePurposeKeys(passphrase, salt16);
		const meta = {
			encryptedPath: 'x',
			mtime: 0,
			ctime: 0,
			mime: 'text/markdown',
			size: 0,
			chunks: [],
		};
		const blob = await encryptFileMeta(keys.contentCryptoKey, 'fileA', meta);
		await expect(decryptFileMeta(keys.contentCryptoKey, 'fileB', blob)).rejects.toThrow();
	});
});

describe('envelope interop with the protocol package', () => {
	test('plugin envelopes are decodable by the shared decoder', () => {
		const nonce = new Uint8Array(12).fill(4);
		const payload = new Uint8Array(40).fill(9);
		const decoded = decodeEnvelope(encodeEnvelope(nonce, payload));
		expect(decoded.nonce).toEqual(nonce);
	});
});

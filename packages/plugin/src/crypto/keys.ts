import { keyBytes, pbkdf2Iterations } from '@obsidian-sync/protocol';
import { asBuffer, fromBase64, textToBytes, toHex } from './encoding.js';

/**
 * The purpose keys, each imported into only the algorithm(s) it is actually used
 * for. K_content is deliberately split into an AES-GCM form (encrypt/decrypt) and
 * an HMAC form (blob addressing) because WebCrypto keys are algorithm-specific,
 * even though both wrap the same 32 bytes of secret material (§4.4 uses K_content
 * for both). The raw material never outlives the import, so no key is extractable.
 */
export interface PurposeKeys {
	readonly contentCryptoKey: CryptoKey;
	readonly contentMacKey: CryptoKey;
	readonly pathCryptoKey: CryptoKey;
	readonly nameMacKey: CryptoKey;
}

const hkdfInfoPrefix = 'obsidian-sync/v1/';

async function deriveMasterBits(passphrase: string, salt: Uint8Array): Promise<ArrayBuffer> {
	const baseKey = await crypto.subtle.importKey(
		'raw',
		asBuffer(textToBytes(passphrase)),
		'PBKDF2',
		false,
		['deriveBits'],
	);
	return crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: asBuffer(salt), iterations: pbkdf2Iterations, hash: 'SHA-512' },
		baseKey,
		keyBytes * 8,
	);
}

async function derivePurposeBits(master: ArrayBuffer, purpose: string): Promise<ArrayBuffer> {
	const masterKey = await crypto.subtle.importKey('raw', master, { name: 'HKDF' }, false, [
		'deriveBits',
	]);
	return crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: asBuffer(new Uint8Array(0)),
			info: asBuffer(textToBytes(hkdfInfoPrefix + purpose)),
		},
		masterKey,
		keyBytes * 8,
	);
}

async function importAesGcm(bits: ArrayBuffer): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function importHmac(bits: ArrayBuffer): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify',
	]);
}

/**
 * Derive the four key handles from a passphrase and the vault's base64 KDF salt.
 *
 * HKDF info is prefixed and versioned so one purpose's material can never be fed
 * into another's context and a future key-scheme change is a new prefix, not a
 * silent collision (spec Decision D1's versioning promise).
 */
export async function derivePurposeKeys(
	passphrase: string,
	saltBase64: string,
): Promise<PurposeKeys> {
	const master = await deriveMasterBits(passphrase, fromBase64(saltBase64));
	const contentBits = await derivePurposeBits(master, 'content');
	const pathBits = await derivePurposeBits(master, 'path');
	const nameBits = await derivePurposeBits(master, 'name');

	return {
		contentCryptoKey: await importAesGcm(contentBits),
		contentMacKey: await importHmac(contentBits),
		pathCryptoKey: await importAesGcm(pathBits),
		nameMacKey: await importHmac(nameBits),
	};
}

/** Test seam: the raw master PBKDF2 output as hex, for a known-answer check. */
export async function masterKeyHex(passphrase: string, saltBase64: string): Promise<string> {
	return toHex(new Uint8Array(await deriveMasterBits(passphrase, fromBase64(saltBase64))));
}

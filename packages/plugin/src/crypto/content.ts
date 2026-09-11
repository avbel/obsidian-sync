import { decodeEnvelope, encodeEnvelope, nonceBytes } from '@obsidian-sync/protocol';
import { asBuffer, toHex } from './encoding.js';

/**
 * The reconciliation of spec §4.4, agreed for this implementation:
 *
 * A per-chunk AAD carrying fileId/versionId/chunkIndex cannot coexist with a
 * plaintext-addressed store, because one shared blob would then need one
 * ciphertext per (file, version, index) triple that references the same
 * plaintext. The nonce is instead derived deterministically from the plaintext,
 * which both makes the stored blob a pure function of its content (so dedup and
 * version-history sharing work) and keeps position integrity at the version
 * layer, where it is actually verifiable — see meta.ts, which commits the ordered
 * address list encrypted and authenticated under the content key.
 */

// A prefix byte separates the two HMAC derivations so a blob address can never
// collide with a nonce value even though both key off the same plaintext.
const addressDomain = 0x01;
const nonceDomain = 0x02;

async function hmacHex(macKey: CryptoKey, domain: number, data: Uint8Array): Promise<string> {
	const input = new Uint8Array(data.length + 1);
	input[0] = domain;
	input.set(data, 1);
	const signature = await crypto.subtle.sign('HMAC', macKey, asBuffer(input));
	return toHex(new Uint8Array(signature));
}

/** blobAddress = HMAC-SHA-256(K_content, 0x01 || plaintext), hex. */
export function blobAddress(macKey: CryptoKey, plaintext: Uint8Array): Promise<string> {
	return hmacHex(macKey, addressDomain, plaintext);
}

async function deriveNonce(macKey: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
	const hex = await hmacHex(macKey, nonceDomain, plaintext);
	const nonce = new Uint8Array(nonceBytes);
	for (let index = 0; index < nonceBytes; index += 1) {
		nonce[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return nonce;
}

/** Encrypt one plaintext chunk to its stored envelope bytes. */
export async function encryptChunkBlob(
	cryptoKey: CryptoKey,
	macKey: CryptoKey,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	const nonce = await deriveNonce(macKey, plaintext);
	const ciphertextWithTag = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: asBuffer(nonce) },
		cryptoKey,
		asBuffer(plaintext),
	);
	return encodeEnvelope(nonce, new Uint8Array(ciphertextWithTag));
}

/**
 * Decrypt a stored chunk. AES-GCM authentication is the integrity gate: a blob
 * that is not the exact ciphertext for this plaintext under this key will not
 * decrypt, so a spliced or reordered chunk surfaces here (or at the address check
 * in the pull path) rather than as corrupt vault bytes.
 */
export async function decryptChunkBlob(
	cryptoKey: CryptoKey,
	blob: Uint8Array,
): Promise<Uint8Array> {
	const { nonce, ciphertextWithTag } = decodeEnvelope(blob);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: asBuffer(nonce) },
		cryptoKey,
		asBuffer(ciphertextWithTag),
	);
	return new Uint8Array(plaintext);
}

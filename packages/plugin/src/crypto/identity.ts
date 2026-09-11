import { decodeEnvelope, encodeEnvelope, normalisePath } from '@obsidian-sync/protocol';
import { asBuffer, bytesToText, fromBase64, textToBytes, toBase64, toHex } from './encoding.js';

/**
 * fileId = HMAC-SHA-256(K_name, normalised_path), hex (§4.2).
 *
 * Deterministic, so every device independently derives the same identifier for a
 * path and the server can key records without ever learning the path. The
 * normalisation is folded in here so no call site can forget it and mint a second
 * identity for an NFD-equivalent filename.
 */
export async function computeFileId(nameMacKey: CryptoKey, rawPath: string): Promise<string> {
	const path = asBuffer(textToBytes(normalisePath(rawPath)));
	const signature = await crypto.subtle.sign('HMAC', nameMacKey, path);
	return toHex(new Uint8Array(signature));
}

/**
 * encryptedPath = AES-256-GCM(K_path, randomNonce, normalised_path) (§4.3), base64.
 * Non-determinism is intended: this is cargo the client decrypts, not an index key.
 */
export async function encryptPath(pathCryptoKey: CryptoKey, rawPath: string): Promise<string> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const bytes = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: asBuffer(nonce) },
		pathCryptoKey,
		asBuffer(textToBytes(normalisePath(rawPath))),
	);
	return toBase64(encodeEnvelope(nonce, new Uint8Array(bytes)));
}

export async function decryptPath(
	pathCryptoKey: CryptoKey,
	encryptedBase64: string,
): Promise<string> {
	const { nonce, ciphertextWithTag } = decodeEnvelope(fromBase64(encryptedBase64));
	const bytes = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: asBuffer(nonce) },
		pathCryptoKey,
		asBuffer(ciphertextWithTag),
	);
	return bytesToText(new Uint8Array(bytes));
}

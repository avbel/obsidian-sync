import { decodeEnvelope, encodeEnvelope } from '@obsidian-sync/protocol';
import {
	asBuffer,
	bytesToText,
	concatBytes,
	fromBase64,
	textToBytes,
	toBase64,
} from './encoding.js';

/**
 * The per-version metadata the plugin round-trips through the server's opaque
 * `meta_blob` column (§5.2). The server stores and returns it untouched; only a
 * holder of K_content can read it.
 */
export interface FileMeta {
	/** The AES-GCM-encrypted path (§4.3), so the record stays even if the plaintext path is sensitive. */
	encryptedPath: string;
	mtime: number;
	ctime: number;
	mime: string;
	/** Plaintext byte size. */
	size: number;
	/** Ordered blob addresses; the authoritative version-graph position (§4.4 reconciliation). */
	chunks: string[];
}

function aadForFile(fileId: string): Uint8Array {
	return textToBytes(`meta\u0000${fileId}`);
}

/**
 * Encrypt metadata under K_content with AAD = fileId. The AAD is what binds a
 * metadata record to its file identity, so a compromised server cannot relabel
 * one file's ordered-chunk list as another file's without the decrypt failing.
 */
export async function encryptFileMeta(
	contentCryptoKey: CryptoKey,
	fileId: string,
	meta: FileMeta,
): Promise<string> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = asBuffer(textToBytes(JSON.stringify(meta)));
	const ciphertextWithTag = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(aadForFile(fileId)) },
		contentCryptoKey,
		plaintext,
	);
	return toBase64(encodeEnvelope(nonce, new Uint8Array(ciphertextWithTag)));
}

export async function decryptFileMeta(
	contentCryptoKey: CryptoKey,
	fileId: string,
	metaBlobBase64: string,
): Promise<FileMeta> {
	const { nonce, ciphertextWithTag } = decodeEnvelope(fromBase64(metaBlobBase64));
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(aadForFile(fileId)) },
		contentCryptoKey,
		asBuffer(ciphertextWithTag),
	);
	return JSON.parse(bytesToText(new Uint8Array(plaintext))) as FileMeta;
}

/** Concatenate decrypted chunk plaintexts back into the file's bytes. */
export function joinChunks(chunks: Uint8Array[]): Uint8Array {
	return concatBytes(chunks);
}

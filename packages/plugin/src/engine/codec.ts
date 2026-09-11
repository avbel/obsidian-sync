import { splitChunks } from '../crypto/chunk.js';
import { blobAddress, decryptChunkBlob, encryptChunkBlob } from '../crypto/content.js';
import { hashBytes } from '../crypto/encoding.js';
import { computeFileId, decryptPath, encryptPath } from '../crypto/identity.js';
import type { PurposeKeys } from '../crypto/keys.js';
import { decryptFileMeta, encryptFileMeta, type FileMeta, joinChunks } from '../crypto/meta.js';

export interface EncodedChunk {
	address: string;
	/** Envelope bytes the server stores verbatim; never plaintext. */
	blob: Uint8Array;
}

export interface EncodedFile {
	fileId: string;
	/** Content hashes to upload; the plaintext is never sent. */
	chunks: EncodedChunk[];
	/** Base64 of the encrypted meta envelope (§5.2). */
	metaBlob: string;
	size: number;
}

export interface EncodeFileOptions {
	path: string;
	data: Uint8Array;
	mtime: number;
	ctime: number;
	mime: string;
	deviceLabel: string;
}

/**
 * Turn local file bytes into everything needed for a commit: identity, encrypted
 * and content-addressed chunks, and the authenticated meta (path + ordered address
 * list). Order is bound here, inside the meta, not per-chunk — see content.ts for
 * why the per-chunk AAD from §4.4 was relocated to the version layer.
 */
export async function encodeFile(
	keys: PurposeKeys,
	options: EncodeFileOptions,
): Promise<EncodedFile> {
	const fileId = await computeFileId(keys.nameMacKey, options.path);
	const encryptedPath = await encryptPath(keys.pathCryptoKey, options.path);

	const chunks: EncodedChunk[] = [];
	for (const chunk of splitChunks(options.data)) {
		chunks.push({
			address: await blobAddress(keys.contentMacKey, chunk),
			blob: await encryptChunkBlob(keys.contentCryptoKey, keys.contentMacKey, chunk),
		});
	}

	const meta: FileMeta = {
		encryptedPath,
		mtime: options.mtime,
		ctime: options.ctime,
		mime: options.mime,
		size: options.data.length,
		chunks: chunks.map((chunk) => chunk.address),
		deviceLabel: options.deviceLabel,
	};

	return {
		fileId,
		chunks,
		metaBlob: await encryptFileMeta(keys.contentCryptoKey, fileId, meta),
		size: options.data.length,
	};
}

export interface DecodedFile {
	path: string;
	meta: FileMeta;
	data: Uint8Array;
}

/**
 * Reassemble a file from its encrypted meta and ordered chunk blobs. Every chunk's
 * recomputed content address is checked against the address the authenticated meta
 * lists, so a server that spliced, reordered, or dropped a chunk is detected here
 * rather than surfacing as corrupt vault bytes (§4.6).
 */
export async function decodeFile(
	keys: PurposeKeys,
	fileId: string,
	metaBlob: string,
	blobFetcher: (address: string) => Promise<Uint8Array>,
): Promise<DecodedFile> {
	const meta = await decryptFileMeta(keys.contentCryptoKey, fileId, metaBlob);
	const path = await decryptPath(keys.pathCryptoKey, meta.encryptedPath);

	const pieces: Uint8Array[] = [];
	for (const address of meta.chunks) {
		const plaintext = await decryptChunkBlob(keys.contentCryptoKey, await blobFetcher(address));
		const recomputed = await blobAddress(keys.contentMacKey, plaintext);
		if (recomputed !== address) {
			throw new Error(`blob integrity check failed for ${path}`);
		}
		pieces.push(plaintext);
	}

	return { path, meta, data: joinChunks(pieces) };
}

export { hashBytes };

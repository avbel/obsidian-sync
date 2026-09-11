import { defaultChunkBytes } from '@obsidian-sync/protocol';

/**
 * Split a byte buffer into fixed-size chunks. A zero-byte file yields no chunks,
 * matching the protocol's "empty for a zero-byte file" contract.
 */
export function splitChunks(data: Uint8Array, chunkBytes = defaultChunkBytes): Uint8Array[] {
	if (data.length === 0) {
		return [];
	}

	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < data.length; offset += chunkBytes) {
		chunks.push(data.slice(offset, Math.min(offset + chunkBytes, data.length)));
	}
	return chunks;
}

/**
 * `deflate-raw` rather than gzip: the two tie once a file is more than a few KB, but
 * gzip's header, trailer and CRC cost about 18 bytes per file, and a note is usually a
 * few hundred bytes that gets re-uploaded whole on every edit because chunks are fixed
 * at 4 MB. Measured over the reference vault, deflate-raw reached 0.64 of the original
 * on files under 512 B where gzip managed only 0.72. Both are values of the same
 * platform API, so the better one costs nothing.
 */
const format = 'deflate-raw';

/** iOS before 16.4 has no CompressionStream, and such a device must still sync. */
export function isCompressionSupported(): boolean {
	return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function run(
	data: Uint8Array,
	stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
	const source = new Blob([data as BlobPart]).stream();
	return new Uint8Array(await new Response(source.pipeThrough(stream)).arrayBuffer());
}

/**
 * The compressed bytes, or undefined when compression does not pay for itself — which
 * covers both an already-compressed attachment and a note too short to beat the frame
 * overhead. The caller records which it got; nothing is inferred from the extension.
 */
export async function compress(data: Uint8Array): Promise<Uint8Array | undefined> {
	if (data.byteLength === 0 || !isCompressionSupported()) {
		return undefined;
	}
	const packed = await run(data, new CompressionStream(format));
	return packed.byteLength < data.byteLength ? packed : undefined;
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
	return run(data, new DecompressionStream(format));
}

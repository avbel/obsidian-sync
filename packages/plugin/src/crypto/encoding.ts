/**
 * Base64 <-> bytes helpers.
 *
 * Implemented without Buffer or btoa because the same module must run inside the
 * Obsidian mobile WebView (where the binary is an ArrayBuffer and neither is
 * guaranteed) and under Node in the test suite.
 */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let index = 0; index < bytes.length; index += 1) {
		binary += String.fromCharCode(bytes[index] as number);
	}
	return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function textToBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function bytesToText(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	return left.every((byte, index) => byte === right[index]);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

export function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}
	return out;
}

/** SHA-256 hex of a buffer; the cheap local "is this file dirty" check. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', asBuffer(bytes));
	return toHex(new Uint8Array(digest));
}

/**
 * Copy bytes into a buffer backed by a plain ArrayBuffer. WebCrypto's inputs are
 * typed BufferSource, and under the DOM lib an `ArrayBufferLike` view (which Node's
 * Uint8Array is) is not assignable — a fresh `Uint8Array<ArrayBuffer>` is. Every
 * WebCrypto argument in this package is routed through here.
 */
export function asBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	return copy;
}

export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

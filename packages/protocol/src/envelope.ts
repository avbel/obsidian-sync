import { nonceBytes, protocolVersion, tagBytes } from './constants.js';

export class EnvelopeFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EnvelopeFormatError';
	}
}

const versionOffset = 0;
const nonceOffset = 1;
const payloadOffset = nonceOffset + nonceBytes;

export const envelopeOverheadBytes = payloadOffset;

export function encodeEnvelope(nonce: Uint8Array, ciphertextWithTag: Uint8Array): Uint8Array {
	if (nonce.length !== nonceBytes) {
		throw new EnvelopeFormatError(`nonce must be ${nonceBytes} bytes, received ${nonce.length}`);
	}
	if (ciphertextWithTag.length < tagBytes) {
		throw new EnvelopeFormatError(
			`payload must include a ${tagBytes}-byte tag, received ${ciphertextWithTag.length} bytes`,
		);
	}

	const blob = new Uint8Array(payloadOffset + ciphertextWithTag.length);
	blob[versionOffset] = protocolVersion;
	blob.set(nonce, nonceOffset);
	blob.set(ciphertextWithTag, payloadOffset);
	return blob;
}

export function decodeEnvelope(blob: Uint8Array): {
	version: number;
	nonce: Uint8Array;
	ciphertextWithTag: Uint8Array;
} {
	if (blob.length < payloadOffset + tagBytes) {
		throw new EnvelopeFormatError(
			`blob must be at least ${payloadOffset + tagBytes} bytes, received ${blob.length}`,
		);
	}

	const version = blob[versionOffset] ?? 0;
	if (version !== protocolVersion) {
		throw new EnvelopeFormatError(`unsupported envelope version ${version}`);
	}

	// Copied rather than subarray'd so a later mutation of the source buffer
	// cannot silently corrupt an in-flight decryption.
	return {
		version,
		nonce: blob.slice(nonceOffset, payloadOffset),
		ciphertextWithTag: blob.slice(payloadOffset),
	};
}

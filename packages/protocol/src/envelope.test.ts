import { describe, expect, test } from 'vitest';
import { protocolVersion } from './constants.js';
import {
	decodeEnvelope,
	EnvelopeFormatError,
	encodeEnvelope,
	envelopeOverheadBytes,
} from './envelope.js';

function bytes(length: number, fill: number): Uint8Array {
	return new Uint8Array(length).fill(fill);
}

describe('encodeEnvelope', () => {
	test('prefixes the version byte and nonce', () => {
		const blob = encodeEnvelope(bytes(12, 7), bytes(20, 9));
		expect(blob[0]).toBe(protocolVersion);
		expect(blob.subarray(1, 13)).toEqual(bytes(12, 7));
		expect(blob.subarray(13)).toEqual(bytes(20, 9));
	});

	test('adds exactly the declared overhead', () => {
		const blob = encodeEnvelope(bytes(12, 0), bytes(100, 0));
		expect(blob.length).toBe(100 + envelopeOverheadBytes);
	});

	test('rejects a wrong-length nonce', () => {
		expect(() => encodeEnvelope(bytes(11, 0), bytes(20, 0))).toThrow(EnvelopeFormatError);
	});

	test('rejects a payload shorter than the GCM tag', () => {
		expect(() => encodeEnvelope(bytes(12, 0), bytes(15, 0))).toThrow(EnvelopeFormatError);
	});
});

describe('decodeEnvelope', () => {
	test('round-trips an encoded envelope', () => {
		const nonce = bytes(12, 3);
		const payload = bytes(64, 5);
		const decoded = decodeEnvelope(encodeEnvelope(nonce, payload));
		expect(decoded.version).toBe(protocolVersion);
		expect(decoded.nonce).toEqual(nonce);
		expect(decoded.ciphertextWithTag).toEqual(payload);
	});

	test('rejects a blob too short to contain a tag', () => {
		expect(() => decodeEnvelope(bytes(20, 0))).toThrow(EnvelopeFormatError);
	});

	test('rejects an unknown format version', () => {
		const blob = encodeEnvelope(bytes(12, 0), bytes(20, 0));
		blob[0] = 99;
		expect(() => decodeEnvelope(blob)).toThrow(/unsupported envelope version 99/);
	});

	test('returns views that do not alias mutable input', () => {
		const nonce = bytes(12, 1);
		const blob = encodeEnvelope(nonce, bytes(20, 2));
		const decoded = decodeEnvelope(blob);
		blob[1] = 200;
		expect(decoded.nonce[0]).toBe(1);
	});
});

import { describe, expect, test } from 'vitest';
import { compress, decompress, isCompressionSupported } from './compress.js';
import { textToBytes } from './encoding.js';

describe('compress', () => {
	test('round-trips text and actually shrinks it', async () => {
		const original = textToBytes('# Note\n\nSome prose that repeats. '.repeat(200));
		const packed = await compress(original);

		expect(packed).toBeDefined();
		expect((packed as Uint8Array).byteLength).toBeLessThan(original.byteLength / 2);
		expect(await decompress(packed as Uint8Array)).toEqual(original);
	});

	// 3 of 33 files in the reference vault did not shrink, and attachments never will.
	// Storing the larger result would make compression a net loss on exactly those files.
	test('declines when the result is not smaller', async () => {
		const incompressible = crypto.getRandomValues(new Uint8Array(4096));

		expect(await compress(incompressible)).toBeUndefined();
	});

	// A short note loses to the deflate frame overhead; the caller must store it as-is.
	test('declines input too short to beat the frame overhead', async () => {
		expect(await compress(textToBytes('hi'))).toBeUndefined();
	});

	test('declines an empty input rather than emitting a frame for nothing', async () => {
		expect(await compress(new Uint8Array(0))).toBeUndefined();
	});

	test('round-trips bytes that are not valid UTF-8', async () => {
		const original = new Uint8Array(2048);
		original.set([0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe]);
		const packed = await compress(original);

		expect(await decompress(packed as Uint8Array)).toEqual(original);
	});

	test('reports support, so an old WebView degrades instead of throwing', () => {
		expect(typeof isCompressionSupported()).toBe('boolean');
	});
});

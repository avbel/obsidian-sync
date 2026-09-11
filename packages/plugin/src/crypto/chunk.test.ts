import { defaultChunkBytes } from '@obsidian-sync/protocol';
import { describe, expect, test } from 'vitest';
import { splitChunks } from './chunk.js';

describe('splitChunks', () => {
	test('yields no chunks for empty input', () => {
		expect(splitChunks(new Uint8Array(0), 4)).toEqual([]);
	});

	test('splits on the boundary', () => {
		const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(splitChunks(data, 4).map((chunk) => [...chunk])).toEqual([
			[1, 2, 3, 4],
			[5, 6, 7, 8],
		]);
	});

	test('keeps the remainder', () => {
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		expect(splitChunks(data, 4).map((chunk) => [...chunk])).toEqual([[1, 2, 3, 4], [5]]);
	});

	test('a single chunk when under the size', () => {
		expect(splitChunks(new Uint8Array([1, 2, 3]))).toHaveLength(1);
	});

	test('the default size is 4 MiB', () => {
		expect(defaultChunkBytes).toBe(4 * 1024 * 1024);
	});
});

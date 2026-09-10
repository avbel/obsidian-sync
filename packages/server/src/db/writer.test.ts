import { describe, expect, test } from 'vitest';
import { SerialWriter } from './writer.js';

describe('SerialWriter', () => {
	test('returns the operation result', async () => {
		const writer = new SerialWriter();
		await expect(writer.run(() => 42)).resolves.toBe(42);
	});

	test('never overlaps two operations', async () => {
		const writer = new SerialWriter();
		let active = 0;
		let maximumActive = 0;

		const operation = () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			active -= 1;
			return undefined;
		};

		await Promise.all(Array.from({ length: 50 }, () => writer.run(operation)));
		expect(maximumActive).toBe(1);
	});

	test('preserves submission order', async () => {
		const writer = new SerialWriter();
		const order: number[] = [];
		await Promise.all(
			[1, 2, 3, 4, 5].map((value) =>
				writer.run(() => {
					order.push(value);
					return undefined;
				}),
			),
		);
		expect(order).toEqual([1, 2, 3, 4, 5]);
	});

	test('propagates a thrown error to that caller only', async () => {
		const writer = new SerialWriter();
		await expect(
			writer.run(() => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
	});

	// A rejected tail promise must not poison every later submission.
	test('keeps accepting work after a failure', async () => {
		const writer = new SerialWriter();
		await expect(
			writer.run(() => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		await expect(writer.run(() => 'still working')).resolves.toBe('still working');
	});
});

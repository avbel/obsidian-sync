import { describe, expect, test } from 'vitest';
import { type ApiClient, UnauthorizedError } from './client.js';
import { createLongPollSource } from './nudge.js';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function stubClient(changes: () => Promise<unknown>): ApiClient {
	return { changes } as unknown as ApiClient;
}

describe('createLongPollSource', () => {
	test('never starts a second nudge while the first is still running', async () => {
		let polls = 0;
		const client = stubClient(async () => {
			polls += 1;
			await delay(1);
			return { changes: [{ seq: 1 }], seq: 1, hasMore: false };
		});
		const source = createLongPollSource({
			client,
			vaultId: 'v1',
			waitSeconds: 0,
			getCursor: () => 0,
		});

		let running = 0;
		let concurrent = 0;
		let nudges = 0;
		source.start(async () => {
			running += 1;
			nudges += 1;
			concurrent = Math.max(concurrent, running);
			await delay(30);
			running -= 1;
		});

		await delay(200);
		source.stop();
		await delay(20);

		expect(concurrent).toBe(1);
		// Without the backoff a cursor that never advances re-polls at full speed.
		expect(nudges).toBeLessThan(5);
		expect(polls).toBeLessThan(5);
	});

	test('polls again promptly once the cursor advances', async () => {
		let cursor = 0;
		const client = stubClient(async () => {
			await delay(1);
			return { changes: [], seq: cursor, hasMore: false };
		});
		const source = createLongPollSource({
			client,
			vaultId: 'v1',
			waitSeconds: 0,
			getCursor: () => cursor,
		});

		let nudges = 0;
		source.start(() => {
			nudges += 1;
			cursor += 1;
		});

		await delay(100);
		source.stop();
		await delay(20);

		expect(nudges).toBeGreaterThan(3);
	});

	test('stops for good when the server rejects the credentials', async () => {
		let polls = 0;
		const client = stubClient(async () => {
			polls += 1;
			await delay(1);
			throw new UnauthorizedError();
		});

		let halted = false;
		const source = createLongPollSource({
			client,
			vaultId: 'v1',
			waitSeconds: 0,
			getCursor: () => 0,
			onUnauthorized: () => {
				halted = true;
			},
		});

		let nudges = 0;
		source.start(() => {
			nudges += 1;
		});

		await delay(100);
		source.stop();

		expect(halted).toBe(true);
		expect(polls).toBe(1);
		expect(nudges).toBe(0);
	});
});

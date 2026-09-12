import { describe, expect, test } from 'vitest';
import { MemoryStorage } from '../testing/memory-fixtures.js';
import { PendingQueue } from './pending-queue.js';

async function loaded(storage: MemoryStorage = new MemoryStorage()): Promise<PendingQueue> {
	const queue = new PendingQueue(storage);
	await queue.load();
	return queue;
}

describe('PendingQueue', () => {
	test('keeps only the latest intent for each path', async () => {
		const queue = await loaded();
		queue.enqueue('note.md', 'delete');
		queue.enqueue('note.md', 'upsert');
		expect(queue.ready(0, 'delete')).toEqual([]);
		expect(queue.ready(0, 'upsert').map((item) => item.path)).toEqual(['note.md']);
	});

	test('applies deletions before changes so a recreation wins', async () => {
		const queue = await loaded();
		queue.enqueueBatch({ changed: ['back.md'], deleted: ['back.md', 'gone.md'] });
		expect(queue.ready(0, 'upsert').map((item) => item.path)).toEqual(['back.md']);
		expect(queue.ready(0, 'delete').map((item) => item.path)).toEqual(['gone.md']);
	});

	test('honours item backoff and a queue-wide pause', async () => {
		const queue = await loaded();
		queue.enqueue('a.md', 'upsert');
		queue.fail('a.md', 5_000, 1_000, 'server refused');
		expect(queue.ready(5_999, 'upsert')).toEqual([]);
		expect(queue.ready(6_000, 'upsert')).toHaveLength(1);
		queue.pause(10_000);
		expect(queue.ready(9_999, 'upsert')).toEqual([]);
		queue.resume();
		expect(queue.ready(6_000, 'upsert')).toHaveLength(1);
	});

	test('parks blocked items but re-enqueueing unblocks them', async () => {
		const queue = await loaded();
		queue.enqueue('huge.bin', 'upsert');
		queue.block('huge.bin', 'oversize');
		expect(queue.depth()).toEqual({ upserts: 0, deletes: 0, blocked: 1 });
		expect(queue.blockedItems().map((item) => item.path)).toEqual(['huge.bin']);
		queue.enqueue('huge.bin', 'upsert');
		expect(queue.ready(0, 'upsert')).toHaveLength(1);
	});

	test('reports the earliest retry, ignoring blocked items', async () => {
		const queue = await loaded();
		queue.enqueue('a.md', 'upsert');
		queue.enqueue('b.md', 'upsert');
		queue.enqueue('c.md', 'upsert');
		queue.fail('a.md', 30_000, 1_000, 'nope');
		queue.fail('b.md', 10_000, 1_000, 'nope');
		queue.block('c.md', 'oversize');
		expect(queue.readyAt()).toBe(11_000);
	});

	test('persists attempts, pauses, and blocks across reload', async () => {
		const storage = new MemoryStorage();
		const first = await loaded(storage);
		first.enqueue('gone.md', 'delete');
		first.enqueue('big.bin', 'upsert');
		first.fail('gone.md', 20_000, 1_000, 'offline');
		first.block('big.bin', 'oversize');
		first.pause(90_000);
		await first.save();

		const second = await loaded(storage);
		expect(second.pausedUntil()).toBe(90_000);
		expect(second.blockedItems().map((item) => item.path)).toEqual(['big.bin']);
		expect(second.all().find((item) => item.path === 'gone.md')?.attempts).toBe(1);
	});

	test('drops corrupt and malformed persisted entries', async () => {
		const storage = new MemoryStorage();
		await storage.write('queue.json', '{ bad json');
		expect((await loaded(storage)).all()).toEqual([]);
		await storage.write('queue.json', JSON.stringify({ items: [{ nope: 1 }], pausedUntil: 0 }));
		expect((await loaded(storage)).all()).toEqual([]);
	});

	test('a scan preserves backoff while a fresh edit resets it', async () => {
		const queue = await loaded();
		queue.enqueue('note.md', 'upsert');
		queue.fail('note.md', 20_000, 1_000, 'server down');

		queue.enqueueScanned('note.md', 'upsert');
		expect(queue.all()[0]).toMatchObject({ attempts: 1, nextAttemptAt: 21_000 });

		queue.enqueue('note.md', 'upsert');
		expect(queue.all()[0]).toMatchObject({ attempts: 0, nextAttemptAt: 0 });
	});

	test('a scan re-queues a blocked path so shrinking a file unblocks it', async () => {
		const queue = await loaded();
		queue.enqueue('big.bin', 'upsert');
		queue.block('big.bin', 'oversize');
		expect(queue.depth()).toEqual({ upserts: 0, deletes: 0, blocked: 1 });

		queue.enqueueScanned('big.bin', 'upsert');
		expect(queue.depth()).toEqual({ upserts: 1, deletes: 0, blocked: 0 });
	});

	test('a scan that finds a different intent replaces the entry', async () => {
		const queue = await loaded();
		queue.enqueue('note.md', 'upsert');
		queue.fail('note.md', 20_000, 1_000, 'server down');

		queue.enqueueScanned('note.md', 'delete');
		expect(queue.all()[0]).toMatchObject({ intent: 'delete', attempts: 0 });
	});

	test('refuses use before load', () => {
		const queue = new PendingQueue(new MemoryStorage());
		expect(() => queue.enqueue('a.md', 'upsert')).toThrow(/load/);
	});
});

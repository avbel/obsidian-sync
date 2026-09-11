import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type BlobStore, BlobStoreError, createBlobStore } from './blobs.js';

const address = 'ab'.padEnd(64, 'c');
const otherAddress = 'de'.padEnd(64, 'f');
const payload = new Uint8Array([1, 2, 3, 4]);

let directory: string;
let store: BlobStore;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-blobs-'));
	store = createBlobStore(directory);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('BlobStore', () => {
	test('reports an absent blob', async () => {
		await expect(store.has('v1', address)).resolves.toBe(false);
		await expect(store.get('v1', address)).resolves.toBeUndefined();
	});

	test('stores and reads back a blob', async () => {
		await store.put('v1', address, payload);
		await expect(store.has('v1', address)).resolves.toBe(true);
		await expect(store.get('v1', address)).resolves.toEqual(payload);
	});

	test('shards by the first two address characters', async () => {
		await store.put('v1', address, payload);
		await expect(readdir(join(directory, 'v1'))).resolves.toEqual(['ab']);
	});

	test('isolates vaults from each other', async () => {
		await store.put('v1', address, payload);
		await expect(store.has('v2', address)).resolves.toBe(false);
	});

	test('is idempotent when the same blob is written twice', async () => {
		await store.put('v1', address, payload);
		await store.put('v1', address, payload);
		await expect(store.get('v1', address)).resolves.toEqual(payload);
	});

	test('leaves no temporary files behind', async () => {
		await store.put('v1', address, payload);
		const shard = await readdir(join(directory, 'v1', 'ab'));
		expect(shard).toEqual([address]);
	});

	test('removes a blob', async () => {
		await store.put('v1', address, payload);
		await store.remove('v1', address);
		await expect(store.has('v1', address)).resolves.toBe(false);
	});

	test('tolerates removing an absent blob', async () => {
		await expect(store.remove('v1', otherAddress)).resolves.toBeUndefined();
	});

	test('reports the write time of a stored blob', async () => {
		const before = Date.now();
		await store.put('v1', address, payload);
		const found = await store.stat('v1', address);
		expect(found?.writtenAt).toBeGreaterThanOrEqual(before - 2000);
		expect(found?.size).toBe(4);
	});

	test('reports undefined write time for an absent blob', async () => {
		await expect(store.stat('v1', address)).resolves.toBeUndefined();
	});

	test('rejects an address that is not 64 hex characters', async () => {
		await expect(store.put('v1', 'nope', payload)).rejects.toThrow(BlobStoreError);
		await expect(store.has('v1', '../escape')).resolves.toBe(false);
	});

	test('rejects a vault id containing a path separator', async () => {
		await expect(store.put('../escape', address, payload)).rejects.toThrow(BlobStoreError);
	});
});

import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppDependencies } from './app.js';
import { startServer } from './index.js';

const aliceToken = 'a'.repeat(40);

let directory: string;
let app: FastifyInstance;
let dependencies: AppDependencies;
let stop: () => Promise<void>;
let vaultId: string;

const headers = { authorization: `Bearer ${aliceToken}` };

/** Stands in for a device: derives addresses the way the plugin will. */
class VirtualClient {
	readonly #contentKey = Buffer.from('k'.repeat(32));
	cursor = 0;

	address(content: string): string {
		return createHmac('sha256', this.#contentKey).update(content).digest('hex');
	}

	async upload(content: string): Promise<string> {
		const address = this.address(content);
		await app.inject({
			method: 'PUT',
			url: `/v1/vaults/${vaultId}/blobs/${address}`,
			headers: { ...headers, 'content-type': 'application/octet-stream' },
			payload: Buffer.from(content),
		});
		return address;
	}

	async commit(fileId: string, content: string, parentVersion: string | undefined) {
		const address = await this.upload(content);
		return app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/files/${fileId}`,
			headers,
			payload: {
				parentVersion,
				metaBlob: Buffer.from(content).toString('base64'),
				chunks: [address],
				size: content.length,
				deviceId: 'device',
			},
		});
	}

	async pull(): Promise<{ fileId: string; kind: string }[]> {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=${this.cursor}&wait=0`,
			headers,
		});
		const body = response.json() as {
			changes: { seq: number; fileId: string; kind: string }[];
			seq: number;
		};
		this.cursor = body.seq;
		return body.changes.map((change) => ({ fileId: change.fileId, kind: change.kind }));
	}
}

const fileId = 'a1'.padEnd(64, '0');

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-integration-'));
	const started = await startServer({
		DATA_DIR: directory,
		LOG_LEVEL: 'silent',
		SYNC_USER_ALICE: aliceToken,
	});
	app = started.app;
	dependencies = started.dependencies;
	stop = started.stop;

	const created = await app.inject({
		method: 'POST',
		url: '/v1/vaults',
		headers,
		payload: { name: 'personal' },
	});
	vaultId = created.json().id;
});

afterEach(async () => {
	await stop();
	await rm(directory, { recursive: true, force: true });
});

describe('two devices sharing one vault', () => {
	test('a commit from one device reaches the other', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		await laptop.commit(fileId, 'hello from the laptop', undefined);
		const seen = await phone.pull();

		expect(seen).toEqual([{ fileId, kind: 'upsert' }]);
	});

	test('the second concurrent writer is rejected, not silently overwritten', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		const created = await laptop.commit(fileId, 'base', undefined);
		const baseVersion = created.json().versionId;

		const laptopEdit = await laptop.commit(fileId, 'laptop edit', baseVersion);
		expect(laptopEdit.statusCode).toBe(201);

		// The phone still believes baseVersion is current. This is the case the
		// entire client-side merge design depends on being detected.
		const phoneEdit = await phone.commit(fileId, 'phone edit', baseVersion);
		expect(phoneEdit.statusCode).toBe(409);
		expect(phoneEdit.json().headVersion).toBe(laptopEdit.json().versionId);
	});

	test('the loser converges after pulling and retrying', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		const created = await laptop.commit(fileId, 'base', undefined);
		const baseVersion = created.json().versionId;
		const winner = await laptop.commit(fileId, 'laptop edit', baseVersion);

		const rejected = await phone.commit(fileId, 'phone edit', baseVersion);
		const retry = await phone.commit(fileId, 'merged', rejected.json().headVersion);

		expect(retry.statusCode).toBe(201);
		expect(winner.json().versionId).not.toBe(retry.json().versionId);
	});

	test('an identical chunk from a second device is not re-uploaded', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		await laptop.upload('shared content');
		const response = await app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/blobs/check`,
			headers,
			payload: { addresses: [phone.address('shared content')] },
		});

		expect(response.json().missing).toEqual([]);
	});

	test('a delete propagates as a delete change', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		const created = await laptop.commit(fileId, 'doomed', undefined);
		await phone.pull();

		await app.inject({
			method: 'DELETE',
			url: `/v1/vaults/${vaultId}/files/${fileId}?parentVersion=${created.json().versionId}`,
			headers,
		});

		expect(await phone.pull()).toEqual([{ fileId, kind: 'delete' }]);
	});

	test('a device that was offline catches up from its stored cursor', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();
		await phone.pull();

		let parent: string | undefined;
		for (let index = 0; index < 3; index += 1) {
			const response = await laptop.commit(fileId, `revision ${index}`, parent);
			parent = response.json().versionId;
		}

		expect(await phone.pull()).toHaveLength(3);
		expect(await phone.pull()).toEqual([]);
	});

	test('vault state lists live files with the current sequence', async () => {
		const laptop = new VirtualClient();
		await laptop.commit(fileId, 'content', undefined);

		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/state`,
			headers,
		});
		const body = response.json() as { files: { fileId: string }[]; seq: number };

		expect(body.files.map((file) => file.fileId)).toEqual([fileId]);
		expect(body.seq).toBeGreaterThan(0);
	});
});

describe('startServer', () => {
	test('creates the data directory and opens the database', () => {
		expect(dependencies.db).toBeDefined();
	});

	test('refuses to start with no users configured', async () => {
		await expect(startServer({ DATA_DIR: directory, LOG_LEVEL: 'silent' })).rejects.toThrow(
			/no users configured/,
		);
	});
});

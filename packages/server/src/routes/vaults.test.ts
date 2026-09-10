import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type AppDependencies, buildApp } from '../app.js';
import { createBlobStore } from '../blobs.js';
import { ChangeNotifier } from '../changes.js';
import { loadConfig } from '../config.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { SerialWriter } from '../db/writer.js';
import { TicketStore } from '../tickets.js';
import { buildUserRegistry } from '../users.js';

const aliceToken = 'a'.repeat(40);
const bobToken = 'b'.repeat(40);

let directory: string;
let dependencies: AppDependencies;
let app: FastifyInstance;

function authorised(token: string): { authorization: string } {
	return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-vaults-'));
	dependencies = {
		config: loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }),
		users: buildUserRegistry({ SYNC_USER_ALICE: aliceToken, SYNC_USER_BOB: bobToken }),
		db: openDatabase(join(directory, 'sync.db')),
		writer: new SerialWriter(),
		blobs: createBlobStore(join(directory, 'blobs')),
		notifier: new ChangeNotifier(),
		tickets: new TicketStore(60_000),
	};
	app = buildApp(dependencies);
	await app.ready();
});

afterEach(async () => {
	await app.close();
	closeDatabase(dependencies.db);
	await rm(directory, { recursive: true, force: true });
});

describe('GET /v1/me', () => {
	test('reports the user and an empty vault list', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ user: 'alice', vaults: [], protocolVersion: 1 });
	});
});

describe('POST /v1/vaults', () => {
	test('creates a vault and returns a base64 salt', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'personal' },
		});
		expect(response.statusCode).toBe(201);

		const body = response.json() as { id: string; name: string; kdfSalt: string };
		expect(body.name).toBe('personal');
		expect(Buffer.from(body.kdfSalt, 'base64')).toHaveLength(16);
	});

	test('gives two vaults different salts', async () => {
		const first = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'one' },
		});
		const second = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'two' },
		});
		expect(first.json().kdfSalt).not.toBe(second.json().kdfSalt);
	});

	test('rejects a malformed body', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: '' },
		});
		expect(response.statusCode).toBe(400);
	});

	test('rejects a duplicate name for the same owner', async () => {
		await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'personal' },
		});
		const response = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'personal' },
		});
		expect(response.statusCode).toBe(409);
	});

	test('allows two owners to use the same vault name', async () => {
		await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'personal' },
		});
		const response = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(bobToken),
			payload: { name: 'personal' },
		});
		expect(response.statusCode).toBe(201);
	});
});

describe('vault isolation', () => {
	test('one owner never sees another owner vault', async () => {
		await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'secrets' },
		});

		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: authorised(bobToken),
		});
		expect(response.json().vaults).toEqual([]);
	});
});

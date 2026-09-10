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
const addressOne = '1'.repeat(64);
const addressTwo = '2'.repeat(64);
const payload = Buffer.from([9, 8, 7, 6]);

let directory: string;
let dependencies: AppDependencies;
let app: FastifyInstance;
let vaultId: string;

function authorised(token: string): { authorization: string } {
	return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-blobroutes-'));
	dependencies = {
		config: loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent', MAX_BLOB_BYTES: '2048' }),
		users: buildUserRegistry({ SYNC_USER_ALICE: aliceToken, SYNC_USER_BOB: bobToken }),
		db: openDatabase(join(directory, 'sync.db')),
		writer: new SerialWriter(),
		blobs: createBlobStore(join(directory, 'blobs')),
		notifier: new ChangeNotifier(),
		tickets: new TicketStore(60_000),
	};
	app = buildApp(dependencies);
	await app.ready();

	const created = await app.inject({
		method: 'POST',
		url: '/v1/vaults',
		headers: authorised(aliceToken),
		payload: { name: 'personal' },
	});
	vaultId = created.json().id;
});

afterEach(async () => {
	await app.close();
	closeDatabase(dependencies.db);
	await rm(directory, { recursive: true, force: true });
});

async function upload(address: string, body: Buffer = payload) {
	return app.inject({
		method: 'PUT',
		url: `/v1/vaults/${vaultId}/blobs/${address}`,
		headers: { ...authorised(aliceToken), 'content-type': 'application/octet-stream' },
		payload: body,
	});
}

describe('PUT blob', () => {
	test('stores a new blob', async () => {
		expect((await upload(addressOne)).statusCode).toBe(201);
		await expect(dependencies.blobs.has(vaultId, addressOne)).resolves.toBe(true);
	});

	test('records a blob_ref row at refcount zero', async () => {
		await upload(addressOne);
		const row = dependencies.db
			.prepare('SELECT refcount, bytes FROM blob_ref WHERE vault_id = ? AND addr = ?')
			.get(vaultId, addressOne) as { refcount: number; bytes: number };
		expect(row.refcount).toBe(0);
		expect(row.bytes).toBe(payload.length);
	});

	test('returns 204 when the blob already exists', async () => {
		await upload(addressOne);
		expect((await upload(addressOne)).statusCode).toBe(204);
	});

	test('rejects a malformed address', async () => {
		const response = await app.inject({
			method: 'PUT',
			url: `/v1/vaults/${vaultId}/blobs/not-hex`,
			headers: { ...authorised(aliceToken), 'content-type': 'application/octet-stream' },
			payload,
		});
		expect(response.statusCode).toBe(400);
	});

	test('rejects a body over the configured limit', async () => {
		const response = await upload(addressOne, Buffer.alloc(4096));
		expect(response.statusCode).toBe(413);
	});

	test('rejects an upload to another owner vault', async () => {
		const response = await app.inject({
			method: 'PUT',
			url: `/v1/vaults/${vaultId}/blobs/${addressOne}`,
			headers: { ...authorised(bobToken), 'content-type': 'application/octet-stream' },
			payload,
		});
		expect(response.statusCode).toBe(404);
	});
});

describe('POST blobs/check', () => {
	test('reports every address as missing when the store is empty', async () => {
		const response = await app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/blobs/check`,
			headers: authorised(aliceToken),
			payload: { addresses: [addressOne, addressTwo] },
		});
		expect(response.json().missing.sort()).toEqual([addressOne, addressTwo].sort());
	});

	test('omits addresses that are already stored', async () => {
		await upload(addressOne);
		const response = await app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/blobs/check`,
			headers: authorised(aliceToken),
			payload: { addresses: [addressOne, addressTwo] },
		});
		expect(response.json().missing).toEqual([addressTwo]);
	});

	test('rejects a malformed body', async () => {
		const response = await app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/blobs/check`,
			headers: authorised(aliceToken),
			payload: { addresses: ['bad'] },
		});
		expect(response.statusCode).toBe(400);
	});
});

describe('GET blob', () => {
	test('returns the stored bytes', async () => {
		await upload(addressOne);
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/blobs/${addressOne}`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers['content-type']).toBe('application/octet-stream');
		expect(Buffer.from(response.rawPayload)).toEqual(payload);
	});

	test('returns 404 for an absent blob', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/blobs/${addressTwo}`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(404);
	});
});

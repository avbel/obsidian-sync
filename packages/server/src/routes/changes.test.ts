import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type AppDependencies, buildApp } from '../app.js';
import { createBlobStore } from '../blobs.js';
import { appendChange, ChangeNotifier } from '../changes.js';
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
let vaultId: string;

function authorised(token: string): { authorization: string } {
	return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-changeroutes-'));
	dependencies = {
		config: loadConfig({
			DATA_DIR: directory,
			LOG_LEVEL: 'silent',
			LONGPOLL_MAX_WAIT_MS: '1000',
		}),
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

function addChange(fileId: string): number {
	return appendChange(dependencies.db, {
		vaultId,
		fileId,
		versionId: undefined,
		kind: 'upsert',
		size: 1,
	});
}

describe('GET changes', () => {
	test('returns existing changes without waiting', async () => {
		addChange('f1');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().changes).toHaveLength(1);
	});

	test('reports the newest sequence number', async () => {
		const seq = addChange('f1');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.json().seq).toBe(seq);
	});

	test('returns an empty list for a caught-up client when wait is zero', async () => {
		addChange('f1');
		const seq = addChange('f2');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=${seq}&wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.json().changes).toEqual([]);
	});

	test('holds the request open and returns when a change arrives', async () => {
		const pending = app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=5`,
			headers: authorised(aliceToken),
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		addChange('late');
		dependencies.notifier.notify(vaultId);

		const response = await pending;
		expect(response.json().changes).toHaveLength(1);
		expect(response.json().changes[0].fileId).toBe('late');
	});

	test('returns empty after the wait ceiling with nothing to report', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=30`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().changes).toEqual([]);
	});

	test('defaults a missing since cursor to zero', async () => {
		addChange('f1');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.json().changes).toHaveLength(1);
	});

	test('rejects a non-numeric cursor', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=abc&wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(400);
	});

	test('refuses to serve another owner vault', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=0`,
			headers: authorised(bobToken),
		});
		expect(response.statusCode).toBe(404);
	});

	test('flags a truncated page', async () => {
		for (let index = 0; index < 5; index += 1) {
			addChange(`f${index}`);
		}
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=0&limit=2`,
			headers: authorised(aliceToken),
		});
		expect(response.json().changes).toHaveLength(2);
		expect(response.json().hasMore).toBe(true);
	});
});

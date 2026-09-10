import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type AppDependencies, buildApp } from './app.js';
import { createBlobStore } from './blobs.js';
import { ChangeNotifier } from './changes.js';
import { loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { SerialWriter } from './db/writer.js';
import { TicketStore } from './tickets.js';
import { buildUserRegistry } from './users.js';

const aliceToken = 'a'.repeat(40);

let directory: string;
let dependencies: AppDependencies;
let app: FastifyInstance;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-app-'));
	dependencies = {
		config: loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }),
		users: buildUserRegistry({ SYNC_USER_ALICE: aliceToken }),
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

describe('GET /v1/health', () => {
	test('responds without authentication', async () => {
		const response = await app.inject({ method: 'GET', url: '/v1/health' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ status: 'ok' });
	});
});

describe('bearer authentication', () => {
	test('rejects a request with no Authorization header', async () => {
		const response = await app.inject({ method: 'GET', url: '/v1/me' });
		expect(response.statusCode).toBe(401);
	});

	test('rejects a non-bearer scheme', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Basic ${aliceToken}` },
		});
		expect(response.statusCode).toBe(401);
	});

	test('rejects an unknown token', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Bearer ${'z'.repeat(40)}` },
		});
		expect(response.statusCode).toBe(401);
	});

	test('accepts a known token', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ user: 'alice' });
	});

	test('accepts a lowercase bearer scheme', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `bearer ${aliceToken}` },
		});
		expect(response.statusCode).toBe(200);
	});

	test('never echoes the supplied token in the error body', async () => {
		const badToken = 'q'.repeat(40);
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Bearer ${badToken}` },
		});
		expect(response.body).not.toContain(badToken);
	});
});

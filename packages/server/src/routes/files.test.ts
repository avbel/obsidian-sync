import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VersionsResponse } from '@obsidian-sync/protocol';
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
import { parseWindow } from './files.js';

const aliceToken = 'a'.repeat(40);
const bobToken = 'b'.repeat(40);
const fileId = 'f'.repeat(64);

let directory: string;
let dependencies: AppDependencies;
let app: FastifyInstance;
let vaultId: string;
let bobVaultId: string;

function authorised(token: string): { authorization: string } {
	return { authorization: `Bearer ${token}` };
}

async function createVault(name: string, token: string): Promise<string> {
	const response = await app.inject({
		method: 'POST',
		url: '/v1/vaults',
		headers: authorised(token),
		payload: { name },
	});
	if (response.statusCode !== 201) {
		throw new Error(`vault setup failed: ${response.statusCode}`);
	}
	return (response.json() as { id: string }).id;
}

async function commitVersion(
	id: string,
	metaBlob: string,
	parentVersion?: string,
): Promise<string> {
	const response = await app.inject({
		method: 'POST',
		url: `/v1/vaults/${id}/files/${fileId}`,
		headers: authorised(aliceToken),
		payload: { metaBlob, chunks: [], size: 0, deviceId: 'device-1', parentVersion },
	});
	if (response.statusCode !== 201) {
		throw new Error(`commit setup failed: ${response.statusCode} ${response.body}`);
	}
	return (response.json() as { versionId: string }).versionId;
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-files-routes-'));
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
	vaultId = await createVault('personal', aliceToken);
	bobVaultId = await createVault('personal', bobToken);
});

afterEach(async () => {
	await app.close();
	closeDatabase(dependencies.db);
	await rm(directory, { recursive: true, force: true });
});

describe('GET /v1/vaults/:vaultId/files/:fileId/versions', () => {
	test('rejects a non-hex file id', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/not-a-file-id/versions`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(400);
	});

	test('hides another user vault behind a 404', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/${fileId}/versions`,
			headers: authorised(bobToken),
		});
		expect(response.statusCode).toBe(404);
	});

	test('accepts an oversized limit rather than rejecting the request', async () => {
		await commitVersion(vaultId, 'bWV0YQ==');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/${fileId}/versions?limit=100000`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect((response.json() as VersionsResponse).versions.length).toBeLessThanOrEqual(200);
	});

	test('ignores a junk limit rather than returning zero rows', async () => {
		await commitVersion(vaultId, 'bWV0YQ==');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/${fileId}/versions?limit=abc&offset=-5`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect((response.json() as VersionsResponse).versions.length).toBeGreaterThan(0);
	});

	test('returns the committed meta blob with each version, newest first', async () => {
		await commitVersion(vaultId, 'bWV0YQ==');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/${fileId}/versions`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);

		const body = response.json() as VersionsResponse;
		expect(body.versions).toHaveLength(1);
		expect(body.versions[0]?.metaBlob).toBe('bWV0YQ==');
		expect(body.hasMore).toBe(false);
	});

	test('pages oldest after newest with hasMore set', async () => {
		const first = await commitVersion(vaultId, 'bWV0YQ==');
		await commitVersion(vaultId, 'bW1ldGE=', first);
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/${fileId}/versions?limit=1&offset=0`,
			headers: authorised(aliceToken),
		});

		const body = response.json() as VersionsResponse;
		expect(body.versions).toHaveLength(1);
		expect(body.hasMore).toBe(true);
	});

	test('never lists versions of another owner vault even with the same file id', async () => {
		await commitVersion(vaultId, 'bWV0YQ==');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${bobVaultId}/files/${fileId}/versions`,
			headers: authorised(bobToken),
		});

		expect((response.json() as VersionsResponse).versions).toEqual([]);
	});
});

describe('parseWindow', () => {
	test('clamps a limit to the maximum and defaults a junk one', () => {
		expect(parseWindow({ limit: '100000' }).limit).toBe(200);
		expect(parseWindow({ limit: '10' }).limit).toBe(10);
		expect(parseWindow({}).limit).toBe(50);
		expect(parseWindow({ limit: 'abc' }).limit).toBe(50);
		expect(parseWindow({ limit: '0' }).limit).toBe(50);
		expect(parseWindow({ limit: '-5' }).limit).toBe(50);
	});

	// 1e20 passes Number.isInteger, so an earlier guard let it through to the driver,
	// which rejects the bind parameter and turns a sanitised query into a 500.
	test('rejects an offset the driver could not bind', () => {
		expect(parseWindow({ offset: '1e20' }).offset).toBe(0);
		expect(parseWindow({ offset: String(Number.MAX_SAFE_INTEGER) }).offset).toBe(
			Number.MAX_SAFE_INTEGER,
		);
		expect(parseWindow({ offset: '-5' }).offset).toBe(0);
		expect(parseWindow({ offset: '7' }).offset).toBe(7);
	});
});

describe('response compression', () => {
	// /state returns every file's metaBlob as base64, whose ~33% expansion deflate
	// recovers almost entirely. It is the one response large enough to be worth it.
	test('compresses a large state response when the client asks for it', async () => {
		await commitVersion(vaultId, 'bWV0YQ=='.repeat(400));

		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/state`,
			headers: { ...authorised(aliceToken), 'accept-encoding': 'gzip' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers['content-encoding']).toBe('gzip');
	});

	// Negotiated: a client that does not advertise gets exactly what it got before, which
	// is what makes this safe to deploy without knowing how every client decodes.
	test('sends a large state response uncompressed when the client does not ask', async () => {
		await commitVersion(vaultId, 'bWV0YQ=='.repeat(400));

		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/state`,
			headers: { ...authorised(aliceToken), 'accept-encoding': 'identity' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers['content-encoding']).toBeUndefined();
		expect((response.json() as { files: unknown[] }).files).toHaveLength(1);
	});

	// Blob bodies are ciphertext. application/octet-stream is not in mime-db's
	// compressible set, so spending CPU on them is avoided without an explicit exclusion.
	test('leaves a blob body alone even when the client asks for gzip', async () => {
		const payload = Buffer.alloc(4096, 7);
		const address = 'a'.repeat(64);
		const put = await app.inject({
			method: 'PUT',
			url: `/v1/vaults/${vaultId}/blobs/${address}`,
			headers: { ...authorised(aliceToken), 'content-type': 'application/octet-stream' },
			payload,
		});
		expect(put.statusCode).toBe(201);

		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/blobs/${address}`,
			headers: { ...authorised(aliceToken), 'accept-encoding': 'gzip' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers['content-encoding']).toBeUndefined();
	});
});

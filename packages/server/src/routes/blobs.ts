import {
	type BlobCheckResponse,
	blobAddressPattern,
	isBlobCheckRequest,
} from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { findVaultForOwner } from '../vaults.js';

interface VaultParams {
	vaultId: string;
}

interface BlobParams extends VaultParams {
	address: string;
}

export function registerBlobRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, writer, blobs } = dependencies;

	scope.put<{ Params: BlobParams }>(
		'/v1/vaults/:vaultId/blobs/:address',
		async (request, reply) => {
			const { vaultId, address } = request.params;
			if (!blobAddressPattern.test(address)) {
				return reply.code(400).send({ error: 'invalid_address' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			if (await blobs.has(vaultId, address)) {
				return reply.code(204).send();
			}

			const body = request.body;
			if (!Buffer.isBuffer(body)) {
				return reply.code(400).send({ error: 'expected_octet_stream' });
			}

			// Blob first, row second — spec section 5.3. An orphan blob is collectable;
			// a row pointing at a missing blob is unrecoverable corruption.
			await blobs.put(vaultId, address, new Uint8Array(body));
			await writer.run(() => {
				db.prepare(
					'INSERT INTO blob_ref (vault_id, addr, bytes, refcount) VALUES (?, ?, ?, 0) ON CONFLICT (vault_id, addr) DO NOTHING',
				).run(vaultId, address, body.length);
			});

			return reply.code(201).send();
		},
	);

	scope.post<{ Params: VaultParams }>('/v1/vaults/:vaultId/blobs/check', async (request, reply) => {
		const { vaultId } = request.params;
		if (findVaultForOwner(db, vaultId, request.username) === undefined) {
			return reply.code(404).send({ error: 'vault_not_found' });
		}
		if (!isBlobCheckRequest(request.body)) {
			return reply.code(400).send({ error: 'invalid_body' });
		}

		const missing: string[] = [];
		for (const address of request.body.addresses) {
			if (!(await blobs.has(vaultId, address))) {
				missing.push(address);
			}
		}

		const response: BlobCheckResponse = { missing };
		return reply.send(response);
	});

	scope.get<{ Params: BlobParams }>(
		'/v1/vaults/:vaultId/blobs/:address',
		async (request, reply) => {
			const { vaultId, address } = request.params;
			if (!blobAddressPattern.test(address)) {
				return reply.code(400).send({ error: 'invalid_address' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const data = await blobs.get(vaultId, address);
			if (data === undefined) {
				return reply.code(404).send({ error: 'blob_not_found' });
			}

			return reply.type('application/octet-stream').send(Buffer.from(data));
		},
	);
}

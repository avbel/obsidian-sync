import { isCreateVaultRequest, type MeResponse, protocolVersion } from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { createVault, listVaultsForOwner, VaultNameTakenError } from '../vaults.js';

export function registerVaultRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, writer } = dependencies;

	scope.get('/v1/me', async (request): Promise<MeResponse> => {
		return {
			user: request.username,
			vaults: listVaultsForOwner(db, request.username),
			protocolVersion,
		};
	});

	scope.post('/v1/vaults', async (request, reply) => {
		if (!isCreateVaultRequest(request.body)) {
			return reply.code(400).send({ error: 'invalid_body' });
		}

		const { name } = request.body;
		try {
			const vault = await writer.run(() => createVault(db, request.username, name));
			return reply.code(201).send(vault);
		} catch (error) {
			if (error instanceof VaultNameTakenError) {
				return reply.code(409).send({ error: 'vault_exists' });
			}
			throw error;
		}
	});
}

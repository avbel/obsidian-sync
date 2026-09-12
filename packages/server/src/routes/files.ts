import {
	type CommitVersionResponse,
	fileIdPattern,
	isCommitVersionRequest,
	type VaultStateResponse,
	type VersionsResponse,
} from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { latestSeq } from '../changes.js';
import {
	commitVersion,
	deleteFile,
	listVersions,
	readVaultState,
	type VersionWindow,
} from '../files.js';
import { findVaultForOwner } from '../vaults.js';

interface FileParams {
	vaultId: string;
	fileId: string;
}

interface VaultParams {
	vaultId: string;
}

const versionListDefaultLimit = 50;
const versionListMaxLimit = 200;

/**
 * Exported for its own tests: at the route level a clamp is invisible unless the vault
 * holds more versions than the maximum, so nothing there can prove the bound.
 *
 * `isSafeInteger` rather than `isInteger`, because `Number.isInteger(1e20)` is true and
 * that value reaches the driver as a bind parameter it rejects outright, turning a
 * sanitised query string into a 500 carrying the driver's own message.
 */
export function parseWindow(query: { limit?: string; offset?: string }): VersionWindow {
	const limit = Number(query.limit ?? versionListDefaultLimit);
	const offset = Number(query.offset ?? 0);
	return {
		limit:
			Number.isSafeInteger(limit) && limit > 0
				? Math.min(limit, versionListMaxLimit)
				: versionListDefaultLimit,
		offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
	};
}

export function registerFileRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, writer, notifier } = dependencies;

	scope.post<{ Params: FileParams }>(
		'/v1/vaults/:vaultId/files/:fileId',
		async (request, reply) => {
			const { vaultId, fileId } = request.params;
			if (!fileIdPattern.test(fileId)) {
				return reply.code(400).send({ error: 'invalid_file_id' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}
			if (!isCommitVersionRequest(request.body)) {
				return reply.code(400).send({ error: 'invalid_body' });
			}

			const body = request.body;
			const outcome = await writer.run(() =>
				commitVersion(db, {
					vaultId,
					fileId,
					parentVersion: body.parentVersion,
					metaBlob: body.metaBlob,
					chunks: body.chunks,
					size: body.size,
					deviceId: body.deviceId,
				}),
			);

			if (outcome.status === 'conflict') {
				return reply.code(409).send({ error: 'conflict', headVersion: outcome.headVersion });
			}
			if (outcome.status === 'missingChunks') {
				return reply.code(400).send({ error: 'missing_chunks', missing: outcome.missing });
			}

			notifier.notify(vaultId);
			const response: CommitVersionResponse = {
				versionId: outcome.versionId,
				seq: outcome.seq,
			};
			return reply.code(201).send(response);
		},
	);

	scope.delete<{ Params: FileParams; Querystring: { parentVersion?: string } }>(
		'/v1/vaults/:vaultId/files/:fileId',
		async (request, reply) => {
			const { vaultId, fileId } = request.params;
			if (!fileIdPattern.test(fileId)) {
				return reply.code(400).send({ error: 'invalid_file_id' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const outcome = await writer.run(() =>
				deleteFile(db, { vaultId, fileId, parentVersion: request.query.parentVersion }),
			);

			if (outcome.status !== 'committed') {
				return reply.code(409).send({
					error: 'conflict',
					headVersion: outcome.status === 'conflict' ? outcome.headVersion : undefined,
				});
			}

			notifier.notify(vaultId);
			return reply.code(200).send({ seq: outcome.seq });
		},
	);

	scope.get<{ Params: FileParams; Querystring: { limit?: string; offset?: string } }>(
		'/v1/vaults/:vaultId/files/:fileId/versions',
		async (request, reply) => {
			const { vaultId, fileId } = request.params;
			if (!fileIdPattern.test(fileId)) {
				return reply.code(400).send({ error: 'invalid_file_id' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const response: VersionsResponse = listVersions(
				db,
				vaultId,
				fileId,
				parseWindow(request.query),
			);
			return reply.send(response);
		},
	);

	scope.get<{ Params: VaultParams }>('/v1/vaults/:vaultId/state', async (request, reply) => {
		const { vaultId } = request.params;
		if (findVaultForOwner(db, vaultId, request.username) === undefined) {
			return reply.code(404).send({ error: 'vault_not_found' });
		}

		// Sequence read before the file list, so a change landing mid-read is
		// re-delivered by the client's next incremental pull rather than skipped.
		const seq = latestSeq(db, vaultId);
		const response: VaultStateResponse = { files: readVaultState(db, vaultId), seq };
		return reply.send(response);
	});
}

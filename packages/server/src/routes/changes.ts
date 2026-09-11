import type { ChangesResponse } from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { latestSeq, readChangesSince } from '../changes.js';
import { findVaultForOwner } from '../vaults.js';

interface ChangesQuery {
	since?: string;
	wait?: string;
	limit?: string;
}

const defaultLimit = 500;
const maximumLimit = 2000;

function parseNumber(raw: string | undefined, fallback: number): number | undefined {
	if (raw === undefined || raw === '') {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return undefined;
	}
	return parsed;
}

export function registerChangeRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, notifier, config } = dependencies;

	scope.get<{ Params: { vaultId: string }; Querystring: ChangesQuery }>(
		'/v1/vaults/:vaultId/changes',
		async (request, reply) => {
			const { vaultId } = request.params;
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const since = parseNumber(request.query.since, 0);
			const requestedWaitSeconds = parseNumber(request.query.wait, 0);
			const limit = parseNumber(request.query.limit, defaultLimit);
			if (since === undefined || requestedWaitSeconds === undefined || limit === undefined) {
				return reply.code(400).send({ error: 'invalid_query' });
			}

			// The client may ask for less than the ceiling but never more: on mobile
			// it lowers this after measuring the platform requestUrl timeout (spec R1).
			const waitMs = Math.min(requestedWaitSeconds * 1000, config.longpollMaxWaitMs);
			const pageSize = Math.min(limit, maximumLimit);

			let page = readChangesSince(db, vaultId, since, pageSize);
			if (page.changes.length === 0 && waitMs > 0) {
				await notifier.waitForChange(vaultId, waitMs);
				page = readChangesSince(db, vaultId, since, pageSize);
			}

			// The cursor names the last row actually delivered. Reporting the head of the
			// log instead would let a truncated page advance the client past everything
			// the truncation left behind, skipping it permanently.
			const lastDelivered = page.changes.at(-1)?.seq;
			const response: ChangesResponse = {
				changes: page.changes,
				hasMore: page.hasMore,
				seq: lastDelivered ?? Math.max(since, latestSeq(db, vaultId)),
			};
			return reply.send(response);
		},
	);
}

export function registerStreamRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, tickets } = dependencies;

	scope.post<{ Params: { vaultId: string } }>(
		'/v1/vaults/:vaultId/stream-ticket',
		async (request, reply) => {
			const { vaultId } = request.params;
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}
			return reply.send(tickets.issue(request.username, vaultId));
		},
	);
}

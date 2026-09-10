import { protocolVersion } from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
	app.get('/v1/health', async () => ({ status: 'ok', protocolVersion }));
}

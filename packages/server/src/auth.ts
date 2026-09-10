import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserRegistry } from './users.js';

declare module 'fastify' {
	interface FastifyRequest {
		username: string;
	}
}

const bearerPattern = /^bearer\s+(.+)$/i;

export function registerAuthentication(scope: FastifyInstance, users: UserRegistry): void {
	scope.decorateRequest('username', '');

	scope.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
		const header = request.headers.authorization;
		const match = header === undefined ? undefined : bearerPattern.exec(header);

		if (match === null || match === undefined) {
			await reply.code(401).send({ error: 'unauthorized' });
			return;
		}

		// Never log or echo the presented token; an operator reading logs must not
		// be able to recover a credential from a failed request.
		const username = users.findByToken(match[1] ?? '');
		if (username === undefined) {
			await reply.code(401).send({ error: 'unauthorized' });
			return;
		}

		request.username = username;
	});
}

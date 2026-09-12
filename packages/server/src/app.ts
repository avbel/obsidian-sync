import type { DatabaseSync } from 'node:sqlite';
import compress from '@fastify/compress';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthentication } from './auth.js';
import type { BlobStore } from './blobs.js';
import type { ChangeNotifier } from './changes.js';
import { latestSeq } from './changes.js';
import type { ServerConfig } from './config.js';
import type { SerialWriter } from './db/writer.js';
import { registerBlobRoutes } from './routes/blobs.js';
import { registerChangeRoutes, registerStreamRoutes } from './routes/changes.js';
import { registerFileRoutes } from './routes/files.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerVaultRoutes } from './routes/vaults.js';
import type { TicketStore } from './tickets.js';
import type { UserRegistry } from './users.js';

export interface AppDependencies {
	config: ServerConfig;
	users: UserRegistry;
	db: DatabaseSync;
	writer: SerialWriter;
	blobs: BlobStore;
	notifier: ChangeNotifier;
	tickets: TicketStore;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
	const app = Fastify({
		logger: { level: dependencies.config.logLevel },
		bodyLimit: dependencies.config.maxBlobBytes,
	});

	// Chunks arrive as raw bytes. Fastify has no built-in parser for them.
	app.addContentTypeParser(
		'application/octet-stream',
		{ parseAs: 'buffer' },
		(_request, body, done) => {
			done(null, body);
		},
	);

	registerHealthRoutes(app);

	app.register(websocket);

	// The WebSocket upgrade route is unauthenticated by header; the browser cannot
	// set Authorization on a WebSocket, so it carries a single-use ticket instead.
	app.register(async (scope) => {
		scope.get<{ Params: { vaultId: string }; Querystring: { ticket?: string } }>(
			'/v1/vaults/:vaultId/stream',
			{ websocket: true },
			(socket, request) => {
				const redeemed =
					request.query.ticket === undefined
						? undefined
						: dependencies.tickets.redeem(request.query.ticket);

				if (redeemed === undefined || redeemed.vaultId !== request.params.vaultId) {
					socket.close(4401, 'unauthorized');
					return;
				}

				let open = true;
				const pump = async (): Promise<void> => {
					while (open) {
						await dependencies.notifier.waitForChange(
							request.params.vaultId,
							dependencies.config.longpollMaxWaitMs,
						);
						if (!open) {
							return;
						}
						// Sequence numbers only. The socket never carries file data, so a
						// dropped connection costs nothing beyond a delayed nudge.
						socket.send(
							JSON.stringify({ seq: latestSeq(dependencies.db, request.params.vaultId) }),
						);
					}
				};

				socket.on('close', () => {
					open = false;
				});

				const running = pump();
				running.catch(() => {
					open = false;
					socket.close();
				});
			},
		);
	});

	// Everything below is inside an authenticated encapsulation context, so a
	// route cannot be added without auth by forgetting a decorator.
	app.register(async (scope) => {
		registerAuthentication(scope, dependencies.users);

		// Blob bodies are AES-GCM ciphertext: incompressible by construction, and they are
		// the bulk of the traffic, so compressing them would spend CPU on every sync for
		// nothing. Scoping is what excludes them — the plugin's `customTypes` is ORed with
		// its mime-db check rather than replacing it, so it can add types but never remove
		// one, and mime-db calls application/octet-stream compressible.
		scope.register(async (blobScope) => {
			registerBlobRoutes(blobScope, dependencies);
		});

		scope.register(async (jsonScope) => {
			// `/state` is the response that pays: it returns every file's metaBlob as
			// base64, whose ~33% expansion deflate recovers almost entirely. Negotiated, so
			// a client that does not advertise Accept-Encoding is served what it always was.
			await jsonScope.register(compress, { global: true, threshold: 1024 });
			registerVaultRoutes(jsonScope, dependencies);
			registerFileRoutes(jsonScope, dependencies);
			registerChangeRoutes(jsonScope, dependencies);
			registerStreamRoutes(jsonScope, dependencies);
		});
	});

	return app;
}

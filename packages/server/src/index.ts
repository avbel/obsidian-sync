import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import closeWithGrace from 'close-with-grace';
import type { FastifyInstance } from 'fastify';
import { type AppDependencies, buildApp } from './app.js';
import { createBlobStore } from './blobs.js';
import { ChangeNotifier } from './changes.js';
import { loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { SerialWriter } from './db/writer.js';
import { pruneVersions, sweepOrphanBlobs } from './retention.js';
import { TicketStore } from './tickets.js';
import { buildUserRegistry } from './users.js';

const streamTicketLifetimeMs = 60_000;
const maintenanceIntervalMs = 60 * 60 * 1000;

export async function startServer(env: Record<string, string | undefined>): Promise<{
	app: FastifyInstance;
	dependencies: AppDependencies;
	stop(): Promise<void>;
}> {
	const config = loadConfig(env);
	const users = buildUserRegistry(env);

	await mkdir(config.dataDir, { recursive: true });

	const dependencies: AppDependencies = {
		config,
		users,
		db: openDatabase(join(config.dataDir, 'sync.db')),
		writer: new SerialWriter(),
		blobs: createBlobStore(join(config.dataDir, 'blobs')),
		notifier: new ChangeNotifier(),
		tickets: new TicketStore(streamTicketLifetimeMs),
	};

	const app = buildApp(dependencies);
	await app.ready();

	return {
		app,
		dependencies,
		async stop() {
			await app.close();
			closeDatabase(dependencies.db);
		},
	};
}

async function runMaintenance(
	dependencies: AppDependencies,
	log: FastifyInstance['log'],
): Promise<void> {
	const { config, db, writer, blobs } = dependencies;
	try {
		const vaultIds = await writer.run(() => {
			const vaults = db.prepare('SELECT id FROM vault').all() as { id: string }[];
			for (const vault of vaults) {
				pruneVersions(db, vault.id, {
					retentionDays: config.versionRetentionDays,
					retentionMin: config.versionRetentionMin,
				});
			}
			return vaults.map((vault) => vault.id);
		});

		for (const vaultId of vaultIds) {
			const reclaimed = await sweepOrphanBlobs({
				db,
				writer,
				blobs,
				vaultId,
				graceMs: config.orphanBlobGraceMs,
			});
			if (reclaimed > 0) {
				log.info({ vaultId, reclaimed }, 'orphan sweep reclaimed blobs');
			}
		}
	} catch (error: unknown) {
		log.error({ err: error }, 'maintenance pass failed');
	}
}

// Import-time side effects would break the tests, which call startServer directly.
const isMainModule =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
	const started = await startServer(process.env);
	const { config } = started.dependencies;

	await started.app.listen({ port: config.port, host: config.host });
	started.app.log.info(`obsidian-sync server listening on ${config.host}:${config.port}`);

	// Hourly, not per-commit: pruning decays chunk refcounts and the sweep deletes
	// what reaches zero, while writes stay lean (spec §5.2). runMaintenance never
	// rejects, so the returned promise needs no rejection handling.
	const maintenance = setInterval(async () => {
		await runMaintenance(started.dependencies, started.app.log);
	}, maintenanceIntervalMs);
	maintenance.unref();

	closeWithGrace({ delay: 10_000 }, async ({ err }) => {
		clearInterval(maintenance);
		if (err !== undefined) {
			started.app.log.error({ err }, 'shutting down after an unhandled error');
		}
		await started.stop();
	});
}

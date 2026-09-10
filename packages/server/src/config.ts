export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

export interface ServerConfig {
	port: number;
	host: string;
	dataDir: string;
	maxBlobBytes: number;
	longpollMaxWaitMs: number;
	versionRetentionDays: number;
	versionRetentionMin: number;
	orphanBlobGraceMs: number;
	logLevel: string;
}

function readInteger(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	minimum: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === '') {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < minimum) {
		throw new ConfigError(`${name} must be an integer of at least ${minimum}, received "${raw}"`);
	}
	return parsed;
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
	const logLevel = env.LOG_LEVEL ?? 'info';
	const allowedLogLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
	if (!allowedLogLevels.includes(logLevel)) {
		throw new ConfigError(`LOG_LEVEL must be one of ${allowedLogLevels.join(', ')}`);
	}

	return {
		port: readInteger(env, 'PORT', 3000, 1),
		host: env.HOST ?? '0.0.0.0',
		dataDir: env.DATA_DIR ?? '/data',
		maxBlobBytes: readInteger(env, 'MAX_BLOB_BYTES', 8 * 1024 * 1024, 1024),
		longpollMaxWaitMs: readInteger(env, 'LONGPOLL_MAX_WAIT_MS', 25_000, 1000),
		versionRetentionDays: readInteger(env, 'VERSION_RETENTION_DAYS', 90, 1),
		versionRetentionMin: readInteger(env, 'VERSION_RETENTION_MIN', 10, 1),
		// An uploaded blob has refcount 0 until its version commits. The sweep must
		// not reclaim one mid-upload, so it ignores anything younger than this.
		orphanBlobGraceMs: readInteger(env, 'ORPHAN_BLOB_GRACE_MS', 24 * 60 * 60 * 1000, 60_000),
		logLevel,
	};
}

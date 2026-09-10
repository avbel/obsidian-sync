import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
	test('applies documented defaults for an empty environment', () => {
		const config = loadConfig({});
		expect(config.port).toBe(3000);
		expect(config.host).toBe('0.0.0.0');
		expect(config.dataDir).toBe('/data');
		expect(config.maxBlobBytes).toBe(8 * 1024 * 1024);
		expect(config.longpollMaxWaitMs).toBe(25_000);
		expect(config.versionRetentionDays).toBe(90);
		expect(config.versionRetentionMin).toBe(10);
		expect(config.logLevel).toBe('info');
	});

	test('reads overrides from the environment', () => {
		const config = loadConfig({ PORT: '8080', DATA_DIR: '/srv/sync', LOG_LEVEL: 'debug' });
		expect(config.port).toBe(8080);
		expect(config.dataDir).toBe('/srv/sync');
		expect(config.logLevel).toBe('debug');
	});

	test('treats an empty string as absent', () => {
		expect(loadConfig({ PORT: '' }).port).toBe(3000);
	});

	test('rejects a non-numeric integer setting', () => {
		expect(() => loadConfig({ PORT: 'eighty' })).toThrow(ConfigError);
	});

	test('rejects a fractional integer setting', () => {
		expect(() => loadConfig({ PORT: '80.5' })).toThrow(/must be an integer/);
	});

	test('rejects a value below the allowed minimum', () => {
		expect(() => loadConfig({ LONGPOLL_MAX_WAIT_MS: '10' })).toThrow(/at least 1000/);
	});

	test('rejects an unknown log level', () => {
		expect(() => loadConfig({ LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL must be one of/);
	});
});

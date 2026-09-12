import { describe, expect, test } from 'vitest';
import {
	ConflictError,
	DiskFullError,
	OfflineError,
	ServerError,
	TimeoutError,
	UnauthorizedError,
} from '../transport/client.js';
import { classifyFailure, maxRetryDelayMs, retryDelayMs } from './backoff.js';

describe('retryDelayMs', () => {
	test('doubles each attempt and caps at five minutes', () => {
		expect(retryDelayMs(0)).toBe(0);
		expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([
			5_000, 10_000, 20_000, 40_000, 80_000, 160_000,
		]);
		expect(retryDelayMs(7)).toBe(maxRetryDelayMs);
	});
});

describe('classifyFailure', () => {
	test('distinguishes permanent credentials, server pauses, outages, and file failures', () => {
		expect(classifyFailure(new UnauthorizedError())).toBe('halt');
		expect(classifyFailure(new DiskFullError())).toBe('pause');
		expect(classifyFailure(new TimeoutError(1_000))).toBe('retry-all');
		expect(classifyFailure(new ServerError(500, undefined))).toBe('retry-all');
		expect(classifyFailure(new ServerError(400, undefined))).toBe('retry-item');
		expect(classifyFailure(new ConflictError('abc'))).toBe('retry-item');
		expect(classifyFailure(new OfflineError(new Error('ENOTFOUND')))).toBe('retry-all');
	});

	test('anything unrecognised defers only its own file', () => {
		expect(classifyFailure(new Error('encode failed'))).toBe('retry-item');
		expect(classifyFailure('not an error at all')).toBe('retry-item');
	});
});

import { describe, expect, test } from 'vitest';
import { OfflineError, TimeoutError } from './client.js';
import { createObsidianRequester } from './http.js';

const response = {
	status: 200,
	arrayBuffer: new ArrayBuffer(0),
	json: () => ({}),
	text: '{}',
};

describe('createObsidianRequester', () => {
	// requestUrl has no timeout of its own, so a connection frozen by an app
	// suspension would otherwise hang the sync run and the long-poll behind it.
	test('rejects a request that never settles', async () => {
		const requester = createObsidianRequester({
			serverUrl: 'http://example.invalid',
			token: 'token',
			requestUrl: () => new Promise(() => undefined),
			timeoutMs: 30,
		});

		await expect(requester.request({ path: '/v1/me', method: 'GET' })).rejects.toThrow(
			TimeoutError,
		);
	});

	// requestUrl reports DNS failure, a refused connection and a dropped link alike as a
	// bare Error; the engine must not confuse those with a bug in its own request building.
	test('wraps a transport-level rejection as OfflineError', async () => {
		const requester = createObsidianRequester({
			serverUrl: 'http://example.invalid',
			token: 'token',
			requestUrl: () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')),
			timeoutMs: 1000,
		});

		await expect(requester.request({ path: '/v1/me', method: 'GET' })).rejects.toThrow(
			OfflineError,
		);
	});

	test('passes a normal response straight through', async () => {
		const requester = createObsidianRequester({
			serverUrl: 'http://example.invalid',
			token: 'token',
			requestUrl: async () => response,
			timeoutMs: 1000,
		});

		await expect(requester.request({ path: '/v1/me', method: 'GET' })).resolves.toMatchObject({
			status: 200,
		});
	});

	test('a slow but successful response is not cut off early', async () => {
		const requester = createObsidianRequester({
			serverUrl: 'http://example.invalid',
			token: 'token',
			requestUrl: async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				return response;
			},
			timeoutMs: 400,
		});

		await expect(requester.request({ path: '/v1/me', method: 'GET' })).resolves.toMatchObject({
			status: 200,
		});
	});
});

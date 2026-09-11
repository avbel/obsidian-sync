import { describe, expect, test } from 'vitest';
import { TimeoutError } from './client.js';
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

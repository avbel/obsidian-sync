import { describe, expect, test } from 'vitest';
import { isBlobCheckRequest, isCommitVersionRequest, isCreateVaultRequest } from './validate.js';

const validAddress = 'a'.repeat(64);
const validVersion = '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

function validCommit(): Record<string, unknown> {
	return {
		parentVersion: validVersion,
		metaBlob: 'AAAA',
		chunks: [validAddress],
		size: 42,
		deviceId: 'device-1',
	};
}

describe('isCommitVersionRequest', () => {
	test('accepts a well-formed body', () => {
		expect(isCommitVersionRequest(validCommit())).toBe(true);
	});

	test('accepts an omitted parentVersion for a new file', () => {
		expect(isCommitVersionRequest({ ...validCommit(), parentVersion: undefined })).toBe(true);
	});

	test('accepts an empty chunk list for a zero-byte file', () => {
		expect(isCommitVersionRequest({ ...validCommit(), chunks: [], size: 0 })).toBe(true);
	});

	test('rejects a non-object', () => {
		expect(isCommitVersionRequest('nope')).toBe(false);
		expect(isCommitVersionRequest(undefined)).toBe(false);
		expect(isCommitVersionRequest([])).toBe(false);
	});

	test('rejects a malformed blob address', () => {
		expect(isCommitVersionRequest({ ...validCommit(), chunks: ['zz'] })).toBe(false);
	});

	test('rejects a malformed parentVersion', () => {
		expect(isCommitVersionRequest({ ...validCommit(), parentVersion: 'not-a-uuid' })).toBe(false);
	});

	test('rejects a negative size', () => {
		expect(isCommitVersionRequest({ ...validCommit(), size: -1 })).toBe(false);
	});

	test('rejects a fractional size', () => {
		expect(isCommitVersionRequest({ ...validCommit(), size: 1.5 })).toBe(false);
	});

	test('rejects an empty deviceId', () => {
		expect(isCommitVersionRequest({ ...validCommit(), deviceId: '' })).toBe(false);
	});
});

describe('isBlobCheckRequest', () => {
	test('accepts a list of addresses', () => {
		expect(isBlobCheckRequest({ addresses: [validAddress] })).toBe(true);
	});

	test('accepts an empty list', () => {
		expect(isBlobCheckRequest({ addresses: [] })).toBe(true);
	});

	test('rejects a malformed address', () => {
		expect(isBlobCheckRequest({ addresses: ['nope'] })).toBe(false);
	});

	test('rejects a missing addresses field', () => {
		expect(isBlobCheckRequest({})).toBe(false);
	});
});

describe('isCreateVaultRequest', () => {
	test('accepts a plain name', () => {
		expect(isCreateVaultRequest({ name: 'personal' })).toBe(true);
	});

	test('rejects an empty name', () => {
		expect(isCreateVaultRequest({ name: '' })).toBe(false);
	});

	test('rejects a name over 64 characters', () => {
		expect(isCreateVaultRequest({ name: 'x'.repeat(65) })).toBe(false);
	});
});

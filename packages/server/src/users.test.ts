import { describe, expect, test } from 'vitest';
import { ConfigError } from './config.js';
import { buildUserRegistry } from './users.js';

const strongToken = 'a'.repeat(40);
const otherToken = 'b'.repeat(40);

describe('buildUserRegistry', () => {
	test('lowercases the username from the variable suffix', () => {
		const registry = buildUserRegistry({ SYNC_USER_ALICE: strongToken });
		expect(registry.usernames()).toEqual(['alice']);
		expect(registry.findByToken(strongToken)).toBe('alice');
	});

	test('registers several users', () => {
		const registry = buildUserRegistry({
			SYNC_USER_ALICE: strongToken,
			SYNC_USER_BOB: otherToken,
		});
		expect(registry.usernames().sort()).toEqual(['alice', 'bob']);
		expect(registry.findByToken(otherToken)).toBe('bob');
	});

	test('ignores unrelated environment variables', () => {
		const registry = buildUserRegistry({ SYNC_USER_ALICE: strongToken, PATH: '/usr/bin' });
		expect(registry.usernames()).toEqual(['alice']);
	});

	test('returns undefined for an unknown token', () => {
		const registry = buildUserRegistry({ SYNC_USER_ALICE: strongToken });
		expect(registry.findByToken(otherToken)).toBeUndefined();
	});

	test('returns undefined for an empty token', () => {
		const registry = buildUserRegistry({ SYNC_USER_ALICE: strongToken });
		expect(registry.findByToken('')).toBeUndefined();
	});

	test('rejects a token shorter than 32 characters', () => {
		expect(() => buildUserRegistry({ SYNC_USER_ALICE: 'short' })).toThrow(ConfigError);
	});

	test('rejects two users sharing one token', () => {
		expect(() =>
			buildUserRegistry({ SYNC_USER_ALICE: strongToken, SYNC_USER_BOB: strongToken }),
		).toThrow(/duplicate token/);
	});

	test('rejects usernames that collide after lowercasing', () => {
		expect(() =>
			buildUserRegistry({ SYNC_USER_ALICE: strongToken, SYNC_USER_alice: otherToken }),
		).toThrow(/collides/);
	});

	test('rejects a username with characters outside the allowed set', () => {
		expect(() => buildUserRegistry({ 'SYNC_USER_A.B': strongToken })).toThrow(/invalid username/);
	});

	test('rejects an empty registry, since nobody could authenticate', () => {
		expect(() => buildUserRegistry({})).toThrow(/no users configured/);
	});

	test('never places a token in the error message', () => {
		try {
			buildUserRegistry({ SYNC_USER_ALICE: 'short' });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect((error as Error).message).not.toContain('short');
		}
	});
});

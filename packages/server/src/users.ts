import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfigError } from './config.js';

const environmentPrefix = 'SYNC_USER_';
const usernamePattern = /^[a-z0-9_-]+$/;
const minimumTokenLength = 32;

export interface UserRegistry {
	findByToken(token: string): string | undefined;
	usernames(): string[];
}

function hashToken(token: string): Buffer {
	return createHash('sha256').update(token, 'utf8').digest();
}

export function buildUserRegistry(env: Record<string, string | undefined>): UserRegistry {
	const byUsername = new Map<string, Buffer>();
	const seenTokenHashes = new Set<string>();

	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(environmentPrefix) || value === undefined || value === '') {
			continue;
		}

		const username = key.slice(environmentPrefix.length).toLowerCase();
		if (!usernamePattern.test(username)) {
			throw new ConfigError(`invalid username "${username}" from ${key}; allowed: a-z 0-9 _ -`);
		}
		if (byUsername.has(username)) {
			throw new ConfigError(`username "${username}" collides with another SYNC_USER_ variable`);
		}
		if (value.length < minimumTokenLength) {
			throw new ConfigError(
				`token for "${username}" must be at least ${minimumTokenLength} characters`,
			);
		}

		const digest = hashToken(value);
		const digestHex = digest.toString('hex');
		if (seenTokenHashes.has(digestHex)) {
			throw new ConfigError(`duplicate token: "${username}" shares a token with another user`);
		}

		seenTokenHashes.add(digestHex);
		byUsername.set(username, digest);
	}

	if (byUsername.size === 0) {
		throw new ConfigError('no users configured; set at least one SYNC_USER_<NAME> variable');
	}

	return {
		findByToken(token: string): string | undefined {
			if (token.length === 0) {
				return undefined;
			}

			// Hashing first fixes both sides at 32 bytes, so timingSafeEqual never
			// throws on a length mismatch and the token length itself does not leak.
			const candidate = hashToken(token);
			for (const [username, digest] of byUsername) {
				if (timingSafeEqual(candidate, digest)) {
					return username;
				}
			}
			return undefined;
		},

		usernames(): string[] {
			return [...byUsername.keys()];
		},
	};
}

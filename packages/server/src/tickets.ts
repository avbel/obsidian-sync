import { randomBytes } from 'node:crypto';

interface TicketRecord {
	username: string;
	vaultId: string;
	expiresAt: number;
}

export class TicketStore {
	readonly #records = new Map<string, TicketRecord>();
	readonly #lifetimeMs: number;

	constructor(lifetimeMs: number) {
		this.#lifetimeMs = lifetimeMs;
	}

	issue(username: string, vaultId: string): { ticket: string; expiresAt: number } {
		// Sweeping on issue keeps the map bounded without a background timer that
		// would hold the event loop open during shutdown.
		this.#dropExpired();

		const ticket = randomBytes(32).toString('hex');
		const expiresAt = Date.now() + this.#lifetimeMs;
		this.#records.set(ticket, { username, vaultId, expiresAt });
		return { ticket, expiresAt };
	}

	redeem(ticket: string): { username: string; vaultId: string } | undefined {
		const record = this.#records.get(ticket);
		if (record === undefined) {
			return undefined;
		}

		this.#records.delete(ticket);
		if (record.expiresAt <= Date.now()) {
			return undefined;
		}
		return { username: record.username, vaultId: record.vaultId };
	}

	size(): number {
		this.#dropExpired();
		return this.#records.size;
	}

	#dropExpired(): void {
		const now = Date.now();
		for (const [ticket, record] of this.#records) {
			if (record.expiresAt <= now) {
				this.#records.delete(ticket);
			}
		}
	}
}

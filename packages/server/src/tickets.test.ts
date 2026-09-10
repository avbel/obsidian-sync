import { describe, expect, test, vi } from 'vitest';
import { TicketStore } from './tickets.js';

describe('TicketStore', () => {
	test('issues an opaque ticket', () => {
		const store = new TicketStore(60_000);
		const { ticket } = store.issue('alice', 'v1');
		expect(ticket).toMatch(/^[0-9a-f]{64}$/);
	});

	test('redeems a ticket to its owner and vault', () => {
		const store = new TicketStore(60_000);
		const { ticket } = store.issue('alice', 'v1');
		expect(store.redeem(ticket)).toEqual({ username: 'alice', vaultId: 'v1' });
	});

	test('is single use', () => {
		const store = new TicketStore(60_000);
		const { ticket } = store.issue('alice', 'v1');
		store.redeem(ticket);
		expect(store.redeem(ticket)).toBeUndefined();
	});

	test('rejects an unknown ticket', () => {
		expect(new TicketStore(60_000).redeem('z'.repeat(64))).toBeUndefined();
	});

	test('rejects an expired ticket', () => {
		vi.useFakeTimers();
		try {
			const store = new TicketStore(1000);
			const { ticket } = store.issue('alice', 'v1');
			vi.advanceTimersByTime(1500);
			expect(store.redeem(ticket)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	// Unredeemed tickets would otherwise accumulate for the life of the process.
	test('drops expired tickets rather than retaining them', () => {
		vi.useFakeTimers();
		try {
			const store = new TicketStore(1000);
			store.issue('alice', 'v1');
			store.issue('alice', 'v1');
			expect(store.size()).toBe(2);
			vi.advanceTimersByTime(1500);
			store.issue('alice', 'v1');
			expect(store.size()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

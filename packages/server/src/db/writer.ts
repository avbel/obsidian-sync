/**
 * Serialises synchronous database work onto one chain.
 *
 * node:sqlite is synchronous, so an individual statement cannot interleave —
 * but a read-then-write sequence spanning an await boundary can. Routing every
 * mutation through here is what makes the optimistic-concurrency check sound.
 */
export class SerialWriter {
	#tail: Promise<unknown> = Promise.resolve();

	async run<T>(operation: () => T): Promise<T> {
		// The chain advances on a promise that never rejects, so one caller's
		// failure cannot poison the queue for everyone behind them.
		const result = this.#tail.then(() => operation());
		this.#tail = result.catch(() => undefined);
		return result;
	}
}

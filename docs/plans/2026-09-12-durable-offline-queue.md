# Durable, Restart-Surviving Offline Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist pending push operations to disk so a delete made offline survives a restart, a crash, or a force-quit; retry them with exponential backoff capped at five minutes; and stop a single unpushable file from stalling everything behind it.

**Architecture:** One new durable store, `PendingQueue`, sits beside `index.json` in the plugin's never-synced state directory and holds **one intent per path** (`upsert` or `delete`) plus that path's attempt count and next-attempt time. The watcher writes into it *before* a sync is requested, and only a confirmed server round-trip removes an entry — so the crash-safety argument is the cursor's argument from §7.2 run backwards: a lost write replays, and replaying a push is free because the index already matches. The engine drains it in two phases, deletes before upserts (§9), isolating per-file failures and aborting the drain only when the server itself is the problem. Retry policy is a pure function of the attempt count; failure policy is a pure function of the error type. No protocol change, no server change.

**Tech Stack:** TypeScript 7 (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM, Vitest 4 against `FakeServer` + `MemoryVault`, Obsidian 1.13 plugin API (`Notice`, `ItemView`), Biome.

**Spec:** `docs/specs/2026-09-10-obsidian-sync-design.md` (§6.3.2 status view, §6.4 local state, §6.5 config guardrails, §7.1 push, §9 error handling)

**Prior plans:** `docs/plans/2026-09-10-server-and-protocol.md`, `docs/plans/2026-09-12-conflict-resolution-modal.md`, `docs/plans/2026-09-12-full-reconcile.md`. Their Global Constraints apply here in full.

## Global Constraints

These bind every task. Do not restate them in review; do not violate them.

- **Runtime:** TypeScript 7, ESM only, `.js` extensions on every relative import.
- **Package manager:** pnpm only.
- **No `any`.** Use `unknown` and narrow. No dynamic `await import()`.
- **No non-null assertions (`!`).** `biome.json` sets `style/noNonNullAssertion` to error. Narrow with `if (x === undefined) { ... }` — in tests too.
- **`exactOptionalPropertyTypes` is on.** An optional field that may be assigned `undefined` must be declared `field?: T | undefined`, never `field?: T`. The codebase already does this (`WriteOptions.mtime`, `engine/vault.ts:36`).
- **`noUncheckedIndexedAccess` is on.** `array[0]` is `T | undefined`; narrow before use, in tests too.
- **Strings:** single quotes. **Defaults:** `??`, never `||`. **Nullish:** prefer `undefined` over `null`.
- **Braces:** always brace `if` / `for` / `while` bodies.
- **Async:** `async`/`await` only. Never `.then()`. Never `void`-prefix a promise *except* at an Obsidian callback boundary typed to return `void` — the established pattern in `main.ts`.
- **Formatting:** tabs, 100-column lines (Biome enforces; run `pnpm lint:fix`).
- **Naming:** camelCase, full descriptive names, no abbreviations.
- **Comments:** only for *why*, or a constraint the code cannot show. Never restate what the code says.
- **Never log or persist a secret.** The queue stores a failure *message*; `#logError` (`main.ts:559`) already prints message-only for this reason. Never put a token, a passphrase, or file contents in `queue.json`.
- **Commits:** conventional format. Never add a Claude co-author trailer. Never create a git branch.
- **The server stays blind.** It is end-to-end encrypted; nothing here may add server knowledge of paths, contents, or queue state.
- **Verification after every task:** `pnpm test && pnpm typecheck && pnpm lint`.

---

## Background: what already exists

Read this before Task 1. Every claim is cited so it can be re-verified rather than trusted.

**1. The queue today is one in-memory `Set` on the plugin object.** `SyncPlugin.#pendingDeletes` (`main.ts:72`) is a `Set<string>`. `#startWatcher` (`main.ts:341-349`) copies `batch.deleted` into it; `#runSync` (`main.ts:386-389`) drains it into a local array, and on failure puts the paths back (`main.ts:411-413`). Nothing is written to disk at any point, so a force-quit between the watcher event and a successful push loses the delete outright.

**2. Correctness currently survives that loss only because `pushAll` re-derives absence.** `sync.ts:118-133` walks every index entry and pushes a delete for any path that no longer exists locally. That is the recovery the README describes. It has three costs, and they are the reason this plan exists:
   - It is guarded by `#sawVault` (`sync.ts:91`, `sync.ts:127`), which is per-engine-instance, so the recovery cannot run until the vault has listed at least one file this session.
   - It costs one `vault.exists()` per index entry on every single sync, on top of point 3's full read-and-hash of the vault.
   - It makes the **correctness** of a delete depend on a whole-vault pass, which is exactly why that pass can never be skipped today.

   Note what is *not* wrong with it: the `isPathIncluded` test at `sync.ts:129` correctly withholds a delete under a newly excluded path. Excluding a folder means "stop syncing this", never "remove it from the server". Task 3 preserves that, and tests it.

**3. `pushAll` reads and hashes the entire vault on every sync.** `sync.ts:135-148` lists the vault, then for *every* file does `await vault.read(path)` followed by `await hashBytes(data)` before comparing against the index. A 5,000-note vault therefore performs 5,000 full reads and 5,000 hashes every time a single keystroke's debounce elapses. A durable queue of dirty paths is the only thing that makes skipping this scan safe, so this plan takes that step — behind a flag, in Task 3, so it can be reverted in one line.

**4. The watcher already collects the exact intents the queue needs, and already throws half of them away.** `DebouncedWatcher` (`obsidian/watcher.ts`) maintains `#changed` and `#deleted` sets and flushes a `DirtyBatch` of both. `#startWatcher` uses only `batch.deleted`; `batch.changed` is discarded because the full scan rediscovers it. The watcher also already implements the per-path collapse this plan needs: `drop(path)` deletes the path from `#changed` (`watcher.ts:43-47`), so a delete supersedes a pending edit.

**5. The watcher already restores a batch whose flush failed.** `watcher.ts:93-100` catches a rejected flush and puts every path back into its own sets. This means a *synchronous* enqueue that throws before persisting is safe, and it is why Task 4 persists the queue inside the flush callback rather than after it.

**6. `#pushDelete` is already idempotent and already guarded against reviving a file.** `sync.ts:214-237`: it returns immediately when the index has no entry for the path, and returns immediately when the path exists in the vault again. That second guard is why a queued delete can safely be replayed after a restart even if a pull has meanwhile restored the file — the replay is a no-op rather than a data loss. Its comment explains the two-device delete/recreate loop it prevents; do not weaken it.

**7. `#pushFile` handles its own `409` and rethrows only after two failed merge-and-retry rounds.** `sync.ts:189-203`. So a `ConflictError` reaching the drain means the file is being rewritten from another device faster than this one can commit — a per-file condition, not a server outage. Task 2 classifies it as such.

**8. Every typed transport error the classifier needs already exists.** `transport/client.ts` defines `UnauthorizedError` (401), `ConflictError` (409), `DiskFullError` (507), `TimeoutError`, and `ServerError` carrying `.status`. §9 already assigns each of them a behaviour; nothing new is needed on the wire.

**9. There is no backoff anywhere in the client today.** `#runSync`'s catch (`main.ts:410-419`) sets the status to `error` and returns. The next attempt happens whenever the nudge source or the 5-minute watchdog next fires. Spec §9 requires "exponential backoff capped at five minutes, surviving restarts"; none of those three properties is currently implemented.

**10. The state directory is already excluded from sync.** `pluginDir` (`engine/selective.ts:24`) is `.obsidian/plugins/obsidian-sync`, and `createStateStorage(this.app.vault, stateDir)` (`main.ts:259-261`) writes `index.json` and `base-cache.json` under `.../state`. `queue.json` joins them, and needs no new guardrail.

**11. `VaultAdapter` has no way to stat one path.** `engine/vault.ts:38-48` offers `list`, `exists`, `read`, `write`, `remove`, `trash`. Pushing one queued path needs that path's `mtime`, `ctime`, and `size` without listing the whole vault — which is the very cost the queue exists to avoid. Task 3 adds `stat`.

**12. `makeDevice` gives each store its own `MemoryStorage`.** `testing/devices.ts:60-62`. In production all three stores share one `StateStorage` over one directory. Task 3 unifies them and lets a caller pass the storage in, which is what makes "restart the device over its own durable state" expressible as a test.

### Decisions taken, and why

Four calls were made in the absence of an explicit instruction. Each is stated here so review can overturn it rather than discover it.

- **The queue stores one intent per path, latest wins** — not an append-only log of operations. A log would have to be compacted anyway (a note edited 40 times offline must upload once), and the collapse rules are already settled by the watcher (point 4). The consequence worth knowing: delete-then-recreate collapses to `upsert`, and recreate-then-delete collapses to `delete`. Both are what the vault actually holds at drain time. **To use a log instead:** the change is confined to `PendingQueue`; the engine sees only `ready()`.

- **The queue persists on enqueue and once at the end of a drain, not after every item.** The asymmetry is deliberate and mirrors §7.2's cursor rule. Losing a *completion* replays a push that the index now satisfies, which costs one read and one hash — `#pushFile` re-commits identical bytes at worst, `#pushDelete` returns at its first guard. Losing an *enqueue* loses user work permanently. So the write that must not be lost happens before any network call, and the write that is merely an optimisation happens once.

- **A watcher- or nudge-driven sync no longer walks the whole vault; a startup, reconcile, or manual sync still does.** This is background point 3's payoff and the only behavioural risk in the plan. The scan's unique value is finding a change with no vault event behind it — which means a change made while the plugin was not running, and that is exactly when a startup or reconcile pass runs. **To revert:** delete the `{ fullScan: false }` argument at its single call site in `main.ts` (Task 4, Step 3) and the scan runs every time again, as today.

- **Backoff is deterministic, with no jitter.** The fleet is a handful of personal devices; lockstep retry against one's own server costs nothing, and a jitter source would have to be injected into every test to keep assertions exact. **To add jitter:** `retryDelayMs` is pure and has one caller.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/plugin/src/state/pending-queue.ts` | **Create.** `PendingQueue` — the durable store: one intent per path, attempt counts, next-attempt times, a queue-wide pause, and a blocked list. Storage-backed, no network, no Obsidian. |
| `packages/plugin/src/state/pending-queue.test.ts` | **Create.** Unit tests: collapse, ordering by intent, backoff gating, pause, blocking, persistence across a reload, corrupt-file tolerance. |
| `packages/plugin/src/engine/backoff.ts` | **Create.** Pure: `retryDelayMs(attempts)` and `classifyFailure(error)`. No I/O. |
| `packages/plugin/src/engine/backoff.test.ts` | **Create.** Unit tests for the curve, the five-minute ceiling, and every error class. |
| `packages/plugin/src/engine/vault.ts` | **Modify.** Add `stat(path)` to `VaultAdapter`, so one queued path can be pushed without listing the vault. |
| `packages/plugin/src/obsidian/vault-adapter.ts` | **Modify.** Implement `stat` for both the file-tree and config-directory paths. |
| `packages/plugin/src/testing/memory-fixtures.ts` | **Modify.** Implement `stat` on `MemoryVault`, honouring `setBlind`. |
| `packages/plugin/src/testing/devices.ts` | **Modify.** Give every device a `PendingQueue`; share one `MemoryStorage` across index, bases, and queue; let a caller pass that storage in so a device can be rebuilt over its own durable state. |
| `packages/plugin/src/engine/sync.ts` | **Modify.** Take the queue as a dependency; drain it deletes-first with per-item failure isolation; make the whole-vault scan optional; return a `PushReport`. |
| `packages/plugin/src/engine/engine.test.ts` | **Modify.** Migrate the three `pushAll([...])` call sites to the queue. |
| `packages/plugin/src/engine/reconcile-engine.test.ts` | **Modify.** Migrate the two `pushAll([...])` call sites to the queue. |
| `packages/plugin/src/engine/queue-engine.test.ts` | **Create.** End-to-end: a delete queued offline survives a simulated restart and lands; a 500 backs the whole queue off; an oversized file does not stall the file behind it; a 401 halts without charging an attempt. |
| `packages/plugin/src/obsidian/retry-timer.ts` | **Create.** Pure: `wakeDelayMs(readyAt, now)` — when the plugin should wake itself to retry. |
| `packages/plugin/src/obsidian/retry-timer.test.ts` | **Create.** Unit tests for the clamps and the empty case. |
| `packages/plugin/src/main.ts` | **Modify.** Own the queue; enqueue the watcher's whole batch and persist it before requesting a sync; schedule the retry wake-up; halt on 401; pause on 507; drop `#pendingDeletes`. |
| `packages/plugin/src/obsidian/status-display.ts` | **Modify.** Queue depth in the status-bar tooltip. |
| `packages/plugin/src/obsidian/status-display.test.ts` | **Create.** Unit tests for the tooltip's new segment. |
| `packages/plugin/src/obsidian/status-view.ts` | **Modify.** Queue depth, the next retry time, and the blocked files by name (§6.3.2, §9). |
| `README.md` | **Modify.** Move the offline queue out of "Not yet implemented". |

---

## Task 1: `PendingQueue` — the durable store

**Files:**
- Create: `packages/plugin/src/state/pending-queue.ts`
- Test: `packages/plugin/src/state/pending-queue.test.ts`

**Interfaces:**
- Consumes: `StateStorage` from `packages/plugin/src/state/storage.js` (`read`/`write`/`remove`, all async, keyed by a filename); `MemoryStorage` from `packages/plugin/src/testing/memory-fixtures.js` for tests.
- Produces: `PendingQueue` with `load()`, `enqueue(path, intent)`, `enqueueBatch(batch)`, `ready(now, intent)`, `succeed(path)`, `fail(path, delayMs, now, message)`, `block(path, reason)`, `forget(path)`, `pause(until)`, `resume()`, `pausedUntil()`, `readyAt()`, `depth()`, `blockedItems()`, `all()`, `save()`, `clear()`. Types `PendingIntent = 'upsert' | 'delete'`, `BlockReason = 'oversize'`, `PendingItem`, `DirtyPaths`, `QueueDepth`. Tasks 3, 4, and 5 all depend on these exact names.

- [ ] **Step 1: Write the failing tests**

Create `packages/plugin/src/state/pending-queue.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { MemoryStorage } from '../testing/memory-fixtures.js';
import { PendingQueue } from './pending-queue.js';

async function loaded(storage: MemoryStorage = new MemoryStorage()): Promise<PendingQueue> {
	const queue = new PendingQueue(storage);
	await queue.load();
	return queue;
}

describe('PendingQueue', () => {
	test('a later intent supersedes an earlier one for the same path', async () => {
		const queue = await loaded();
		queue.enqueue('note.md', 'delete');
		queue.enqueue('note.md', 'upsert');

		expect(queue.ready(0, 'delete')).toEqual([]);
		expect(queue.ready(0, 'upsert').map((item) => item.path)).toEqual(['note.md']);
	});

	test('a batch applies deletions before changes, so a re-creation wins', async () => {
		const queue = await loaded();
		// The watcher clears a path from `changed` when it drops it, so a path in both
		// arrays can only mean the last event it saw was the file coming back.
		queue.enqueueBatch({ changed: ['back.md'], deleted: ['back.md', 'gone.md'] });

		expect(queue.ready(0, 'upsert').map((item) => item.path)).toEqual(['back.md']);
		expect(queue.ready(0, 'delete').map((item) => item.path)).toEqual(['gone.md']);
	});

	test('ready() returns only the requested intent', async () => {
		const queue = await loaded();
		queue.enqueue('a.md', 'upsert');
		queue.enqueue('b.md', 'delete');

		expect(queue.ready(0, 'upsert').map((item) => item.path)).toEqual(['a.md']);
		expect(queue.ready(0, 'delete').map((item) => item.path)).toEqual(['b.md']);
	});

	test('an item inside its backoff window is not ready, and is ready after it', async () => {
		const queue = await loaded();
		queue.enqueue('a.md', 'upsert');
		queue.fail('a.md', 5_000, 1_000, 'server refused');

		expect(queue.ready(5_999, 'upsert')).toEqual([]);
		expect(queue.ready(6_000, 'upsert').map((item) => item.path)).toEqual(['a.md']);

		const item = queue.all()[0];
		if (item === undefined) {
			throw new Error('expected the failed item to be retained');
		}
		expect(item.attempts).toBe(1);
		expect(item.lastError).toBe('server refused');
	});

	test('a paused queue offers nothing until the pause expires, and resume() lifts it', async () => {
		const queue = await loaded();
		queue.enqueue('a.md', 'upsert');
		queue.pause(10_000);

		expect(queue.ready(9_999, 'upsert')).toEqual([]);
		expect(queue.ready(10_000, 'upsert')).toHaveLength(1);

		queue.pause(20_000);
		queue.resume();
		expect(queue.ready(0, 'upsert')).toHaveLength(1);
	});

	test('a pause never shortens an existing one', async () => {
		const queue = await loaded();
		queue.pause(10_000);
		queue.pause(5_000);

		expect(queue.pausedUntil()).toBe(10_000);
	});

	test('a blocked item is never ready but is still reported', async () => {
		const queue = await loaded();
		queue.enqueue('huge.bin', 'upsert');
		queue.block('huge.bin', 'oversize');

		expect(queue.ready(Number.MAX_SAFE_INTEGER, 'upsert')).toEqual([]);
		expect(queue.blockedItems().map((item) => item.path)).toEqual(['huge.bin']);
		expect(queue.depth()).toEqual({ upserts: 0, deletes: 0, blocked: 1 });
	});

	test('re-enqueueing clears a block, so a shrunken file unparks itself', async () => {
		const queue = await loaded();
		queue.enqueue('huge.bin', 'upsert');
		queue.block('huge.bin', 'oversize');
		queue.enqueue('huge.bin', 'upsert');

		expect(queue.ready(0, 'upsert')).toHaveLength(1);
		expect(queue.blockedItems()).toEqual([]);
	});

	test('readyAt() reports the earliest attemptable moment, ignoring blocked items', async () => {
		const queue = await loaded();
		queue.enqueue('a.md', 'upsert');
		queue.enqueue('b.md', 'upsert');
		queue.enqueue('c.md', 'upsert');
		queue.fail('a.md', 30_000, 1_000, 'nope');
		queue.fail('b.md', 10_000, 1_000, 'nope');
		queue.block('c.md', 'oversize');

		expect(queue.readyAt()).toBe(11_000);
	});

	test('readyAt() is undefined when nothing can ever become ready', async () => {
		const queue = await loaded();
		expect(queue.readyAt()).toBeUndefined();

		queue.enqueue('huge.bin', 'upsert');
		queue.block('huge.bin', 'oversize');
		expect(queue.readyAt()).toBeUndefined();
	});

	test('succeed() and forget() both drop the item', async () => {
		const queue = await loaded();
		queue.enqueue('a.md', 'upsert');
		queue.enqueue('b.md', 'delete');
		queue.succeed('a.md');
		queue.forget('b.md');

		expect(queue.all()).toEqual([]);
	});

	test('the queue survives a reload, attempt counts and pause included', async () => {
		const storage = new MemoryStorage();
		const first = await loaded(storage);
		first.enqueue('gone.md', 'delete');
		first.enqueue('big.bin', 'upsert');
		first.fail('gone.md', 20_000, 1_000, 'offline');
		first.block('big.bin', 'oversize');
		first.pause(90_000);
		await first.save();

		const second = await loaded(storage);
		expect(second.pausedUntil()).toBe(90_000);
		expect(second.blockedItems().map((item) => item.path)).toEqual(['big.bin']);
		const restored = second.all().find((item) => item.path === 'gone.md');
		if (restored === undefined) {
			throw new Error('expected the queued delete to survive the reload');
		}
		expect(restored.attempts).toBe(1);
		expect(restored.nextAttemptAt).toBe(21_000);
	});

	test('a corrupt queue file loads empty rather than throwing', async () => {
		const storage = new MemoryStorage();
		await storage.write('queue.json', '{ this is not json');

		const queue = await loaded(storage);
		expect(queue.all()).toEqual([]);
	});

	test('entries of the wrong shape are dropped, not trusted', async () => {
		const storage = new MemoryStorage();
		await storage.write(
			'queue.json',
			JSON.stringify({
				items: [{ path: 'ok.md', intent: 'delete', attempts: 0, nextAttemptAt: 0 }, { nope: 1 }],
				pausedUntil: 0,
			}),
		);

		const queue = await loaded(storage);
		expect(queue.all().map((item) => item.path)).toEqual(['ok.md']);
	});

	test('use before load() is an error, not a silently empty queue', async () => {
		const queue = new PendingQueue(new MemoryStorage());
		expect(() => queue.enqueue('a.md', 'upsert')).toThrow(/load/);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/plugin/src/state/pending-queue.test.ts`
Expected: FAIL — `Failed to resolve import "./pending-queue.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin/src/state/pending-queue.ts`:

```ts
import type { StateStorage } from './storage.js';

export type PendingIntent = 'upsert' | 'delete';

/** Why an item is parked rather than attempted. Recomputed each drain; stored for display. */
export type BlockReason = 'oversize';

export interface PendingItem {
	path: string;
	intent: PendingIntent;
	attempts: number;
	/** Epoch ms before which this item is not retried. 0 means ready now. */
	nextAttemptAt: number;
	blocked?: BlockReason | undefined;
	/** Last failure message, for the status view. Never a secret, never file contents. */
	lastError?: string | undefined;
}

/** One watcher flush, structurally, so `state/` never imports `obsidian`. */
export interface DirtyPaths {
	changed: string[];
	deleted: string[];
}

export interface QueueDepth {
	upserts: number;
	deletes: number;
	blocked: number;
}

const queueKey = 'queue.json';

function isIntent(value: unknown): value is PendingIntent {
	return value === 'upsert' || value === 'delete';
}

function isItem(value: unknown): value is PendingItem {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<PendingItem>;
	return (
		typeof candidate.path === 'string' &&
		isIntent(candidate.intent) &&
		typeof candidate.attempts === 'number' &&
		typeof candidate.nextAttemptAt === 'number'
	);
}

/**
 * The durable push queue (§9).
 *
 * It exists because a pending operation cannot be rediscovered from disk: a delete
 * leaves no trace at all, and an edit made while the server was unreachable becomes
 * indistinguishable from one already pushed as soon as the index drifts. It lives
 * beside index.json in the plugin's own state directory, which §6.5 never syncs.
 *
 * One intent per path, latest wins — the same collapse DebouncedWatcher already
 * performs, so a note edited forty times offline uploads once, and a file deleted
 * then recreated is a create rather than a delete the vault is about to contradict.
 */
export class PendingQueue {
	readonly #storage: StateStorage;
	#items = new Map<string, PendingItem>();
	#pausedUntil = 0;
	#loaded = false;

	constructor(storage: StateStorage) {
		this.#storage = storage;
	}

	async load(): Promise<void> {
		const raw = await this.#storage.read(queueKey);
		this.#items = new Map();
		this.#pausedUntil = 0;
		if (raw !== undefined) {
			// A truncated or hand-edited queue file must not brick sync on every launch.
			// Losing it costs one full scan, which the startup pass runs anyway.
			try {
				const shape = JSON.parse(raw) as { items?: unknown; pausedUntil?: unknown };
				const items = Array.isArray(shape.items) ? shape.items.filter(isItem) : [];
				this.#items = new Map(items.map((item) => [item.path, item]));
				this.#pausedUntil = typeof shape.pausedUntil === 'number' ? shape.pausedUntil : 0;
			} catch {
				this.#items = new Map();
			}
		}
		this.#loaded = true;
	}

	#assertLoaded(): void {
		if (!this.#loaded) {
			throw new Error('PendingQueue used before load(); await load() first');
		}
	}

	enqueue(path: string, intent: PendingIntent): void {
		this.#assertLoaded();
		this.#items.set(path, { path, intent, attempts: 0, nextAttemptAt: 0 });
	}

	/**
	 * Record one watcher flush. Deletions are applied first, so a path in both arrays —
	 * which can only mean the last event was the file coming back — ends up an upsert.
	 */
	enqueueBatch(batch: DirtyPaths): void {
		for (const path of batch.deleted) {
			this.enqueue(path, 'delete');
		}
		for (const path of batch.changed) {
			this.enqueue(path, 'upsert');
		}
	}

	/** Items of one intent that are due now. Empty while the whole queue is paused. */
	ready(now: number, intent: PendingIntent): PendingItem[] {
		this.#assertLoaded();
		if (now < this.#pausedUntil) {
			return [];
		}
		return [...this.#items.values()].filter(
			(item) => item.intent === intent && item.blocked === undefined && item.nextAttemptAt <= now,
		);
	}

	succeed(path: string): void {
		this.#assertLoaded();
		this.#items.delete(path);
	}

	/** Charge one attempt and park the item until `now + delayMs`. */
	fail(path: string, delayMs: number, now: number, message: string): void {
		this.#assertLoaded();
		const item = this.#items.get(path);
		if (item === undefined) {
			return;
		}
		this.#items.set(path, {
			...item,
			attempts: item.attempts + 1,
			nextAttemptAt: now + delayMs,
			lastError: message,
			blocked: undefined,
		});
	}

	/**
	 * Park an item not worth attempting, so it never stalls the queue behind it (§9).
	 * Cleared by the next enqueue or fail, which is how a shrunken file or a raised
	 * size limit unparks itself without anyone tracking why it was parked.
	 */
	block(path: string, reason: BlockReason): void {
		this.#assertLoaded();
		const item = this.#items.get(path);
		if (item === undefined) {
			return;
		}
		this.#items.set(path, { ...item, blocked: reason });
	}

	/** Drop an item that is no longer this device's business, such as a newly excluded path. */
	forget(path: string): void {
		this.#assertLoaded();
		this.#items.delete(path);
	}

	pause(until: number): void {
		this.#assertLoaded();
		this.#pausedUntil = Math.max(this.#pausedUntil, until);
	}

	/** Lift a pause early, for a sync the user asked for after fixing what caused it. */
	resume(): void {
		this.#assertLoaded();
		this.#pausedUntil = 0;
	}

	pausedUntil(): number {
		this.#assertLoaded();
		return this.#pausedUntil;
	}

	/** The earliest moment anything becomes attemptable, or undefined if nothing will. */
	readyAt(): number | undefined {
		this.#assertLoaded();
		let earliest: number | undefined;
		for (const item of this.#items.values()) {
			if (item.blocked !== undefined) {
				continue;
			}
			const at = Math.max(item.nextAttemptAt, this.#pausedUntil);
			if (earliest === undefined || at < earliest) {
				earliest = at;
			}
		}
		return earliest;
	}

	depth(): QueueDepth {
		this.#assertLoaded();
		const items = [...this.#items.values()];
		const live = items.filter((item) => item.blocked === undefined);
		return {
			upserts: live.filter((item) => item.intent === 'upsert').length,
			deletes: live.filter((item) => item.intent === 'delete').length,
			blocked: items.length - live.length,
		};
	}

	blockedItems(): PendingItem[] {
		this.#assertLoaded();
		return [...this.#items.values()].filter((item) => item.blocked !== undefined);
	}

	all(): PendingItem[] {
		this.#assertLoaded();
		return [...this.#items.values()];
	}

	async save(): Promise<void> {
		this.#assertLoaded();
		const payload = { items: [...this.#items.values()], pausedUntil: this.#pausedUntil };
		await this.#storage.write(queueKey, JSON.stringify(payload));
	}

	async clear(): Promise<void> {
		this.#items = new Map();
		this.#pausedUntil = 0;
		this.#loaded = true;
		await this.#storage.remove(queueKey);
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/plugin/src/state/pending-queue.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Verify the whole suite and commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/plugin/src/state/pending-queue.ts packages/plugin/src/state/pending-queue.test.ts
git commit -m "feat: add the durable pending-push queue"
```

---

## Task 2: Retry policy and failure classification

**Files:**
- Create: `packages/plugin/src/engine/backoff.ts`
- Test: `packages/plugin/src/engine/backoff.test.ts`

**Interfaces:**
- Consumes: `UnauthorizedError`, `DiskFullError`, `TimeoutError`, `ServerError` from `packages/plugin/src/transport/client.js`.
- Produces: `FailureKind = 'halt' | 'pause' | 'retry-all' | 'retry-item'`, `retryDelayMs(attempts: number): number`, `classifyFailure(error: unknown): FailureKind`, and the constants `maxRetryDelayMs` and `consecutiveFailureLimit`. Task 3 imports all five.

- [ ] **Step 1: Write the failing tests**

Create `packages/plugin/src/engine/backoff.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
	ConflictError,
	DiskFullError,
	ServerError,
	TimeoutError,
	UnauthorizedError,
} from '../transport/client.js';
import { classifyFailure, maxRetryDelayMs, retryDelayMs } from './backoff.js';

describe('retryDelayMs', () => {
	test('an unattempted item waits not at all', () => {
		expect(retryDelayMs(0)).toBe(0);
		expect(retryDelayMs(-1)).toBe(0);
	});

	test('the delay doubles per attempt', () => {
		expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([
			5_000, 10_000, 20_000, 40_000, 80_000, 160_000,
		]);
	});

	test('it never exceeds five minutes', () => {
		expect(retryDelayMs(7)).toBe(maxRetryDelayMs);
		expect(retryDelayMs(50)).toBe(maxRetryDelayMs);
		expect(maxRetryDelayMs).toBe(300_000);
	});
});

describe('classifyFailure', () => {
	test('a rejected token halts sync rather than retrying into a wall', () => {
		expect(classifyFailure(new UnauthorizedError())).toBe('halt');
	});

	test('a full server disk pauses uploads', () => {
		expect(classifyFailure(new DiskFullError())).toBe('pause');
	});

	test('a timeout or a server fault backs the whole queue off', () => {
		expect(classifyFailure(new TimeoutError(1_000))).toBe('retry-all');
		expect(classifyFailure(new ServerError(500, undefined))).toBe('retry-all');
		expect(classifyFailure(new ServerError(503, undefined))).toBe('retry-all');
	});

	test('a client-side rejection is charged to the one file', () => {
		expect(classifyFailure(new ServerError(400, undefined))).toBe('retry-item');
		expect(classifyFailure(new ServerError(404, undefined))).toBe('retry-item');
	});

	test('an escaped 409 is one hot file, not an outage', () => {
		expect(classifyFailure(new ConflictError('abc'))).toBe('retry-item');
	});

	test('an unrecognised failure is charged to the one file', () => {
		expect(classifyFailure(new Error('the vault refused to read'))).toBe('retry-item');
		expect(classifyFailure('not an error at all')).toBe('retry-item');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/plugin/src/engine/backoff.test.ts`
Expected: FAIL — `Failed to resolve import "./backoff.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin/src/engine/backoff.ts`:

```ts
import { DiskFullError, ServerError, TimeoutError, UnauthorizedError } from '../transport/client.js';

/**
 * What one failed item means for the rest of the drain.
 *
 * `retry-all` says the link or the server is down, so every item behind this one
 * would fail identically. Stopping there is what keeps a single outage from burning
 * the whole queue's attempt counts — and therefore its backoff — in one pass.
 */
export type FailureKind = 'halt' | 'pause' | 'retry-all' | 'retry-item';

const baseRetryDelayMs = 5_000;

/** §9's ceiling: backoff never exceeds five minutes. */
export const maxRetryDelayMs = 300_000;

/**
 * How many item-specific failures in a row end the drain anyway. An error this
 * classifier does not recognise is charged to one file, and without this limit a
 * queue of a thousand paths would issue a thousand doomed requests to discover
 * that the real problem was the network.
 */
export const consecutiveFailureLimit = 3;

/** §9: exponential, capped at five minutes. Reaches the ceiling on the seventh attempt. */
export function retryDelayMs(attempts: number): number {
	if (attempts <= 0) {
		return 0;
	}
	return Math.min(baseRetryDelayMs * 2 ** Math.min(attempts - 1, 16), maxRetryDelayMs);
}

export function classifyFailure(error: unknown): FailureKind {
	if (error instanceof UnauthorizedError) {
		return 'halt';
	}
	if (error instanceof DiskFullError) {
		return 'pause';
	}
	if (error instanceof TimeoutError) {
		return 'retry-all';
	}
	if (error instanceof ServerError) {
		return error.status >= 500 ? 'retry-all' : 'retry-item';
	}
	// Everything else is charged to the one file. A ConflictError arriving here means
	// #pushFile already exhausted its merge-and-retry rounds (sync.ts:189-203), so the
	// file is being rewritten from another device faster than this one can commit —
	// backing the whole queue off would stall every other file behind one hot note.
	return 'retry-item';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/plugin/src/engine/backoff.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the whole suite and commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/plugin/src/engine/backoff.ts packages/plugin/src/engine/backoff.test.ts
git commit -m "feat: add exponential retry backoff and failure classification"
```

---

## Task 3: The engine drains the queue

**Files:**
- Modify: `packages/plugin/src/engine/vault.ts` (add `stat` to `VaultAdapter`)
- Modify: `packages/plugin/src/obsidian/vault-adapter.ts` (implement `stat`)
- Modify: `packages/plugin/src/testing/memory-fixtures.ts` (implement `stat` on `MemoryVault`)
- Modify: `packages/plugin/src/testing/devices.ts` (one shared storage, a queue, a reusable-storage override)
- Modify: `packages/plugin/src/engine/sync.ts:32-46` (deps), `sync.ts:107-155` (`pushAll`), `sync.ts:214-237` (`#pushDelete`)
- Modify: `packages/plugin/src/engine/engine.test.ts:67,166,238` and `packages/plugin/src/engine/reconcile-engine.test.ts:83,106` (migrate `pushAll([...])`)
- Test: `packages/plugin/src/engine/queue-engine.test.ts`

**Interfaces:**
- Consumes: `PendingQueue`, `PendingItem`, `PendingIntent` from Task 1; `classifyFailure`, `retryDelayMs`, `maxRetryDelayMs`, `consecutiveFailureLimit`, `FailureKind` from Task 2.
- Produces: `SyncEngineDeps.queue: PendingQueue` (a required dependency — every construction site must supply one); `PushOptions { fullScan?: boolean | undefined }`; `PushReport { pushed: number; deleted: number; failed: number; stoppedEarly: boolean }`; `pushAll(options?: PushOptions): Promise<PushReport>`; `VaultAdapter.stat(path: string): Promise<VaultFile | undefined>`; `Device.queue` and `Device.storage`, plus `DeviceOverrides.storage`, on the test harness. Tasks 4 and 5 depend on all of these.

- [ ] **Step 1: Write the failing tests**

Create `packages/plugin/src/engine/queue-engine.test.ts`:

```ts
import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { computeFileId } from '../crypto/identity.js';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { type Device, fullSelective, makeDevice } from '../testing/devices.js';
import { FakeServer } from '../testing/fake-server.js';
import {
	ApiClient,
	type Requester,
	type SyncRequest,
	type SyncResponse,
	UnauthorizedError,
} from '../transport/client.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');

/** Fails only the commit call, so chunk upload succeeds and the drain reaches a decision. */
class FailingCommits implements Requester {
	readonly inner: FakeServer;
	status: number;
	commits = 0;

	constructor(inner: FakeServer, status: number) {
		this.inner = inner;
		this.status = status;
	}

	async request(request: SyncRequest): Promise<SyncResponse> {
		const isCommit = request.method === 'POST' && request.path.includes('/files/');
		if (isCommit) {
			this.commits += 1;
			return { status: this.status, arrayBuffer: new ArrayBuffer(0), json: () => undefined };
		}
		return this.inner.request(request);
	}
}

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

async function device(deviceId: string): Promise<Device> {
	return makeDevice({ server, keys, client }, deviceId);
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});

describe('the durable queue', () => {
	test('a delete queued offline survives a restart and reaches the server', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('gone.md', 'bye\n');
		await laptop.engine.pushAll();

		const fileId = await computeFileId(keys.nameMacKey, 'gone.md');
		expect(server.headOf(fileId)).toBeDefined();

		// The delete is recorded and persisted, and then the app dies before any push.
		await laptop.vault.remove('gone.md');
		laptop.queue.enqueue('gone.md', 'delete');
		await laptop.queue.save();

		// A restart: same vault, same durable state, a brand-new engine and queue object.
		const restarted = await makeDevice({ server, keys, client }, 'laptop', {
			vault: laptop.vault,
			storage: laptop.storage,
		});
		expect(restarted.queue.all().map((item) => item.path)).toEqual(['gone.md']);

		// fullScan off, so nothing but the queue itself could have produced this delete.
		const report = await restarted.engine.pushAll({ fullScan: false });

		expect(report.deleted).toBe(1);
		expect(server.headOf(fileId)).toBeUndefined();
		expect(restarted.queue.all()).toEqual([]);
	});

	test('a queue-driven push with nothing queued touches neither vault nor server', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		await laptop.engine.pushAll();

		server.requests.length = 0;
		const report = await laptop.engine.pushAll({ fullScan: false });

		expect(server.requests).toEqual([]);
		expect(report.pushed).toBe(0);
		expect(report.deleted).toBe(0);
		expect(report.failed).toBe(0);
		expect(report.stoppedEarly).toBe(false);
	});

	test('a server fault backs the whole queue off instead of attempting every file', async () => {
		const flaky = new FailingCommits(server, 503);
		const laptop = await makeDevice(
			{ server, keys, client: new ApiClient(flaky) },
			'laptop',
			{},
		);
		for (const path of ['a.md', 'b.md', 'c.md']) {
			laptop.vault.putText(path, 'content\n');
			laptop.queue.enqueue(path, 'upsert');
		}

		const report = await laptop.engine.pushAll({ fullScan: false });

		expect(flaky.commits).toBe(1);
		expect(report.stoppedEarly).toBe(true);
		expect(report.failed).toBe(1);
		expect(laptop.queue.all()).toHaveLength(3);
		expect(laptop.queue.pausedUntil()).toBeGreaterThan(Date.now());
	});

	test('a rejected token halts the drain without charging an attempt', async () => {
		const rejecting = new FailingCommits(server, 401);
		const laptop = await makeDevice(
			{ server, keys, client: new ApiClient(rejecting) },
			'laptop',
			{},
		);
		laptop.vault.putText('a.md', 'content\n');
		laptop.queue.enqueue('a.md', 'upsert');

		await expect(laptop.engine.pushAll({ fullScan: false })).rejects.toBeInstanceOf(
			UnauthorizedError,
		);

		const item = laptop.queue.all()[0];
		if (item === undefined) {
			throw new Error('expected the item to stay queued after a halt');
		}
		// §9: a corrected token resumes at full speed rather than inside a backoff window.
		expect(item.attempts).toBe(0);
	});

	test('an oversized file is parked and does not stall the file behind it', async () => {
		const laptop = await makeDevice({ server, keys, client }, 'laptop', {
			selective: { ...fullSelective, maxFileBytes: 16 },
		});
		laptop.vault.putText('huge.md', 'x'.repeat(64));
		laptop.vault.putText('small.md', 'tiny\n');
		laptop.queue.enqueue('huge.md', 'upsert');
		laptop.queue.enqueue('small.md', 'upsert');

		const report = await laptop.engine.pushAll({ fullScan: false });

		expect(report.pushed).toBe(1);
		expect(report.failed).toBe(0);
		expect(laptop.queue.blockedItems().map((item) => item.path)).toEqual(['huge.md']);
		expect(server.headOf(await computeFileId(keys.nameMacKey, 'small.md'))).toBeDefined();
		expect(server.headOf(await computeFileId(keys.nameMacKey, 'huge.md'))).toBeUndefined();
	});

	test('a queued upsert whose file has vanished becomes a delete', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('note.md', 'hello\n');
		await laptop.engine.pushAll();

		// The removal happened while the plugin was not running, so no event recorded it
		// and the stale upsert is all the queue has.
		await laptop.vault.remove('note.md');
		laptop.queue.enqueue('note.md', 'upsert');
		await laptop.engine.pushAll({ fullScan: false });

		expect(laptop.queue.ready(Date.now(), 'delete').map((item) => item.path)).toEqual([
			'note.md',
		]);
	});

	test('an excluded path leaves the queue without being deleted from the server', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('Private/secret.md', 'hush\n');
		await laptop.engine.pushAll();

		const fileId = await computeFileId(keys.nameMacKey, 'Private/secret.md');
		expect(server.headOf(fileId)).toBeDefined();

		// Excluding a folder means "stop syncing this", never "remove it from the server".
		laptop.engine.updateSelective({ ...fullSelective, excludedFolders: ['Private'] });
		await laptop.vault.remove('Private/secret.md');
		laptop.queue.enqueue('Private/secret.md', 'delete');
		const report = await laptop.engine.pushAll({ fullScan: false });

		expect(report.deleted).toBe(0);
		expect(server.headOf(fileId)).toBeDefined();
		expect(laptop.queue.all()).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/plugin/src/engine/queue-engine.test.ts`
Expected: FAIL — `laptop.queue` and `laptop.storage` do not exist on `Device`, and `pushAll` does not accept `PushOptions`.

- [ ] **Step 3: Add `stat` to the vault surface**

In `packages/plugin/src/engine/vault.ts`, add to the `VaultAdapter` interface, directly under `exists`:

```ts
	/** One path's stat, so a queued push costs no whole-vault listing. */
	stat(path: string): Promise<VaultFile | undefined>;
```

In `packages/plugin/src/obsidian/vault-adapter.ts`, add a method to the returned object, directly after `exists`:

```ts
		async stat(path) {
			const target = normalizePath(path);
			if (isConfig(target)) {
				const found = await adapter.stat(target).catch(() => null);
				if (found === null || found.type !== 'file') {
					return undefined;
				}
				return { path: target, mtime: found.mtime, size: found.size, ctime: found.ctime };
			}
			const file = asTFile(target);
			return file === null ? undefined : toVaultFile(file);
		},
```

Append to `packages/plugin/src/obsidian/vault-adapter.test.ts` — `FakeApp` already models `adapter.stat` (`testing/fake-app.ts:94-107`), so no fixture change is needed:

```ts
describe('stat', () => {
	test('reports size for a note and for a config file', async () => {
		await adapter.write('notes/idea.md', encode('hello\n'));
		await adapter.write('.obsidian/plugins/other/data.json', encode('{}\n'));

		const note = await adapter.stat('notes/idea.md');
		const config = await adapter.stat('.obsidian/plugins/other/data.json');
		if (note === undefined || config === undefined) {
			throw new Error('expected both files to stat');
		}
		expect(note.size).toBe(6);
		expect(config.size).toBe(3);
	});

	test('a missing path stats as undefined rather than throwing', async () => {
		expect(await adapter.stat('nope.md')).toBeUndefined();
	});

	test('a folder is not a file', async () => {
		await adapter.write('notes/idea.md', encode('hello\n'));
		expect(await adapter.stat('notes')).toBeUndefined();
	});
});
```

In `packages/plugin/src/testing/memory-fixtures.ts`, add to `MemoryVault`, directly after `exists`:

```ts
	async stat(path: string): Promise<VaultFile | undefined> {
		const file = this.#files.get(path);
		if (this.#blind || file === undefined) {
			return undefined;
		}
		return { path, mtime: file.mtime, size: file.data.length, ctime: file.ctime };
	}
```

- [ ] **Step 4: Give the test harness a queue and a shared, reusable storage**

In `packages/plugin/src/testing/devices.ts`, add the import and replace `DeviceOverrides`, `Device`, and `makeDevice`:

```ts
import { PendingQueue } from '../state/pending-queue.js';
```

```ts
export interface DeviceOverrides {
	/** Reuse an existing vault, so a device can be rebuilt with its files but no index. */
	vault?: MemoryVault;
	/** Reuse the durable state, so a rebuilt device keeps its index, bases, and queue. */
	storage?: MemoryStorage;
	selective?: SelectiveSyncOptions;
}

export interface Device {
	engine: SyncEngine;
	vault: MemoryVault;
	storage: MemoryStorage;
	index: FileIndex;
	bases: BaseCache;
	queue: PendingQueue;
	local: LocalState;
	conflicts: ConflictRecord[];
	deps: SyncEngineDeps;
}

export async function makeDevice(
	context: DeviceContext,
	deviceId: string,
	overrides: DeviceOverrides = {},
): Promise<Device> {
	const vault = overrides.vault ?? new MemoryVault();
	// One storage for all three stores, as production has: they are distinct keys under
	// one state directory, and sharing it is what makes a restart expressible as a test.
	const storage = overrides.storage ?? new MemoryStorage();
	const index = new FileIndex(storage);
	const bases = new BaseCache(storage);
	const queue = new PendingQueue(storage);
	const { local } = memoryLocalState();
	await index.load();
	await bases.load();
	await queue.load();
	const conflicts: ConflictRecord[] = [];
	const deps: SyncEngineDeps = {
		vaultId: context.server.vaultId,
		client: context.client,
		keys: context.keys,
		vault,
		index,
		bases,
		local,
		queue,
		selective: overrides.selective ?? fullSelective,
		deviceId,
		onConflict: (conflict) => conflicts.push(conflict),
	};
	return {
		engine: new SyncEngine(deps),
		vault,
		storage,
		index,
		bases,
		queue,
		local,
		conflicts,
		deps,
	};
}
```

- [ ] **Step 5: Rewrite the push path**

In `packages/plugin/src/engine/sync.ts`, add the imports:

```ts
import type { PendingItem, PendingQueue } from '../state/pending-queue.js';
import {
	classifyFailure,
	consecutiveFailureLimit,
	maxRetryDelayMs,
	retryDelayMs,
} from './backoff.js';
```

Add `queue` to `SyncEngineDeps` (after `local`, `sync.ts:39`):

```ts
	queue: PendingQueue;
```

Add these types next to `ConflictRecord` (`sync.ts:20-23`):

```ts
export interface PushOptions {
	/**
	 * Also walk the whole vault, so a change with no watcher event behind it is still
	 * found. Off for a watcher- or nudge-driven run, where the queue is authoritative
	 * and the scan costs one read plus one hash for every file in the vault.
	 */
	fullScan?: boolean | undefined;
}

export interface PushReport {
	pushed: number;
	deleted: number;
	failed: number;
	/** Set when the drain gave up on the whole queue; the caller schedules the retry. */
	stoppedEarly: boolean;
	/** Why it gave up, for the notice and the status view. A message, never a secret. */
	stoppedBecause?: string | undefined;
}

/** What one attempt settled: pushed, already matching the index, re-queued, or parked. */
type PushOutcome = 'pushed' | 'clean' | 'requeued' | 'oversize';
```

Replace `pushAll` (`sync.ts:107-155`) entirely with:

```ts
	/**
	 * Drain the durable queue, then — when asked — compare the vault against the index
	 * to catch whatever no vault event reported (§7.1, §9).
	 *
	 * Removals precede content writes in both halves, so a queue drained after a long
	 * offline period replays coherently instead of recreating what it is about to
	 * remove. The stores are saved in `finally`, so a halt part-way through still
	 * persists the work that did land.
	 */
	async pushAll(options: PushOptions = {}): Promise<PushReport> {
		const { vault, index, bases, queue } = this.#deps;
		const fullScan = options.fullScan ?? true;
		const report: PushReport = { pushed: 0, deleted: 0, failed: 0, stoppedEarly: false };
		const handled = new Set<string>();
		this.#status('syncing');
		try {
			const now = Date.now();
			// Listed once and shared: it is both the dirty-file source and the evidence
			// that the vault can see itself at all.
			const listed = fullScan ? await vault.list() : [];
			if (listed.length > 0) {
				this.#sawVault = true;
			}

			let draining = await this.#drain(queue.ready(now, 'delete'), report, handled);
			// Absence only means "deleted" once this session has seen the vault list its
			// contents at least once. Before that an empty listing is a vault that cannot
			// see itself yet, and treating it as a mass delete would wipe the server.
			if (draining && fullScan && this.#sawVault) {
				draining = await this.#drain(await this.#enqueueAbsent(handled), report, handled);
			}
			if (draining) {
				draining = await this.#drain(queue.ready(now, 'upsert'), report, handled);
			}
			if (draining && fullScan) {
				await this.#pushDirty(listed, report, handled);
			}
			return report;
		} finally {
			await index.save();
			await bases.save();
			await queue.save();
			this.#status('idle');
		}
	}

	/**
	 * Attempt each due item, isolating per-file failures: §9 requires that one
	 * unpushable file never stall the queue behind it. Returns false once the drain has
	 * given up on the whole queue, so the caller skips every phase after it.
	 */
	async #drain(items: PendingItem[], report: PushReport, handled: Set<string>): Promise<boolean> {
		const { queue } = this.#deps;
		let consecutiveFailures = 0;
		for (const item of items) {
			handled.add(item.path);
			// Excluding a path means "stop syncing this", never "remove it from the server",
			// so an excluded item leaves the queue without being pushed either way.
			if (!isPathIncluded(item.path, this.#selective)) {
				queue.forget(item.path);
				continue;
			}
			try {
				const outcome = await this.#attempt(item);
				if (outcome === 'requeued') {
					continue;
				}
				if (outcome === 'oversize') {
					queue.block(item.path, 'oversize');
					consecutiveFailures = 0;
					continue;
				}
				if (outcome === 'pushed') {
					if (item.intent === 'delete') {
						report.deleted += 1;
					} else {
						report.pushed += 1;
					}
				}
				queue.succeed(item.path);
				consecutiveFailures = 0;
			} catch (error) {
				if (!this.#recordFailure(item.path, item.attempts, error, report)) {
					return false;
				}
				consecutiveFailures += 1;
				if (consecutiveFailures >= consecutiveFailureLimit) {
					queue.pause(Date.now() + retryDelayMs(item.attempts + 1));
					report.stoppedEarly = true;
					report.stoppedBecause = `${consecutiveFailures} files in a row failed to push`;
					return false;
				}
			}
		}
		return true;
	}

	async #attempt(item: PendingItem): Promise<PushOutcome> {
		if (item.intent === 'delete') {
			return (await this.#pushDelete(item.path)) ? 'pushed' : 'clean';
		}
		return this.#pushQueuedUpsert(item.path);
	}

	/**
	 * Record one failure and say whether the drain may continue. Throws on `halt`,
	 * which §9 reserves for a rejected token: sync stops rather than looping against a
	 * server that is refusing it, and the item keeps `attempts: 0` so a corrected token
	 * resumes at full speed instead of inside a backoff window.
	 */
	#recordFailure(path: string, attempts: number, error: unknown, report: PushReport): boolean {
		const { queue } = this.#deps;
		const kind = classifyFailure(error);
		if (kind === 'halt') {
			throw error;
		}
		const now = Date.now();
		const delay = retryDelayMs(attempts + 1);
		const message = error instanceof Error ? error.message : 'unknown failure';
		queue.fail(path, delay, now, message);
		report.failed += 1;
		if (kind === 'pause') {
			queue.pause(now + maxRetryDelayMs);
			report.stoppedEarly = true;
			report.stoppedBecause = message;
			return false;
		}
		if (kind === 'retry-all') {
			queue.pause(now + delay);
			report.stoppedEarly = true;
			report.stoppedBecause = message;
			return false;
		}
		return true;
	}

	/** Push one queued path, reporting how the attempt settled. */
	async #pushQueuedUpsert(path: string): Promise<PushOutcome> {
		const { vault, index, queue } = this.#deps;
		const file = await vault.stat(path);
		if (file === undefined) {
			// The change this item records was superseded by a removal no watcher saw,
			// because the app was not running when it happened. Absence is the delete.
			queue.enqueue(path, 'delete');
			return 'requeued';
		}
		if (file.size > this.#selective.maxFileBytes) {
			return 'oversize';
		}
		const data = await vault.read(path);
		const known = index.get(path);
		// The engine's own pull writes fire a modify event, so without this every pulled
		// file would be pushed straight back to the device it came from.
		if (known !== undefined && known.hash === (await hashBytes(data))) {
			return 'clean';
		}
		await this.#pushFile(file, data);
		return 'pushed';
	}

	/**
	 * Re-derive deletes from absence: a removal made while the plugin was not running
	 * raises no vault event, so an indexed path that is gone locally is one. Paths the
	 * queue already tracks are left alone, so a scan never resets a failing item's
	 * backoff and re-hammers the server on every sync.
	 */
	async #enqueueAbsent(handled: Set<string>): Promise<PendingItem[]> {
		const { vault, index, queue } = this.#deps;
		const tracked = new Set(queue.all().map((item) => item.path));
		for (const entry of index.entries()) {
			if (handled.has(entry.path) || tracked.has(entry.path)) {
				continue;
			}
			if (isPathIncluded(entry.path, this.#selective) && !(await vault.exists(entry.path))) {
				queue.enqueue(entry.path, 'delete');
			}
		}
		return queue.ready(Date.now(), 'delete').filter((item) => !handled.has(item.path));
	}

	/**
	 * The whole-vault comparison: one read and one hash per file, which is why it runs
	 * only when the caller asks for it. It is what finds a change no vault event
	 * reported — one made while the plugin was not running, or by another program.
	 *
	 * A file that fails here is handed to the queue rather than retried in place, so
	 * the failure becomes durable and picks up the same backoff a queued push gets.
	 */
	async #pushDirty(
		listed: VaultFile[],
		report: PushReport,
		handled: Set<string>,
	): Promise<boolean> {
		const { vault, index, queue } = this.#deps;
		const tracked = new Set(queue.all().map((item) => item.path));
		let consecutiveFailures = 0;
		for (const file of listed) {
			if (handled.has(file.path) || tracked.has(file.path)) {
				continue;
			}
			if (!isPathIncluded(file.path, this.#selective)) {
				continue;
			}
			if (file.size > this.#selective.maxFileBytes) {
				// Queued purely so §9's "named in the status view" has something to name.
				queue.enqueue(file.path, 'upsert');
				queue.block(file.path, 'oversize');
				continue;
			}
			const data = await vault.read(file.path);
			const known = index.get(file.path);
			if (known !== undefined && known.hash === (await hashBytes(data))) {
				continue;
			}
			try {
				await this.#pushFile(file, data);
				report.pushed += 1;
				consecutiveFailures = 0;
			} catch (error) {
				queue.enqueue(file.path, 'upsert');
				if (!this.#recordFailure(file.path, 0, error, report)) {
					return false;
				}
				consecutiveFailures += 1;
				if (consecutiveFailures >= consecutiveFailureLimit) {
					queue.pause(Date.now() + retryDelayMs(1));
					report.stoppedEarly = true;
					report.stoppedBecause = `${consecutiveFailures} files in a row failed to push`;
					return false;
				}
			}
		}
		return true;
	}
```

Then change `#pushDelete` (`sync.ts:214-237`) to report whether it actually deleted anything. Keep its two guards and their comments exactly as they are; change only the signature and the three returns:

```ts
	/** Push one local delete. Returns false when the queued removal no longer applies. */
	async #pushDelete(path: string): Promise<boolean> {
		const { vaultId, client, vault, index, bases } = this.#deps;
		const known = index.get(path);
		if (known === undefined) {
			return false;
		}
		// A queued delete is stale the moment the path exists again, whether a pull
		// restored it or the user recreated it. Pushing it anyway destroys live
		// content — and because the engine's own trash call is itself reported by the
		// watcher as a user delete, two devices will otherwise delete and recreate the
		// same file at each other indefinitely.
		if (await vault.exists(path)) {
			return false;
		}
		try {
			await client.delete(vaultId, known.fileId, known.versionId);
		} catch (error) {
			if (!(error instanceof ConflictError)) {
				throw error;
			}
		}
		index.delete(path);
		bases.delete(known.fileId);
		return true;
	}
```

- [ ] **Step 6: Migrate the five existing `pushAll([...])` call sites**

Each is the same mechanical change: queue the delete, then push with no argument so the full scan still runs exactly as before.

In `packages/plugin/src/engine/engine.test.ts`, replace line 67, line 166, and line 238 respectively:

```ts
		laptop.queue.enqueue('gone.md', 'delete');
		await laptop.engine.pushAll();
```

```ts
		laptop.queue.enqueue('note.md', 'delete');
		await laptop.engine.pushAll();
```

```ts
		laptop.queue.enqueue('note.md', 'delete');
		await laptop.engine.pushAll();
```

In `packages/plugin/src/engine/reconcile-engine.test.ts`, replace line 83 and line 106 respectively:

```ts
		laptop.queue.enqueue('gone.md', 'delete');
		await laptop.engine.pushAll();
```

```ts
		laptop.queue.enqueue('note.md', 'delete');
		await laptop.engine.pushAll();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run packages/plugin/src/engine/`
Expected: PASS — the 7 new queue tests plus every pre-existing engine and reconcile test, unchanged in meaning.

If `engine.test.ts:238` ("Assert on the change log, not the end state") fails, the `vault.exists` guard in `#pushDelete` has been weakened. Restore it rather than adjusting the test: that test exists because without the guard two devices delete and recreate the same file at each other forever.

- [ ] **Step 8: Verify the whole suite and commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/plugin/src/engine/ packages/plugin/src/testing/ packages/plugin/src/obsidian/vault-adapter.ts
git commit -m "feat: drain the durable queue from the push path"
```

---

## Task 4: The plugin owns the queue

**Files:**
- Create: `packages/plugin/src/obsidian/retry-timer.ts`
- Test: `packages/plugin/src/obsidian/retry-timer.test.ts`
- Modify: `packages/plugin/src/main.ts` — `#pendingDeletes` (line 72), `#registerCommands` (line 152), `reloadEngine` (line 218), `#buildEngine` (lines 259-263), `#startNudge`'s `onUnauthorized` (lines 302-305), `#startWatcher` (lines 341-349), `requestSync` (line 355), `#runSync` (lines 381-419), `reconcile` (line 444), `#stopEngine` (lines 560-569)

**Interfaces:**
- Consumes: `PendingQueue` from Task 1; `PushReport` and `PushOptions` from Task 3; `UnauthorizedError` from `transport/client.js`.
- Produces: `wakeDelayMs(readyAt: number | undefined, now: number): number | undefined`; on `SyncPlugin`, a public `syncNow(): Promise<void>` and a `pendingQueue: PendingQueue | undefined` getter. Task 5 reads the getter.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin/src/obsidian/retry-timer.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { wakeDelayMs } from './retry-timer.js';

describe('wakeDelayMs', () => {
	test('an empty queue needs no timer at all', () => {
		expect(wakeDelayMs(undefined, 1_000)).toBeUndefined();
	});

	test('an item already due still waits out the floor', () => {
		// Waking instantly would re-enter the sync the caller is still inside.
		expect(wakeDelayMs(500, 1_000)).toBe(1_000);
		expect(wakeDelayMs(1_000, 1_000)).toBe(1_000);
	});

	test('an item inside the window waits exactly as long as it asked', () => {
		expect(wakeDelayMs(31_000, 1_000)).toBe(30_000);
	});

	test('the wait never exceeds the five-minute ceiling', () => {
		expect(wakeDelayMs(1_000 + 60 * 60 * 1_000, 1_000)).toBe(300_000);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/plugin/src/obsidian/retry-timer.test.ts`
Expected: FAIL — `Failed to resolve import "./retry-timer.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin/src/obsidian/retry-timer.ts`:

```ts
import { maxRetryDelayMs } from '../engine/backoff.js';

/** Never wake sooner than this: an instant retry re-enters the run that scheduled it. */
const minimumWakeMs = 1_000;

/**
 * How long to wait before retrying the queue, given the moment its earliest item
 * becomes attemptable. Undefined means nothing is waiting, so no timer is needed.
 *
 * The nudge channel only reports *other* devices' work, so without this timer a push
 * that failed while the vault was otherwise quiet would not be retried until the
 * user next edited something.
 */
export function wakeDelayMs(readyAt: number | undefined, now: number): number | undefined {
	if (readyAt === undefined) {
		return undefined;
	}
	return Math.min(Math.max(readyAt - now, minimumWakeMs), maxRetryDelayMs);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/plugin/src/obsidian/retry-timer.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the queue into the plugin**

In `packages/plugin/src/main.ts`, add `UnauthorizedError` to the existing client import (line 39) and add two more:

```ts
import { ApiClient, UnauthorizedError } from './transport/client.js';
import { wakeDelayMs } from './obsidian/retry-timer.js';
import { PendingQueue } from './state/pending-queue.js';
```

Biome sorts imports; `pnpm lint:fix` will place them.

Replace the `#pendingDeletes` field (line 72) with:

```ts
	#queue: PendingQueue | null = null;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#halted = false;
	#scannedThisSession = false;
	#fullScanRequested = false;
```

Add a getter next to `pendingConflicts` (lines 62-64):

```ts
	get pendingQueue(): PendingQueue | undefined {
		return this.#queue ?? undefined;
	}
```

In `#buildEngine`, replace the state-store lines (lines 259-263) with a single shared storage:

```ts
		const stateDir = `.obsidian/plugins/${pluginId}/state`;
		const storage = createStateStorage(this.app.vault, stateDir);
		const index = new FileIndex(storage);
		const bases = new BaseCache(storage);
		const queue = new PendingQueue(storage);
		await index.load();
		await bases.load();
		await queue.load();
		this.#queue = queue;
```

and add `queue,` to the `new SyncEngine({ ... })` argument, after `local,`.

Replace `#startWatcher` (lines 341-349):

```ts
	#startWatcher(): void {
		this.#watcher = new DebouncedWatcher(
			this.app.vault,
			this.settings.debounceMs,
			async (batch) => {
				// Persisted before the sync is even requested. Losing an enqueue loses user
				// work; losing a completion only replays a push the index already satisfies,
				// which is §7.2's cursor rule run backwards. A throw here is caught by the
				// watcher, which puts the whole batch back into its own dirty sets.
				this.#queue?.enqueueBatch(batch);
				await this.#queue?.save();
				await this.requestSync();
			},
		);
		this.#watcher.start();
	}
```

Add the halt guard at the top of `requestSync` (line 355):

```ts
		if (this.#halted) {
			return;
		}
```

Replace `#runSync` (lines 381-419):

```ts
	async #runSync(): Promise<void> {
		if (this.#engine === null) {
			await this.reloadEngine();
			return;
		}
		const reconciling = this.#reconcileRequested;
		this.#reconcileRequested = undefined;
		// The whole-vault comparison runs only when the queue cannot be trusted on its
		// own: the first pass of a session, a reconcile, or a sync the user asked for.
		// Every other run is watcher- or nudge-driven, where the queue already holds
		// every local change and the scan would read and hash the entire vault for it.
		const fullScan = reconciling !== undefined || this.#fullScanRequested || !this.#scannedThisSession;
		this.#fullScanRequested = false;
		try {
			this.#setStatus('syncing');
			if (reconciling === undefined) {
				await this.#engine.pullAll();
			} else {
				const summary = await this.#engine.reconcile();
				this.lastReconcile = summary;
				if (reconciling === 'announce') {
					new Notice(describeReconcile(summary));
				}
				if (summary.massDeleteGuarded) {
					new Notice(
						'Obsidian Sync: the server listed no files, so nothing was removed locally. Check the vault name and token.',
					);
				}
			}
			const report = await this.#engine.pushAll({ fullScan });
			// Only a pass that actually finished counts: a drain that gave up early may
			// never have reached the vault walk at all.
			if (fullScan && !report.stoppedEarly) {
				this.#scannedThisSession = true;
			}
			this.lastSyncAt = Date.now();
			if (report.stoppedEarly) {
				// §9: a paused queue surfaces its cause rather than retrying into a wall.
				this.#setStatus('error');
				new Notice(`Obsidian Sync paused uploads: ${report.stoppedBecause ?? 'the server failed'}.`);
			} else {
				this.#setStatus('idle');
			}
			this.#scheduleRetry();
		} catch (error) {
			// A reconcile that failed is still owed; the next run picks it up. Nothing is
			// owed for the pushes: the queue kept them, and kept their backoff with them.
			this.#reconcileRequested = reconciling;
			this.#setStatus('error');
			this.#logError(error);
			if (error instanceof UnauthorizedError) {
				this.#halt();
				return;
			}
			this.#scheduleRetry();
		}
	}

	/**
	 * §9: a rejected token stops sync outright rather than retrying into a wall. The
	 * queue is left untouched, so everything pending is still there once the token is
	 * corrected and `reloadEngine` lifts this.
	 */
	#halt(): void {
		this.#halted = true;
		this.#clearRetry();
		this.#nudge?.stop();
		this.#nudge = null;
		new Notice('Obsidian Sync: the server rejected the token. Sync is stopped until it is fixed.');
	}

	/**
	 * Wake when the queue's earliest backoff expires. The nudge channel reports only
	 * other devices' work, so without this a push that failed while the vault was
	 * otherwise quiet would wait for the next edit before being retried at all.
	 */
	#scheduleRetry(): void {
		this.#clearRetry();
		const delay = wakeDelayMs(this.#queue?.readyAt(), Date.now());
		if (delay === undefined) {
			return;
		}
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			void this.requestSync();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}

	/**
	 * A sync the user asked for explicitly: it lifts a backoff pause and compares the
	 * whole vault, because "Sync now" means "make sure", not "drain what is queued".
	 */
	async syncNow(): Promise<void> {
		this.#halted = false;
		this.#queue?.resume();
		this.#fullScanRequested = true;
		await this.requestSync();
	}
```

Point the *Sync now* command at it (line 152):

```ts
		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow() });
```

Lift the pause for a reconcile too — in `reconcile`, directly before `await this.requestSync()` (line 444):

```ts
		this.#queue?.resume();
```

Route the nudge's 401 through the same halt (lines 302-305):

```ts
		const onUnauthorized = (): void => {
			this.#setStatus('error');
			this.#halt();
		};
```

Clear the halt when the engine is rebuilt — in `reloadEngine`, directly after `this.#stopEngine()` (line 218):

```ts
		this.#halted = false;
```

And extend `#stopEngine` (lines 560-569) with:

```ts
		this.#clearRetry();
		this.#queue = null;
		this.#scannedThisSession = false;
		this.#fullScanRequested = false;
```

- [ ] **Step 6: Confirm the in-memory queue is gone, then verify and commit**

`#pendingDeletes` had four call sites; all four are replaced above. Confirm none survives:

```bash
grep -n 'pendingDeletes' packages/plugin/src/main.ts
```
Expected: no output.

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/plugin/src/obsidian/retry-timer.ts packages/plugin/src/obsidian/retry-timer.test.ts packages/plugin/src/main.ts
git commit -m "feat: persist the offline queue and retry it with backoff"
```

- [ ] **Step 7: Check it by hand in a real vault**

`main.ts` has no automated coverage — it is the one module that needs a live Obsidian — so this task's wiring is verified manually. Build with `node packages/plugin/esbuild.config.mjs`, reload the plugin, and confirm:

1. Delete a note with the server stopped. `.obsidian/plugins/obsidian-sync/state/queue.json` gains a `delete` entry within the debounce window.
2. Force-quit Obsidian. Reopen it with the server still stopped. The entry is still there, with a non-zero `attempts` and a `nextAttemptAt` in the future.
3. Start the server. The note disappears from the other device within five minutes without anyone touching Obsidian — that is the retry timer, not a nudge.
4. Type in a note with the server running. `queue.json` returns to `{"items":[],"pausedUntil":0}` after the sync.

---

## Task 5: Surface the queue

**Files:**
- Modify: `packages/plugin/src/obsidian/status-display.ts`
- Modify: `packages/plugin/src/obsidian/status-view.ts:47-53` (the reconcile block) and `:71` (the *Sync now* button)
- Modify: `packages/plugin/src/main.ts` — `#updateStatusTooltip` (lines 523-530)
- Modify: `README.md:24`, `README.md:280-286`, `README.md:332`
- Test: `packages/plugin/src/obsidian/status-display.test.ts`

**Interfaces:**
- Consumes: `SyncPlugin.pendingQueue` from Task 4; `PendingQueue.depth()`, `blockedItems()`, `readyAt()` from Task 1.
- Produces: `statusTooltip(status, lastSyncAt, conflicts, pending)` — a fourth parameter; `relativeFuture(at: number): string`.

- [ ] **Step 1: Write the failing tests**

Create `packages/plugin/src/obsidian/status-display.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { relativeFuture, statusTooltip } from './status-display.js';

describe('statusTooltip', () => {
	test('a settled client says only what it is and when it last synced', () => {
		expect(statusTooltip('idle', 0, 0, 0)).toBe('Idle · never synced');
	});

	test('a queued push is reported, so a stalled sync is visible without opening a view', () => {
		expect(statusTooltip('error', 0, 0, 3)).toBe('Error · never synced · 3 queued');
	});

	test('conflicts and queue depth coexist, and one conflict is singular', () => {
		expect(statusTooltip('conflict', 0, 1, 2)).toBe(
			'Conflict · never synced · 2 queued · 1 conflict',
		);
		expect(statusTooltip('conflict', 0, 2, 0)).toBe('Conflict · never synced · 2 conflicts');
	});
});

describe('relativeFuture', () => {
	test('a moment already past reads as immediate rather than negative', () => {
		expect(relativeFuture(Date.now() - 10_000)).toBe('in 0s');
	});

	test('seconds below a minute, whole minutes above it', () => {
		expect(relativeFuture(Date.now() + 45_000)).toBe('in 45s');
		expect(relativeFuture(Date.now() + 180_000)).toBe('in 3m');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/plugin/src/obsidian/status-display.test.ts`
Expected: FAIL — `relativeFuture` is not exported, and `statusTooltip` takes three arguments.

- [ ] **Step 3: Extend the display helpers**

In `packages/plugin/src/obsidian/status-display.ts`, replace `statusTooltip` and add `relativeFuture`:

```ts
export function statusTooltip(
	status: EngineStatus,
	lastSyncAt: number,
	conflicts: number,
	pending: number,
): string {
	const parts = [statusLabel(status)];
	parts.push(lastSyncAt === 0 ? 'never synced' : `last synced ${relativeTime(lastSyncAt)}`);
	if (pending > 0) {
		parts.push(`${pending} queued`);
	}
	if (conflicts > 0) {
		parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
	}
	return parts.join(' · ');
}

/** The mirror of relativeTime, for a retry that has not happened yet. */
export function relativeFuture(at: number): string {
	const seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
	if (seconds < 60) {
		return `in ${seconds}s`;
	}
	return `in ${Math.round(seconds / 60)}m`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/plugin/src/obsidian/status-display.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Feed the tooltip and the status view**

In `packages/plugin/src/main.ts`, replace the body of `#updateStatusTooltip` after the null guard (lines 528-529):

```ts
		const depth = this.#queue?.depth();
		const pending = depth === undefined ? 0 : depth.upserts + depth.deletes;
		// "last synced 2m ago" ages between renders, so recompute it as the pointer arrives.
		setTooltip(
			item,
			statusTooltip(this.lastStatus, this.lastSyncAt, this.pendingConflicts.length, pending),
		);
```

In `packages/plugin/src/obsidian/status-view.ts`, import `relativeFuture` alongside the existing helpers, and insert this directly after the `reconcile` block (line 53), before the conflicts block:

```ts
		const queue = this.#plugin.pendingQueue;
		const depth = queue?.depth();
		if (queue !== undefined && depth !== undefined && depth.upserts + depth.deletes > 0) {
			const pending = root.createDiv({ cls: 'obsidian-sync-status__queue' });
			pending.createDiv({
				text: `Queued: ${depth.upserts} to upload, ${depth.deletes} to delete`,
			});
			const retryAt = queue.readyAt();
			if (retryAt !== undefined && retryAt > Date.now()) {
				pending.createDiv({ text: `Next attempt ${relativeFuture(retryAt)}` });
			}
		}
		// §9: an oversized file is skipped and named, and never stalls the queue behind it.
		for (const item of queue?.blockedItems() ?? []) {
			root.createDiv({
				cls: 'obsidian-sync-status__skipped',
				text: `Skipped, too large: ${item.path}`,
			});
		}
```

Point the view's *Sync now* button at the user-initiated path, replacing line 71:

```ts
			.addEventListener('click', () => void this.#plugin.syncNow());
```

- [ ] **Step 6: Update the README**

Replace the **Offline-correct** row (line 24) with:

```markdown
| **Offline-correct** | Edit on a plane, land, and converge. Pending pushes and deletes are written to disk before they are attempted, so they survive a crash or a force-quit, and they retry with exponential backoff capped at five minutes. The cursor advances only after a batch is applied, so a crash replays rather than skips. |
```

Add a section directly after the **Reconcile** section (after line 286, before `## What is never synced`):

```markdown
## Offline queue

Every local change is recorded in `queue.json` inside the plugin's state directory *before* it is attempted, and removed only once the server has acknowledged it. A force-quit mid-upload therefore costs a replay, never the change itself — and a replay is free, because a push whose bytes already match the index is skipped.

Removals are drained ahead of content writes, so a queue emptied after a long flight replays coherently instead of recreating what it is about to delete. A failed item backs off exponentially to a five-minute ceiling, and the backoff is persisted with it: closing Obsidian does not reset the clock on a server that is refusing writes.

One bad file never stalls the ones behind it. An oversized file is parked and named in the status view rather than retried; a rejected token stops sync outright instead of looping against a server that will not have it; a full server disk pauses uploads and says so.

The whole-vault comparison still runs on plugin load, on a reconcile, and on an explicit *Sync now* — that is what finds a change made while Obsidian was closed. Ordinary edit-driven syncs skip it and push only what is queued.
```

Delete the offline-queue bullet from **Not yet implemented** (line 332), leaving the other three.

- [ ] **Step 7: Verify the whole suite and commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/plugin/src/obsidian/ packages/plugin/src/main.ts README.md
git commit -m "feat: show queue depth, retry time, and skipped files in the sync status"
```

---

## Out of scope, deliberately

- **A queue for pulls.** The pull side already has a durable cursor (§7.2) and needs no second mechanism.
- **Per-chunk resume.** A push interrupted mid-upload re-uploads its chunks; `blobs/check` makes that nearly free, because every chunk that landed is already present by address.
- **Progress reporting during a push** ("current file, transferred of total bytes", §6.3.2). The queue now carries the information a progress view would need, but the view itself is a separate piece of work.
- **Pause and resume as user-facing commands** (§6.3.7). `PendingQueue.pause`/`resume` exist and are used by the backoff, but no command is wired to them here.
- **Rename as a first-class operation.** `fileId` is `MAC(path)`, so a rename is a delete plus a create by construction (§4.2), and the queue's delete-before-upsert ordering is exactly what makes that replay correctly. Nothing else is needed unless file identity changes.
- **Jitter on the retry curve.** See *Decisions taken*.
- **§9's "persistent settings warning" on a 401.** The halt is implemented — sync stops, the nudge channel closes, a notice names the cause, and the status bar and status view both sit at `error` until the token is fixed — but the inline warning on the *Auth token* setting row (`status: 'warning'`, §6.2) is not. That belongs with the settings tab, which this plan does not touch.

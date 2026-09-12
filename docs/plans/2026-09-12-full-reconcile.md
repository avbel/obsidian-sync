# Full Reconcile Against `GET /state` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the *Full reconcile* command do what its name says — compare the whole local vault against `GET /v1/vaults/:v/state` and repair anything the incremental cursor could not have seen — instead of running an ordinary incremental sync.

**Architecture:** Reconcile is a diff, and the diff is the part with all the edge cases, so it is split out as a **pure function** (`planReconcile`) over three plain inputs: the server's file list, the local index, and the size limit. The engine keeps the I/O: it fetches one snapshot, executes the plan through the *existing* `#applyRemoteFile` / `#applyRemoteDelete` paths so §8's conflict table governs reconcile exactly as it governs a pull, then adopts the snapshot's sequence as the durable cursor. No protocol change, no server change, no new endpoint — `GET /state` already returns everything needed and already reads its `seq` **before** listing files, which is what makes adopting that `seq` safe.

**Tech Stack:** TypeScript 7, ESM, Vitest 4 against `FakeServer` + `MemoryVault`, Obsidian 1.13 plugin API (`Notice`, `ItemView`), Biome.

**Spec:** `docs/specs/2026-09-10-obsidian-sync-design.md` (§7.2 pull, §7.4 reconcile, §8 conflict resolution, §9 error handling)

**Prior plans:** `docs/plans/2026-09-10-server-and-protocol.md`, `docs/plans/2026-09-12-conflict-resolution-modal.md`. Their Global Constraints apply here in full.

## Global Constraints

These bind every task. Do not restate them in review; do not violate them.

- **Runtime:** TypeScript 7, ESM only, `.js` extensions on every relative import.
- **Package manager:** pnpm only.
- **No `any`.** Use `unknown` and narrow. No dynamic `await import()`.
- **No non-null assertions (`!`).** `biome.json` sets `style/noNonNullAssertion` to error. Narrow with `if (x === undefined) { ... }` — in tests too.
- **Strings:** single quotes. **Defaults:** `??`, never `||`. **Nullish:** prefer `undefined` over `null`.
- **Braces:** always brace `if` / `for` / `while` bodies.
- **Async:** `async`/`await` only. Never `.then()`. Never `void`-prefix a promise *except* at an Obsidian callback boundary typed to return `void` — the established pattern in `main.ts`.
- **Formatting:** tabs, 100-column lines (Biome enforces; run `pnpm lint:fix`).
- **Naming:** camelCase, full descriptive names, no abbreviations.
- **Comments:** only for *why*, or a constraint the code cannot show. Never restate what the code says.
- **Commits:** conventional format. Never add a Claude co-author trailer. Never create a git branch.
- **The server stays blind.** It is end-to-end encrypted; reconcile must add no server knowledge of paths, contents, or conflicts.
- **Verification after every task:** `pnpm test && pnpm typecheck && pnpm lint`.

---

## Background: what already exists

Read this before Task 1. Every claim is cited so it can be re-verified rather than trusted.

**1. `GET /state` is already complete and already safe to adopt a cursor from.** `registerFileRoutes` (`packages/server/src/routes/files.ts:104-115`) reads `latestSeq(db, vaultId)` **before** calling `readVaultState`, with the comment explaining why: a change landing mid-read is re-delivered by the client's next pull rather than skipped. `readVaultState` (`packages/server/src/files.ts:150-175`) returns, for every **live** (`deleted = 0`) file: `fileId`, `headVersion`, `metaBlob`, `size` (plaintext bytes) and `updatedSeq`. Tombstoned files are simply absent. **No server change is needed anywhere in this plan.**

**2. The plugin already has every apply primitive reconcile needs.** `SyncEngine.#applyRemoteFile` (`packages/plugin/src/engine/sync.ts:281-337`) implements the whole §8 table: identical bytes adopted silently, three-way merge where an ancestor exists, conflict copy otherwise, `StaleWriteError` retry. `SyncEngine.#applyRemoteDelete` (`sync.ts:354-376`) implements "deletion never beats an edit": it trashes only when the local hash still matches the index, otherwise it drops the index entry and leaves the file dirty so the next push republishes it. Reconcile must **reuse both**, never reimplement them.

**3. `pullAll` fetches the entire vault state once per changed file.** `#pullFileById` (`sync.ts:258-279`) opens with `await client.state(vaultId)` and then `.find(...)` for one `fileId`. A pull page carrying 200 changes therefore issues **200 full-state requests**, each returning every `metaBlob` in the vault. Reconcile would inherit this through the same call path, so Task 2 fixes it first. This is the single biggest performance defect in the client today.

**4. `pushAll` already covers the local half of a reconcile.** It re-derives deletes from absence (`sync.ts:107-120`) and re-pushes any file whose hash differs from the index (`sync.ts:122-137`). So reconcile does **not** need to scan the vault: it handles the *remote* half, and `main.ts` runs `pushAll` right after it (`main.ts:346`). What reconcile adds is the remote half the cursor can miss.

**5. The empty-vault guard exists and must not be bypassed.** `#sawVault` (`sync.ts:78`, `sync.ts:107-120`) exists because Obsidian populates its file cache *after* layout, so a plugin that lists the vault too early sees nothing and reads it as a mass delete. Reconcile's delete decisions are driven by the **remote** listing, not the local one, so that guard does not apply — but the mirror-image hazard does, and Task 3 adds its own guard for it: a server that lists *zero* files while the index tracks many is far more often a wrong vault id, a restored blank database, or a truncated response than a genuine mass delete.

**6. `fileId` is `MAC(path)`.** `computeFileId` (`packages/plugin/src/crypto/identity.ts`) binds identity to path, so a rename is a delete plus a create and a file's path can never drift under a stable `fileId`. That is what lets the planner compare on `fileId` alone and lets the engine skip decrypting `metaBlob` for files whose head has not moved — the expensive work happens only for genuine divergence.

**7. The plugin serialises every engine run.** `requestSync` (`main.ts:307-331`) coalesces overlapping triggers behind one promise with a re-run flag. So no push from this device can land between reconcile's snapshot and its apply pass, which is what makes "absent from the snapshot means deleted remotely" sound. Reconcile must run *inside* that lock, not alongside it.

### Decisions taken, and why

Two calls were made in the absence of an explicit instruction. Both are reversible in one line; both are stated here so review can overturn them rather than discover them.

- **Reconcile runs on plugin load and on demand, but *not* on every mobile foreground.** Spec §7.4 lists foreground as a reconcile trigger. `GET /state` returns every `metaBlob` in the vault, so on a large vault each foreground would cost hundreds of kilobytes on cellular, and `#onForeground` (`main.ts:157-174`) can fire often. Load plus on-demand gets the recovery value; the incremental path plus the watchdog covers the rest. **To follow the spec literally instead:** change `void this.reconcile()` at `main.ts:173` to `void this.reconcile({ announce: false })` — the method already exists after Task 5 and needs no other change.
- **A zero-file server listing withholds every local delete** rather than trashing the vault, and says so. See point 5 above.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/plugin/src/testing/devices.ts` | **Create.** The two-device test harness, lifted out of `engine.test.ts` so more than one suite can build devices, and so a device can be rebuilt over an existing vault (the "lost index" case). |
| `packages/plugin/src/engine/reconcile.ts` | **Create.** Pure: `planReconcile` (the diff) and `describeReconcile` (the summary string). No I/O, no crypto, no Obsidian. |
| `packages/plugin/src/engine/reconcile.test.ts` | **Create.** Unit tests for both pure functions. |
| `packages/plugin/src/engine/reconcile-engine.test.ts` | **Create.** End-to-end reconcile behaviour against `FakeServer` + `MemoryVault`. |
| `packages/plugin/src/engine/sync.ts` | **Modify.** Collapse the per-file `GET /state`; extract `#applyRemoteState`; add the public `reconcile()`. |
| `packages/plugin/src/state/file-index.ts` | **Modify.** Add `getByFileId`, replacing a linear scan per delete. |
| `packages/plugin/src/testing/fake-server.ts` | **Modify.** Record requests, so the N+1 fix has a regression test that fails if it is undone. |
| `packages/plugin/src/engine/engine.test.ts` | **Modify.** Use the extracted harness; add the N+1 regression test. |
| `packages/plugin/src/main.ts` | **Modify.** Route the *Full reconcile* command and the load path to the real thing, inside the existing sync lock. |
| `packages/plugin/src/obsidian/status-view.ts` | **Modify.** Show the last reconcile summary. |
| `README.md` | **Modify.** Move reconcile out of "Not yet implemented". |

---

## Task 1: Lift the device harness out of `engine.test.ts`

Pure refactor. No behaviour change, no new test. It exists because Task 4's most important test — a device that lost its index but still has its files — needs to build a *second* device over an *existing* vault, which the current closure-bound helper cannot do.

**Files:**
- Create: `packages/plugin/src/testing/devices.ts`
- Modify: `packages/plugin/src/engine/engine.test.ts:1-80` (imports and helper block)

**Interfaces:**
- Consumes: `FakeServer`, `MemoryVault`, `MemoryStorage`, `ApiClient`, `SyncEngine`, `FileIndex`, `BaseCache`, `LocalState`.
- Produces: `Device`, `DeviceContext`, `DeviceOverrides`, `makeDevice(context, deviceId, overrides?)`, `fullSelective`, `memoryLocalState()` — Tasks 2 and 4 build every test device through these.

- [ ] **Step 1: Create the harness module**

Create `packages/plugin/src/testing/devices.ts`:

```ts
import { BaseCache } from '../state/base-cache.js';
import { FileIndex } from '../state/file-index.js';
import { LocalState, type LocalStateStore } from '../state/local-state.js';
import type { SelectiveSyncOptions } from '../engine/selective.js';
import { type ConflictRecord, SyncEngine, type SyncEngineDeps } from '../engine/sync.js';
import type { PurposeKeys } from '../crypto/keys.js';
import type { ApiClient } from '../transport/client.js';
import type { FakeServer } from './fake-server.js';
import { MemoryStorage, MemoryVault } from './memory-fixtures.js';

export const fullSelective: SelectiveSyncOptions = {
	categories: {
		markdown: true,
		attachments: true,
		config: true,
		themes: true,
		snippets: true,
		pluginSettings: true,
	},
	excludedFolders: [],
	maxFileBytes: 100 * 1024 * 1024,
};

export function memoryLocalState(): { local: LocalState; store: Map<string, string> } {
	const data = new Map<string, string>();
	const store: LocalStateStore = {
		get: (key) => data.get(key) ?? null,
		set: (key, value) => {
			data.set(key, value);
		},
	};
	return { local: new LocalState(store), store: data };
}

export interface DeviceContext {
	server: FakeServer;
	keys: PurposeKeys;
	client: ApiClient;
}

export interface DeviceOverrides {
	/** Reuse an existing vault, so a device can be rebuilt with its files but no index. */
	vault?: MemoryVault;
	selective?: SelectiveSyncOptions;
}

export interface Device {
	engine: SyncEngine;
	vault: MemoryVault;
	index: FileIndex;
	bases: BaseCache;
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
	const index = new FileIndex(new MemoryStorage());
	const bases = new BaseCache(new MemoryStorage());
	const { local } = memoryLocalState();
	await index.load();
	await bases.load();
	const conflicts: ConflictRecord[] = [];
	const deps: SyncEngineDeps = {
		vaultId: context.server.vaultId,
		client: context.client,
		keys: context.keys,
		vault,
		index,
		bases,
		local,
		selective: overrides.selective ?? fullSelective,
		deviceId,
		onConflict: (conflict) => conflicts.push(conflict),
	};
	return { engine: new SyncEngine(deps), vault, index, bases, local, conflicts, deps };
}
```

- [ ] **Step 2: Point `engine.test.ts` at it**

In `packages/plugin/src/engine/engine.test.ts`, delete the local `full` constant (lines 16-28), `memoryLocalState` (lines 30-38), the `Device` interface (lines 40-46) and the `makeDevice` function (lines 52-70). Replace the import block and helper with:

```ts
import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { computeFileId } from '../crypto/identity.js';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { FakeServer } from '../testing/fake-server.js';
import { type Device, fullSelective, makeDevice } from '../testing/devices.js';
import { ApiClient } from '../transport/client.js';
import { SyncEngine } from './sync.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

/** Reads the fixtures at call time, so each test gets the instances `beforeEach` built. */
async function device(deviceId: string): Promise<Device> {
	return makeDevice({ server, keys, client }, deviceId);
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});
```

- [ ] **Step 3: Rename the 30 call sites**

Every remaining `await makeDevice('x')` becomes `await device('x')`:

```bash
cd /Users/avbel/Projects/obsidian-sync
sed -i '' "s/await makeDevice(/await device(/g" packages/plugin/src/engine/engine.test.ts
```

Then fix the two references to the old `full` constant in the selective-sync test (around line 315):

```bash
sed -i '' "s/\.\.\.full,/...fullSelective,/; s/full\.categories/fullSelective.categories/" packages/plugin/src/engine/engine.test.ts
```

- [ ] **Step 4: Verify nothing changed**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: every existing test passes, unchanged in count. `MemoryVault` and `MemoryStorage` are no longer imported directly by `engine.test.ts`; if Biome flags an unused import, remove it.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/testing/devices.ts packages/plugin/src/engine/engine.test.ts
git commit -m "test: lift the two-device sync harness into testing/devices"
```

---

## Task 2: One state request per pull page, not one per file

`#pullFileById` fetches the whole vault state to look up a single file. Fix it before reconcile starts using the same path, and lock the fix in with a test that counts requests.

**Files:**
- Modify: `packages/plugin/src/state/file-index.ts:59` (add `getByFileId` above `forgetFileId`)
- Modify: `packages/plugin/src/testing/fake-server.ts:41-47, 76-78` (record requests)
- Modify: `packages/plugin/src/engine/sync.ts:230-279` and `sync.ts:356`
- Test: `packages/plugin/src/engine/engine.test.ts` (new test in the `regressions` describe block)

**Interfaces:**
- Consumes: `Device` / `device()` from Task 1.
- Produces: `SyncEngine.#applyRemoteState(fileId: string, state: FileState): Promise<number>` — the single decrypt-and-apply step for one server file record, which Task 4's `reconcile()` calls directly. `FileIndex.getByFileId(fileId: string): IndexEntry | undefined`. `FakeServer.requests: string[]`, each entry `"<METHOD> <path without query>"`.

- [ ] **Step 1: Write the failing test**

Add to the `regressions` describe block in `packages/plugin/src/engine/engine.test.ts`:

```ts
	// #pullFileById used to fetch the entire vault state per changed file, so a page
	// of N changes cost N full-state responses — every metaBlob in the vault, N times.
	test('a pull page costs one state request however many files changed', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		laptop.vault.putText('c.md', 'three\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		server.requests.length = 0;
		await phone.engine.pullAll();

		expect(server.requests.filter((entry) => entry.endsWith('/state'))).toHaveLength(1);
		expect(phone.vault.getText('c.md')).toBe('three\n');
	});

	test('a pull with nothing to apply fetches no state at all', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();
		server.requests.length = 0;
		await phone.engine.pullAll();

		expect(server.requests.filter((entry) => entry.endsWith('/state'))).toEqual([]);
	});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test -- engine.test`
Expected: FAIL — `server.requests` does not exist (TypeError), and once it does, the first test reports 3 state requests rather than 1.

- [ ] **Step 3: Record requests in `FakeServer`**

In `packages/plugin/src/testing/fake-server.ts`, add the field beside the other public collections (after `readonly log: StoredChange[] = [];`):

```ts
	/** Every request received, as `"<METHOD> <path>"`, so tests can assert call counts. */
	readonly requests: string[] = [];
```

and record at the top of `request()`, immediately after its destructuring line:

```ts
	async request(request: SyncRequest): Promise<SyncResponse> {
		const { path, method, body } = request;
		const [basePath] = path.split('?');
		this.requests.push(`${method} ${basePath ?? path}`);
		const url = new URL(`http://x${path}`);
```

- [ ] **Step 4: Add `FileIndex.getByFileId`**

In `packages/plugin/src/state/file-index.ts`, add above `forgetFileId`:

```ts
	getByFileId(fileId: string): IndexEntry | undefined {
		this.#assertLoaded();
		for (const entry of this.#entries.values()) {
			if (entry.fileId === fileId) {
				return entry;
			}
		}
		return undefined;
	}
```

- [ ] **Step 5: Split `#pullFileById` into fetch and apply**

In `packages/plugin/src/engine/sync.ts`, add the protocol type to the imports at the top of the file:

```ts
import type { FileState } from '@obsidian-sync/protocol';
```

Replace `#pullFileById` (currently `sync.ts:258-279`) with these two methods:

```ts
	/** Fetch one file's current server record. Used by the push path's 409 retry only. */
	async #pullFileById(fileId: string): Promise<number> {
		const { vaultId, client } = this.#deps;
		const snapshot = await client.state(vaultId);
		const state = snapshot.files.find((file) => file.fileId === fileId);
		return state === undefined ? 0 : this.#applyRemoteState(fileId, state);
	}

	/** Decrypt one server file record and apply it under §8. Returns 1 if it merged. */
	async #applyRemoteState(fileId: string, state: FileState): Promise<number> {
		const { vaultId, client, keys } = this.#deps;
		const decoded = await decodeFile(keys, fileId, state.metaBlob, (address) =>
			client.getBlob(vaultId, address),
		);
		if (!isPathIncluded(decoded.path, this.#selective)) {
			return 0;
		}
		return this.#applyRemoteFile({
			fileId,
			path: decoded.path,
			bytes: decoded.data,
			mtime: decoded.meta.mtime,
			chunks: decoded.meta.chunks,
			headVersion: state.headVersion,
		});
	}
```

- [ ] **Step 6: Fetch the snapshot once per page in `pullAll`**

Replace the `for (const change of page.changes)` loop inside `pullAll` (currently `sync.ts:239-247`) with:

```ts
				// One snapshot per page. It is taken after the page, so every change in the
				// page is reflected in it, and anything newer arrives under a later cursor.
				if (page.changes.length > 0) {
					const snapshot = await client.state(vaultId);
					const byFileId = new Map(snapshot.files.map((file) => [file.fileId, file]));
					for (const change of page.changes) {
						if (change.kind === 'delete') {
							merged += await this.#applyRemoteDelete(change.fileId);
							continue;
						}
						const state = byFileId.get(change.fileId);
						// Absent means the file was deleted after this upsert; the delete change
						// later in the same page is what applies.
						if (state !== undefined) {
							merged += await this.#applyRemoteState(change.fileId, state);
						}
					}
				}
```

- [ ] **Step 7: Use the indexed lookup in `#applyRemoteDelete`**

In `#applyRemoteDelete` (currently `sync.ts:356`), replace:

```ts
		const entry = index.entries().find((candidate) => candidate.fileId === fileId);
```

with:

```ts
		const entry = index.getByFileId(fileId);
```

- [ ] **Step 8: Run the tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS, including both new tests. The `regressions` suite must be unchanged otherwise — in particular `a clean merge made during a pull is uploaded by the next push` still asserts `pullAll()` returns `1`.

- [ ] **Step 9: Commit**

```bash
git add packages/plugin/src/engine/sync.ts packages/plugin/src/state/file-index.ts \
  packages/plugin/src/testing/fake-server.ts packages/plugin/src/engine/engine.test.ts
git commit -m "perf: fetch vault state once per pull page instead of once per file"
```

---

## Task 3: The reconcile planner

The whole diff, as a pure function. Every edge case lives here and is unit-tested without crypto, network, or a vault.

**Files:**
- Create: `packages/plugin/src/engine/reconcile.ts`
- Test: `packages/plugin/src/engine/reconcile.test.ts`

**Interfaces:**
- Consumes: nothing. Deliberately no imports.
- Produces: `planReconcile(input: ReconcileInput): ReconcilePlan`, `describeReconcile(summary: ReconcileSummary): string`, and the types `RemoteFileSummary`, `IndexedFileSummary`, `ReconcileInput`, `ReconcilePlan`, `ReconcileSummary`. Task 4 calls `planReconcile` and returns a `ReconcileSummary`; Task 5 calls `describeReconcile`.

- [ ] **Step 1: Write the failing tests**

Create `packages/plugin/src/engine/reconcile.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { describeReconcile, planReconcile, type ReconcileSummary } from './reconcile.js';

const bigEnough = 1024 * 1024;

describe('planReconcile', () => {
	test('a remote file the index has never seen is pulled', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 10 }],
			indexed: [],
			maxFileBytes: bigEnough,
		});

		expect(plan.pull).toEqual(['f1']);
		expect(plan.remoteDeletes).toEqual([]);
	});

	test('a remote file still at the indexed head is left alone', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 10 }],
			indexed: [{ fileId: 'f1', versionId: 'v1' }],
			maxFileBytes: bigEnough,
		});

		expect(plan.pull).toEqual([]);
		expect(plan.remoteDeletes).toEqual([]);
	});

	test('a remote file whose head has moved is pulled', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v2', size: 10 }],
			indexed: [{ fileId: 'f1', versionId: 'v1' }],
			maxFileBytes: bigEnough,
		});

		expect(plan.pull).toEqual(['f1']);
	});

	test('an indexed file the server no longer lists is a remote delete', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 10 }],
			indexed: [
				{ fileId: 'f1', versionId: 'v1' },
				{ fileId: 'f2', versionId: 'v9' },
			],
			maxFileBytes: bigEnough,
		});

		expect(plan.remoteDeletes).toEqual(['f2']);
		expect(plan.pull).toEqual([]);
	});

	test('a remote file past the size limit is reported, not pulled', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 2048 }],
			indexed: [],
			maxFileBytes: 1024,
		});

		expect(plan.oversized).toEqual(['f1']);
		expect(plan.pull).toEqual([]);
	});

	// A server that lists nothing while the index tracks files is far more often a
	// wrong vault id or a restored blank database than a genuine mass delete.
	test('an empty server listing withholds every delete and says so', () => {
		const plan = planReconcile({
			remote: [],
			indexed: [
				{ fileId: 'f1', versionId: 'v1' },
				{ fileId: 'f2', versionId: 'v2' },
			],
			maxFileBytes: bigEnough,
		});

		expect(plan.massDeleteGuarded).toBe(true);
		expect(plan.remoteDeletes).toEqual([]);
	});

	test('an empty server listing against an empty index guards nothing', () => {
		const plan = planReconcile({ remote: [], indexed: [], maxFileBytes: bigEnough });

		expect(plan.massDeleteGuarded).toBe(false);
		expect(plan.remoteDeletes).toEqual([]);
		expect(plan.pull).toEqual([]);
	});

	test('deleting the last file of many is not treated as a mass delete', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 10 }],
			indexed: [
				{ fileId: 'f1', versionId: 'v1' },
				{ fileId: 'f2', versionId: 'v2' },
			],
			maxFileBytes: bigEnough,
		});

		expect(plan.massDeleteGuarded).toBe(false);
		expect(plan.remoteDeletes).toEqual(['f2']);
	});
});

describe('describeReconcile', () => {
	const quiet: ReconcileSummary = {
		remoteFiles: 12,
		pulled: 0,
		mergedLocally: 0,
		removed: 0,
		skippedOversize: 0,
		massDeleteGuarded: false,
	};

	test('a reconcile that changed nothing still reports the vault size', () => {
		expect(describeReconcile(quiet)).toBe('Reconcile complete: 12 file(s) on the server.');
	});

	test('every non-zero count is named', () => {
		expect(
			describeReconcile({
				...quiet,
				pulled: 3,
				mergedLocally: 1,
				removed: 2,
				skippedOversize: 4,
			}),
		).toBe(
			'Reconcile complete: 12 file(s) on the server, 3 pulled, 1 merged, 2 removed, 4 skipped as too large.',
		);
	});
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- reconcile.test`
Expected: FAIL — `Failed to resolve import "./reconcile.js"`.

- [ ] **Step 3: Write the planner**

Create `packages/plugin/src/engine/reconcile.ts`:

```ts
/** One live file as the server reports it in `GET /state`. */
export interface RemoteFileSummary {
	fileId: string;
	headVersion: string;
	/** Plaintext byte length, for the size limit only. */
	size: number;
}

/** One entry of the local index, reduced to what the comparison needs. */
export interface IndexedFileSummary {
	fileId: string;
	versionId: string;
}

export interface ReconcileInput {
	remote: RemoteFileSummary[];
	indexed: IndexedFileSummary[];
	maxFileBytes: number;
}

export interface ReconcilePlan {
	/** fileIds whose server head differs from the index, or that the index never saw. */
	pull: string[];
	/** fileIds the index tracks that the server no longer lists as live. */
	remoteDeletes: string[];
	/** fileIds skipped because the remote plaintext exceeds the size limit. */
	oversized: string[];
	/** True when the delete pass was withheld because the server listed no files. */
	massDeleteGuarded: boolean;
}

export interface ReconcileSummary {
	remoteFiles: number;
	pulled: number;
	mergedLocally: number;
	removed: number;
	skippedOversize: number;
	massDeleteGuarded: boolean;
}

/**
 * Compare the server's live file list against the local index (§7.4).
 *
 * Comparison is on `fileId` alone, which is sound because `fileId` is a MAC of the
 * path: a file's path cannot drift under a stable id, so a rename arrives as one
 * delete and one create rather than as a moved file. That is also what lets the
 * caller skip decrypting `metaBlob` for everything outside `pull` — the expensive
 * work happens only where the two sides genuinely disagree.
 *
 * Local-only divergence (a file edited or removed on disk while the head did not
 * move) is deliberately absent: `SyncEngine.pushAll` already re-derives both from
 * the vault, and duplicating that here would race it.
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
	const indexedVersions = new Map(
		input.indexed.map((entry) => [entry.fileId, entry.versionId] as const),
	);
	const remoteIds = new Set<string>();
	const pull: string[] = [];
	const oversized: string[] = [];

	for (const file of input.remote) {
		remoteIds.add(file.fileId);
		if (file.size > input.maxFileBytes) {
			oversized.push(file.fileId);
			continue;
		}
		if (indexedVersions.get(file.fileId) !== file.headVersion) {
			pull.push(file.fileId);
		}
	}

	// A vault that reports itself entirely empty is far more often a wrong vault id,
	// a restored blank database, or a truncated response than a real mass delete, and
	// the cost of being wrong is the whole vault. Withhold and report instead.
	const massDeleteGuarded = input.remote.length === 0 && input.indexed.length > 0;
	const remoteDeletes = massDeleteGuarded
		? []
		: input.indexed
				.filter((entry) => !remoteIds.has(entry.fileId))
				.map((entry) => entry.fileId);

	return { pull, remoteDeletes, oversized, massDeleteGuarded };
}

export function describeReconcile(summary: ReconcileSummary): string {
	const parts = [`${summary.remoteFiles} file(s) on the server`];
	if (summary.pulled > 0) {
		parts.push(`${summary.pulled} pulled`);
	}
	if (summary.mergedLocally > 0) {
		parts.push(`${summary.mergedLocally} merged`);
	}
	if (summary.removed > 0) {
		parts.push(`${summary.removed} removed`);
	}
	if (summary.skippedOversize > 0) {
		parts.push(`${summary.skippedOversize} skipped as too large`);
	}
	return `Reconcile complete: ${parts.join(', ')}.`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- reconcile.test && pnpm typecheck && pnpm lint`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/engine/reconcile.ts packages/plugin/src/engine/reconcile.test.ts
git commit -m "feat: add the reconcile planner comparing server state against the local index"
```

---

## Task 4: `SyncEngine.reconcile()`

Wire the planner to the existing apply paths and adopt the snapshot's cursor.

**Files:**
- Modify: `packages/plugin/src/engine/sync.ts` (imports, plus one new public method after `pullAll`)
- Test: `packages/plugin/src/engine/reconcile-engine.test.ts` (create)

**Interfaces:**
- Consumes: `planReconcile` and `ReconcileSummary` from Task 3; `#applyRemoteState` from Task 2; `makeDevice` / `fullSelective` / `Device` from Task 1.
- Produces: `SyncEngine.reconcile(): Promise<ReconcileSummary>`, plus a re-export of `ReconcileSummary` from `sync.ts` — Task 5 imports the type from `sync.js` and `describeReconcile` from `reconcile.js`.

- [ ] **Step 1: Write the failing tests**

Create `packages/plugin/src/engine/reconcile-engine.test.ts`:

```ts
import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import {
	type Device,
	type DeviceOverrides,
	fullSelective,
	makeDevice,
} from '../testing/devices.js';
import { FakeServer } from '../testing/fake-server.js';
import { ApiClient } from '../transport/client.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');

let server: FakeServer;
let keys: PurposeKeys;
let client: ApiClient;

async function device(deviceId: string, overrides?: DeviceOverrides): Promise<Device> {
	return makeDevice({ server, keys, client }, deviceId, overrides);
}

beforeEach(async () => {
	server = new FakeServer();
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(server);
});

describe('full reconcile', () => {
	// The recovery case reconcile exists for: state directory wiped, files intact.
	// Every file looks changed with no known ancestor, which is the conflict-copy
	// path — unless identical bytes are adopted first.
	test('a device that lost its index adopts its files instead of duplicating them', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();
		expect(phone.index.entries()).toHaveLength(2);

		const amnesiac = await device('phone', { vault: phone.vault });
		const summary = await amnesiac.engine.reconcile();

		expect(summary.pulled).toBe(2);
		expect(amnesiac.conflicts).toEqual([]);
		expect((await amnesiac.vault.list()).map((file) => file.path).sort()).toEqual([
			'a.md',
			'b.md',
		]);
		expect(amnesiac.index.entries()).toHaveLength(2);
	});

	test('a file created while the device was terminated arrives', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('first.md', 'one\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		laptop.vault.putText('second.md', 'two\n');
		await laptop.engine.pushAll();

		// The cursor jumped the change: a crash between applying a batch and persisting
		// it, or a change log the server has since pruned.
		phone.local.setCursor(server.log.length);
		await phone.engine.pullAll();
		expect(await phone.vault.exists('second.md')).toBe(false);

		await phone.engine.reconcile();
		expect(phone.vault.getText('second.md')).toBe('two\n');
	});

	test('a remote delete the change log no longer covers is applied', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('gone.md', 'bye\n');
		laptop.vault.putText('stay.md', 'here\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		await laptop.vault.remove('gone.md');
		await laptop.engine.pushAll(['gone.md']);

		phone.local.setCursor(server.log.length);
		await phone.engine.pullAll();
		expect(await phone.vault.exists('gone.md')).toBe(true);

		const summary = await phone.engine.reconcile();
		expect(summary.removed).toBe(1);
		expect(await phone.vault.exists('gone.md')).toBe(false);
		expect(phone.vault.getText('stay.md')).toBe('here\n');
	});

	// §8: deletion never beats an edit, on the reconcile path as on the pull path.
	test('a locally edited file is kept when the server no longer holds it', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('note.md', 'original\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();
		phone.vault.putText('note.md', 'edited on the phone\n');

		await laptop.vault.remove('note.md');
		await laptop.engine.pushAll(['note.md']);

		phone.local.setCursor(server.log.length);
		await phone.engine.reconcile();

		expect(phone.vault.getText('note.md')).toBe('edited on the phone\n');
		await phone.engine.pushAll();
		await laptop.engine.pullAll();
		expect(laptop.vault.getText('note.md')).toBe('edited on the phone\n');
	});

	test('an empty server listing never trashes a populated vault', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		await laptop.engine.pushAll();

		server.files.clear();
		const summary = await laptop.engine.reconcile();

		expect(summary.massDeleteGuarded).toBe(true);
		expect(summary.removed).toBe(0);
		expect(await laptop.vault.exists('a.md')).toBe(true);
		expect(laptop.index.entries()).toHaveLength(2);
	});

	test('the cursor adopts the snapshot sequence and is never lowered', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		expect(phone.local.getCursor()).toBe(0);
		await phone.engine.reconcile();
		expect(phone.local.getCursor()).toBe(server.log.length);

		const ahead = server.log.length + 5;
		phone.local.setCursor(ahead);
		await phone.engine.reconcile();
		expect(phone.local.getCursor()).toBe(ahead);
	});

	test('a remote file past the size limit is skipped rather than pulled', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('big.md', 'x'.repeat(4096));
		await laptop.engine.pushAll();

		const phone = await device('phone', {
			selective: { ...fullSelective, maxFileBytes: 1024 },
		});
		const summary = await phone.engine.reconcile();

		expect(summary.skippedOversize).toBe(1);
		expect(summary.pulled).toBe(0);
		expect(await phone.vault.exists('big.md')).toBe(false);
	});

	test('a settled vault reconciles without fetching a single blob', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('a.md', 'one\n');
		laptop.vault.putText('b.md', 'two\n');
		await laptop.engine.pushAll();

		const phone = await device('phone');
		await phone.engine.pullAll();

		server.requests.length = 0;
		const summary = await phone.engine.reconcile();

		expect(summary.pulled).toBe(0);
		expect(server.requests.filter((entry) => entry.includes('/blobs/'))).toEqual([]);
		expect(server.requests.filter((entry) => entry.endsWith('/state'))).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- reconcile-engine`
Expected: FAIL — `engine.reconcile is not a function`.

- [ ] **Step 3: Implement `reconcile()`**

In `packages/plugin/src/engine/sync.ts`, add to the imports:

```ts
import { planReconcile, type ReconcileSummary } from './reconcile.js';
```

and re-export the summary type, so the engine's public surface is readable from one module:

```ts
export type { ReconcileSummary } from './reconcile.js';
```

Add this method immediately after `pullAll` (which ends at `sync.ts:256`; after Task 2 it ends a few lines later):

```ts
	/**
	 * Compare the whole vault against `GET /state` (§7.4) and repair what the
	 * incremental path cannot see: changes made while the app was terminated, a
	 * cursor lost to a crash, and a state directory that was wiped or restored.
	 *
	 * Every apply goes through the same two methods a pull uses, so §8's resolution
	 * table governs reconcile identically — nothing here decides a conflict of its
	 * own. The local half is left to `pushAll`, which already re-derives a dirty
	 * file and a local delete from the vault itself.
	 */
	async reconcile(): Promise<ReconcileSummary> {
		const { vaultId, client, index, bases, local } = this.#deps;
		this.#status('syncing');
		try {
			const snapshot = await client.state(vaultId);
			const plan = planReconcile({
				remote: snapshot.files.map((file) => ({
					fileId: file.fileId,
					headVersion: file.headVersion,
					size: file.size,
				})),
				indexed: index
					.entries()
					.map((entry) => ({ fileId: entry.fileId, versionId: entry.versionId })),
				maxFileBytes: this.#selective.maxFileBytes,
			});

			const byFileId = new Map(snapshot.files.map((file) => [file.fileId, file]));
			let mergedLocally = 0;
			for (const fileId of plan.pull) {
				const state = byFileId.get(fileId);
				if (state === undefined) {
					continue;
				}
				mergedLocally += await this.#applyRemoteState(fileId, state);
			}

			let removed = 0;
			for (const fileId of plan.remoteDeletes) {
				// A non-zero return means the local file was modified and survived, so it
				// was not removed — it is dirty, and the following push republishes it.
				const preserved = await this.#applyRemoteDelete(fileId);
				mergedLocally += preserved;
				removed += preserved === 0 ? 1 : 0;
			}

			// The server reads its sequence before listing files, so anything landing
			// mid-read is re-delivered rather than skipped and this snapshot's seq is a
			// safe cursor. Raised only: a pull already further ahead must not replay.
			local.setCursor(Math.max(local.getCursor(), snapshot.seq));

			await index.save();
			await bases.save();

			return {
				remoteFiles: snapshot.files.length,
				pulled: plan.pull.length,
				mergedLocally,
				removed,
				skippedOversize: plan.oversized.length,
				massDeleteGuarded: plan.massDeleteGuarded,
			};
		} finally {
			this.#status('idle');
		}
	}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. If `a settled vault reconciles without fetching a single blob` fails with `pulled: 2`, the index is storing a different `versionId` than the server's `headVersion` — check `#recordRemote` (`sync.ts:339-353`), which must record `remote.headVersion`.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/engine/sync.ts packages/plugin/src/engine/reconcile-engine.test.ts
git commit -m "feat: reconcile the vault against GET /state"
```

---

## Task 5: Route the command, the load path, and the UI to it

**Files:**
- Modify: `packages/plugin/src/main.ts` (imports, fields, `reloadEngine`, `#runSync`, `reconcile`, `#stopEngine`)
- Modify: `packages/plugin/src/obsidian/status-view.ts:43-45`
- Modify: `README.md:320-326` (the *Not yet implemented* list) and the section break above `## What is never synced`

**Interfaces:**
- Consumes: `SyncEngine.reconcile()` and `ReconcileSummary` from Task 4, `describeReconcile` from Task 3.
- Produces: `SyncPlugin.reconcile(options?: { announce?: boolean }): Promise<void>`, `SyncPlugin.lastReconcile: ReconcileSummary | undefined`.

- [ ] **Step 1: Import the pieces**

In `packages/plugin/src/main.ts`, extend the engine import and add the describe helper:

```ts
import { describeReconcile } from './engine/reconcile.js';
import {
	type ConflictRecord,
	type EngineStatus,
	type ReconcileSummary,
	SyncEngine,
} from './engine/sync.js';
```

- [ ] **Step 2: Add the request flag and the last summary**

Beside the existing public fields (`main.ts:46-49`):

```ts
	lastReconcile: ReconcileSummary | undefined;
```

and beside the private ones (`main.ts:51-59`):

```ts
	#reconcileRequested: 'silent' | 'announce' | undefined;
```

- [ ] **Step 3: Replace `reconcile()`**

Replace the current one-line `reconcile()` (`main.ts:368-370`) with:

```ts
	/**
	 * Queue a full reconcile and run it through the ordinary sync lock, so no push
	 * from this device can land between the server snapshot and the apply pass — which
	 * is what makes "absent from the snapshot" mean "deleted remotely".
	 */
	async reconcile(options: { announce?: boolean } = {}): Promise<void> {
		// A user-initiated reconcile arriving while a silent startup one is queued must
		// still report what it did, so announce never downgrades to silent.
		if (this.#reconcileRequested !== 'announce') {
			this.#reconcileRequested = (options.announce ?? true) ? 'announce' : 'silent';
		}
		await this.requestSync();
	}
```

- [ ] **Step 4: Run it inside `#runSync`**

Replace `#runSync` (`main.ts:333-355`) with:

```ts
	async #runSync(): Promise<void> {
		if (this.#engine === null) {
			await this.reloadEngine();
			return;
		}
		// Drained rather than read, so a failure can put them back: a delete has no
		// on-disk trace to rediscover beyond the index, which pushAll also reconciles.
		const deletes = [...this.#pendingDeletes];
		this.#pendingDeletes.clear();
		const reconciling = this.#reconcileRequested;
		this.#reconcileRequested = undefined;
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
			await this.#engine.pushAll(deletes);
			this.lastSyncAt = Date.now();
			this.#setStatus('idle');
		} catch (error) {
			for (const path of deletes) {
				this.#pendingDeletes.add(path);
			}
			// A reconcile that failed is still owed; the next run picks it up.
			this.#reconcileRequested = reconciling;
			this.#setStatus('error');
			this.#logError(error);
		}
	}
```

- [ ] **Step 5: Reconcile on load, and clear the flag on stop**

In `reloadEngine` (`main.ts:191-193`), replace:

```ts
			if (this.settings.syncOnStartup) {
				await this.requestSync();
			}
```

with:

```ts
			if (this.settings.syncOnStartup) {
				// A restart is exactly when the cursor may be stale or the state directory
				// gone, so the first run of a session is the full comparison, not a nudge.
				await this.reconcile({ announce: false });
			}
```

In `#stopEngine` (`main.ts:444-452`), add beside the other reset lines:

```ts
		this.#reconcileRequested = undefined;
```

- [ ] **Step 6: Show the last reconcile in the status view**

In `packages/plugin/src/obsidian/status-view.ts`, after the `lastSync` block (which ends at line 45):

```ts
		const reconcile = this.#plugin.lastReconcile;
		if (reconcile !== undefined) {
			root.createDiv({
				cls: 'obsidian-sync-status__reconcile',
				text: `Last reconcile: ${reconcile.remoteFiles} remote file(s), ${reconcile.pulled} pulled, ${reconcile.removed} removed`,
			});
		}
```

- [ ] **Step 7: Update the README**

Remove the reconcile bullet from *Not yet implemented* (`README.md:324`):

```bash
cd /Users/avbel/Projects/obsidian-sync
sed -i '' '/^- Full reconcile against `GET \/state`\./d' README.md
```

Then add a *Reconcile* subsection immediately before the `## What is never synced` heading:

```markdown
## Reconcile

*Full reconcile* compares the whole vault against `GET /state` rather than replaying the change cursor. It runs on plugin load and on demand, and repairs what the incremental path cannot see: files that changed while the app was terminated, a cursor lost to a crash, and a wiped or restored state directory — identical bytes are adopted, so recovering a lost index produces no conflict copies.

Files whose server head already matches the index are never decrypted or downloaded, so a settled vault costs exactly one request.

If the server lists no files at all while the index still tracks some, every local removal is withheld and the reason is surfaced. A vault that reports itself empty is far more often a wrong vault id or a restored blank database than a real mass delete.
```

- [ ] **Step 8: Verify**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS, and the esbuild plugin bundle builds.

Then verify in a real vault, since `main.ts` has no unit test:
1. Symlink `packages/plugin` into `<vault>/.obsidian/plugins/obsidian-sync/` and run `node packages/plugin/esbuild.config.mjs`.
2. Fully quit and reopen Obsidian — **toggling the plugin off and on keeps the old `main.js`**. Confirm no notice appears on startup (the load reconcile is silent).
3. Run *Full reconcile* from the command palette. Expect a notice of the form `Reconcile complete: N file(s) on the server.`
4. Delete the plugin's `state/` directory, restart Obsidian, run *Full reconcile*. Expect the index to rebuild with **no** `(conflict …)` files created.
5. Open the sync status view and confirm the `Last reconcile:` line.

- [ ] **Step 9: Commit**

```bash
git add packages/plugin/src/main.ts packages/plugin/src/obsidian/status-view.ts README.md
git commit -m "feat: run a real full reconcile from the command and on plugin load"
```

---

## Out of scope, deliberately

Recorded so a reviewer does not mistake these for oversights.

- **Foreground reconcile on mobile.** See *Decisions taken* above; one-line change if wanted.
- **A size limit on the incremental pull path.** `pullAll` still applies a remote file of any size; only reconcile enforces `maxFileBytes` on the remote side. Fixing that belongs with the oversized-file reporting in the status view (spec §9), not here.
- **Durable offline queue.** Still in-memory, still listed under *Not yet implemented*. Reconcile makes a lost delete recoverable, which is why correctness holds without it, but it does not make the queue durable.
- **Transactional apply.** If `decodeFile` throws part-way through the pull pass — a blob the server no longer holds, a failed integrity check — `reconcile()` propagates, so `index.save()` never runs and the in-memory index changes since the last save are lost while the vault writes already landed. The next reconcile re-derives them from the same snapshot, so this self-heals; it is called out only because it is identical to `pullAll`'s existing behaviour and should not be "fixed" in reconcile alone.
- **Server-side pagination of `GET /state`.** The response carries every `metaBlob` in the vault. At 4 MiB chunks and a few hundred bytes of meta per file, a 10 000-file vault is a few megabytes — acceptable for a load-time and on-demand operation, not for a per-foreground one. A `?since=` cursor on `/state` is the fix if that ever changes, and it is a protocol change.

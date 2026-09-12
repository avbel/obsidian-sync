# Conflict Resolution Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a sync conflict from a silent notice plus an orphaned copy into an explicit, durable choice: *keep mine*, *keep remote*, or *keep both*.

**Architecture:** No new network traffic and no protocol change. When the engine cannot merge, it already writes the user's bytes to a conflict copy and lets the remote version take the file — so both sides of the conflict are ordinary vault files by the time a human sees them. Resolution is therefore a small, pure-ish engine method over the existing `VaultAdapter`, a durable per-device list of unresolved conflicts in localStorage, and a thin Obsidian `Modal` that calls the method. "Keep mine" deliberately does **not** touch the file index: leaving the index recording the remote version is what makes the file read as dirty, so the existing push path commits the user's bytes against the current head on the next sync.

**Tech Stack:** TypeScript 7, Obsidian 1.13 plugin API (`Modal`, `Setting`, `Notice`, `Workspace.getLeaf`), Vitest 4 against the in-memory vault fixtures, Biome.

**Spec:** `docs/specs/2026-09-10-obsidian-sync-design.md` (§8 conflict resolution)

**Prior plan:** `docs/plans/2026-09-10-server-and-protocol.md` — its Global Constraints section applies here in full.

## Global Constraints

Copied from the server plan; these bind every task. Do not restate them in code review, do not violate them.

- **Runtime:** TypeScript 7, ESM only, `.js` extensions on every relative import.
- **Package manager:** pnpm only.
- **No `any`.** Use `unknown` and narrow. No dynamic `await import()`.
- **No non-null assertions (`!`).** `biome.json` sets `style/noNonNullAssertion` to error. Narrow with an explicit `if (x === undefined) { throw new Error(...) }` — this applies inside tests too.
- **Strings:** single quotes. **Defaults:** `??`, never `||`. **Nullish:** prefer `undefined` over `null`.
- **Braces:** always brace `if` / `for` / `while` bodies.
- **Async:** `async`/`await` only. Never `.then()`. Never `void`-prefix a promise *except* at an Obsidian callback boundary that is typed to return `void`, which is the established pattern in `main.ts`.
- **Naming:** camelCase, full descriptive names.
- **Comments:** only for *why*, or for a constraint the code cannot show. Never restate what the code says.
- **Commits:** conventional format. Never add a Claude co-author trailer. Never create a git branch.
- **The plugin is the only half that can resolve anything.** The server is end-to-end encrypted and cannot read bytes, so it must gain no knowledge of conflicts.

---

## Background: what already exists

Read this before Task 1. Every claim below is load-bearing for the design, and each is cited so it can be re-verified rather than trusted.

**1. Both sides of a conflict are already ordinary files on disk.** `SyncEngine.#applyRemoteFile` (`packages/plugin/src/engine/sync.ts:280`) tries a three-way merge; when that fails it calls `#conflictCopy(path, localBytes)` (`sync.ts:378`), which writes the *local* bytes to `note (conflict 2026-09-12 14-03-11).md`, then writes the *remote* bytes over `note.md` and records the remote version in the index. So:

- "theirs" = the live file at `record.path`
- "mine"  = the file at `record.conflictCopyPath`

A resolution UI needs no server call, no version-history API, and no cached bytes.

**2. The conflict record already reaches the UI.** `#conflictCopy` calls `onConflict` (`sync.ts:389`), `main.ts:235` pushes it into `SyncPlugin.pendingConflicts`, and the sidebar view already renders one row per conflicting path (`packages/plugin/src/obsidian/status-view.ts:47`). This plan adds a click target and a resolution path, not a pipeline.

**3. `pendingConflicts` is currently a leak.** It is pushed to and never removed (`main.ts:236` is the only mutation), never deduplicated, and never persisted — so it grows for the life of the session, shows the same path repeatedly if it conflicts twice, and is empty after a restart even though the conflict copies are still sitting in the vault. Task 2 fixes all three; without it the modal would resolve conflicts that silently come back, and miss conflicts from the previous session entirely.

**4. "Dirty" is defined by hash, not by a flag.** `pushAll` lists the vault and pushes any file whose content hash differs from its index entry; a successful commit then updates both the index entry and the merge base (`sync.ts:176-185`). The auto-merge path already exploits this deliberately — it writes merged bytes but records the *remote* version, so the merge stays dirty and the next push commits it (`sync.ts:318-321`). **Task 1 uses exactly that mechanism**, which is why "keep mine" needs no new push API.

**5. Writes are compare-and-set.** `VaultAdapter.write` takes `expected` and raises `StaleWriteError` if the file no longer holds those bytes (`packages/plugin/src/engine/vault.ts:14`, real implementation `obsidian/vault-adapter.ts`). A user typing in the note while the modal is open must not be clobbered, so every resolution write passes `expected`.

**6. Deleting the conflict copy propagates by itself.** The copy is a normal vault file, so a previous sync has probably already pushed it to the server. Removing it via `vault.trash()` is seen by `DebouncedWatcher` as an ordinary user delete and queued into `#pendingDeletes` like any other, and `pushAll` re-derives missed deletes from the index anyway (`sync.ts:109-117`). No special handling is needed — but use `trash()`, never `remove()`, so a mistaken resolution is recoverable from the system trash.

**7. Tests run against an in-memory vault.** `MemoryVault` (`packages/plugin/src/testing/memory-fixtures.ts`) implements the full `VaultAdapter` including `trash()`, enforces the `expected` guard, and offers `raceOnce(path, text)` which rewrites a file the next time it is read — the exact shape of "the user typed while the modal was open". `vitest.config.ts` aliases the `obsidian` package to `testing/obsidian-stub.ts`, which is types-only support: it has no `Modal` and no `Setting`.

## Scope

**In scope (this plan):** whole-file resolution — keep mine / keep remote / keep both — reachable from the sidebar view, the conflict notice, and a command. A durable conflict list.

**Explicitly out of scope:** any diff rendering, hunk-level merging, and version-history restore. `merge3` returns `conflictedLocal` / `conflictedRemote` (`packages/plugin/src/engine/merge.ts:100`) which `sync.ts:312-313` discards — that is the hook a later diff/hunk plan would use, and it also `return`s at the *first* conflicting cluster, so per-hunk resolution would require reshaping it to collect all clusters. Do not start that here.

## File structure

```
packages/plugin/src/
├── engine/
│   └── sync.ts                   MODIFY  + ConflictChoice, ConflictOutcome, resolveConflict()
│   └── engine.test.ts            MODIFY  + describe('conflict resolution') — 4 tests
├── state/
│   ├── conflict-list.ts          CREATE  durable, deduplicated list of unresolved conflicts
│   └── conflict-list.test.ts     CREATE
├── obsidian/
│   ├── conflict-modal.ts         CREATE  the Modal; no business logic
│   └── status-view.ts            MODIFY  conflict rows become resolve buttons
└── main.ts                       MODIFY  own the list, open the modal, serialise against sync
README.md                         MODIFY  move the bullet out of "Not yet implemented"
```

**Why these boundaries:** the engine method is the only code that may touch vault bytes, so it is the only code needing the two-device test harness. The list is separate from `LocalState` because it has behaviour worth testing directly (dedupe, prune, round-trip) while `LocalState` is a two-key accessor. `conflict-modal.ts` holds no decisions at all — it maps a button to a `ConflictChoice` — which is what keeps it acceptable that the `obsidian` stub cannot instantiate it in tests.

---

## Task 1: Engine-side resolution

Deliverable: `SyncEngine.resolveConflict()` resolves a conflict correctly against a real two-device sync, with no UI in the picture.

New tests go into the existing `engine.test.ts` rather than a new file, because the two-device harness (`makeDevice`, `FakeServer`, `full`) is local to that file. Extracting it would touch the highest-value suite in the repo for no behavioural gain.

**Files:**
- Modify: `packages/plugin/src/engine/sync.ts` (add exported types near `ConflictRecord` at line 14; add the method after `#conflictCopy`, before the closing brace at line ~391)
- Test: `packages/plugin/src/engine/engine.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `ConflictRecord { path, conflictCopyPath }`, `VaultAdapter`, `StaleWriteError` — all existing.
- Produces:
  - `export type ConflictChoice = 'mine' | 'remote' | 'both';`
  - `export type ConflictOutcome = 'resolved' | 'missing-copy' | 'stale';`
  - `resolveConflict(record: ConflictRecord, choice: ConflictChoice): Promise<ConflictOutcome>`

- [x] **Step 1: Write the failing tests**

Append to `packages/plugin/src/engine/engine.test.ts`. Note `ConflictChoice` is not imported — the string literals are inferred at the call site.

```typescript
describe('conflict resolution', () => {
	/** Drives two devices into a real unmergeable conflict and returns the loser's record. */
	async function conflicted(): Promise<{
		a: Device;
		b: Device;
		record: ConflictRecord;
	}> {
		const seed = await makeDevice('seed');
		seed.vault.putText('c.md', 'shared\nbase\n');
		await seed.engine.pushAll();

		const a = await makeDevice('a');
		const b = await makeDevice('b');
		await a.engine.pullAll();
		await b.engine.pullAll();

		a.vault.putText('c.md', 'shared\nversion-A\n');
		b.vault.putText('c.md', 'shared\nversion-B\n');
		await a.engine.pushAll();
		await b.engine.pullAll();

		const record = b.conflicts[0];
		if (record === undefined) {
			throw new Error('expected the second device to record a conflict');
		}
		expect(b.vault.getText('c.md')).toBe('shared\nversion-A\n');
		expect(b.vault.getText(record.conflictCopyPath)).toBe('shared\nversion-B\n');
		return { a, b, record };
	}

	test('keeping the local side restores it and republishes it to the other device', async () => {
		const { a, b, record } = await conflicted();

		expect(await b.engine.resolveConflict(record, 'mine')).toBe('resolved');
		expect(b.vault.getText('c.md')).toBe('shared\nversion-B\n');
		expect(await b.vault.exists(record.conflictCopyPath)).toBe(false);

		// The index still records A's version, so the file reads dirty and pushes.
		await b.engine.pushAll();
		await a.engine.pullAll();
		expect(a.vault.getText('c.md')).toBe('shared\nversion-B\n');
	});

	test('keeping the remote side drops the copy and leaves nothing to push', async () => {
		const { a, b, record } = await conflicted();

		expect(await b.engine.resolveConflict(record, 'remote')).toBe('resolved');
		expect(b.vault.getText('c.md')).toBe('shared\nversion-A\n');
		expect(await b.vault.exists(record.conflictCopyPath)).toBe(false);

		await b.engine.pushAll();
		await a.engine.pullAll();
		expect(a.vault.getText('c.md')).toBe('shared\nversion-A\n');
	});

	test('keeping both leaves every file alone', async () => {
		const { b, record } = await conflicted();

		expect(await b.engine.resolveConflict(record, 'both')).toBe('resolved');
		expect(b.vault.getText('c.md')).toBe('shared\nversion-A\n');
		expect(b.vault.getText(record.conflictCopyPath)).toBe('shared\nversion-B\n');
	});

	test('a copy the user already deleted resolves as missing rather than throwing', async () => {
		const { b, record } = await conflicted();
		await b.vault.trash(record.conflictCopyPath);

		expect(await b.engine.resolveConflict(record, 'mine')).toBe('missing-copy');
	});

	test('an edit landing while the modal is open is never clobbered', async () => {
		const { b, record } = await conflicted();
		// Rewrites c.md the next time it is read: a keystroke between read and write.
		b.vault.raceOnce('c.md', 'typed\nwhile\nopen\n');

		expect(await b.engine.resolveConflict(record, 'mine')).toBe('stale');
		expect(b.vault.getText('c.md')).toBe('typed\nwhile\nopen\n');
		expect(await b.vault.exists(record.conflictCopyPath)).toBe(true);
	});
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/plugin/src/engine/engine.test.ts`

Expected: FAIL — `b.engine.resolveConflict is not a function`.

- [x] **Step 3: Add the types next to `ConflictRecord` in `sync.ts`**

Directly below the `ConflictRecord` interface (line 14-17):

```typescript
export type ConflictChoice = 'mine' | 'remote' | 'both';

/**
 * `missing-copy`: the user deleted or renamed the copy themselves — the record is
 * stale and should be dropped. `stale`: the note changed between reading it and
 * writing the resolution, so nothing was written and the user must choose again.
 */
export type ConflictOutcome = 'resolved' | 'missing-copy' | 'stale';
```

- [x] **Step 4: Implement `resolveConflict` in `SyncEngine`**

Add as a public method immediately after `#conflictCopy`:

```typescript
	/**
	 * Apply a user's choice to an already-copied conflict (§8). Both sides are plain
	 * vault files by this point, so this touches no network and no server version.
	 *
	 * `mine` deliberately leaves the index recording the remote version: that is what
	 * makes the restored bytes read as dirty, so the next push commits them against the
	 * current head instead of needing a second commit path here.
	 */
	async resolveConflict(record: ConflictRecord, choice: ConflictChoice): Promise<ConflictOutcome> {
		const { vault } = this.#deps;
		if (choice === 'both') {
			return 'resolved';
		}
		if (!(await vault.exists(record.conflictCopyPath))) {
			return 'missing-copy';
		}
		if (choice === 'remote') {
			await vault.trash(record.conflictCopyPath);
			return 'resolved';
		}

		const mine = await vault.read(record.conflictCopyPath);
		const current = (await vault.exists(record.path)) ? await vault.read(record.path) : undefined;
		try {
			await vault.write(record.path, mine, { expected: current });
		} catch (error) {
			if (error instanceof StaleWriteError) {
				return 'stale';
			}
			throw error;
		}
		await vault.trash(record.conflictCopyPath);
		return 'resolved';
	}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/plugin/src/engine/engine.test.ts`

Expected: PASS, 5 added tests. Then run the whole suite — the resolution must not perturb the existing conflict tests:

Run: `pnpm test`

Expected: PASS, all files.

- [x] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint:fix && pnpm typecheck
git add packages/plugin/src/engine/sync.ts packages/plugin/src/engine/engine.test.ts
git commit -m "feat: resolve a conflict to either side in the engine"
```

---

## Task 2: A durable, deduplicated conflict list

Deliverable: unresolved conflicts survive a restart and never appear twice for the same path. Still no UI.

**Files:**
- Create: `packages/plugin/src/state/conflict-list.ts`
- Test: `packages/plugin/src/state/conflict-list.test.ts`

**Interfaces:**
- Consumes: `LocalStateStore { get(key): string | null; set(key, value): void }` from `state/local-state.ts`; `ConflictRecord` from `engine/sync.js` (type-only import, so no runtime cycle).
- Produces: `class ConflictList` with `all(): ConflictRecord[]`, `add(record: ConflictRecord): void`, `remove(path: string): void`, `prune(exists: (path: string) => Promise<boolean>): Promise<void>`.

- [x] **Step 1: Write the failing test**

`packages/plugin/src/state/conflict-list.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import { ConflictList } from './conflict-list.js';
import type { LocalStateStore } from './local-state.js';

function memoryStore(): { store: LocalStateStore; data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		store: {
			get: (key) => data.get(key) ?? null,
			set: (key, value) => {
				data.set(key, value);
			},
		},
	};
}

describe('ConflictList', () => {
	test('survives a reconstruction against the same store', () => {
		const { store } = memoryStore();
		new ConflictList(store).add({ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' });

		expect(new ConflictList(store).all()).toEqual([
			{ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' },
		]);
	});

	test('a second conflict on one path replaces the first rather than stacking', () => {
		const { store } = memoryStore();
		const list = new ConflictList(store);
		list.add({ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' });
		list.add({ path: 'a.md', conflictCopyPath: 'a (conflict 2).md' });

		expect(list.all()).toEqual([{ path: 'a.md', conflictCopyPath: 'a (conflict 2).md' }]);
	});

	test('removing by path clears the entry', () => {
		const { store } = memoryStore();
		const list = new ConflictList(store);
		list.add({ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' });
		list.add({ path: 'b.md', conflictCopyPath: 'b (conflict 1).md' });
		list.remove('a.md');

		expect(list.all().map((record) => record.path)).toEqual(['b.md']);
	});

	test('pruning drops records whose copy no longer exists', async () => {
		const { store } = memoryStore();
		const list = new ConflictList(store);
		list.add({ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' });
		list.add({ path: 'b.md', conflictCopyPath: 'b (conflict 1).md' });

		await list.prune(async (path) => path === 'b (conflict 1).md');

		expect(list.all().map((record) => record.path)).toEqual(['b.md']);
	});

	test('a corrupt stored value reads as an empty list instead of throwing', () => {
		const { store, data } = memoryStore();
		data.set('obsidian-sync/conflicts', '{not json');

		expect(new ConflictList(store).all()).toEqual([]);
	});
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/plugin/src/state/conflict-list.test.ts`

Expected: FAIL — cannot resolve `./conflict-list.js`.

- [x] **Step 3: Implement `ConflictList`**

`packages/plugin/src/state/conflict-list.ts`:

```typescript
import type { ConflictRecord } from '../engine/sync.js';
import type { LocalStateStore } from './local-state.js';

const conflictsKey = 'obsidian-sync/conflicts';

function isRecord(value: unknown): value is ConflictRecord {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<ConflictRecord>;
	return typeof candidate.path === 'string' && typeof candidate.conflictCopyPath === 'string';
}

/**
 * Unresolved conflicts, per device, outside data.json (§6.4).
 *
 * Durable because the conflict copies themselves are durable: losing the list on
 * restart leaves copies sitting in the vault that nothing will ever offer to resolve.
 * Keyed by path — a second conflict on one note supersedes the first, since the newer
 * copy is the one holding the bytes the user has not seen yet.
 */
export class ConflictList {
	readonly #store: LocalStateStore;

	constructor(store: LocalStateStore) {
		this.#store = store;
	}

	all(): ConflictRecord[] {
		const raw = this.#store.get(conflictsKey);
		if (raw === null) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
		} catch {
			return [];
		}
	}

	add(record: ConflictRecord): void {
		this.#write([...this.all().filter((entry) => entry.path !== record.path), record]);
	}

	remove(path: string): void {
		this.#write(this.all().filter((entry) => entry.path !== path));
	}

	/** Drops records whose copy the user deleted or renamed behind the plugin's back. */
	async prune(exists: (path: string) => Promise<boolean>): Promise<void> {
		const kept: ConflictRecord[] = [];
		for (const entry of this.all()) {
			if (await exists(entry.conflictCopyPath)) {
				kept.push(entry);
			}
		}
		this.#write(kept);
	}

	#write(records: ConflictRecord[]): void {
		this.#store.set(conflictsKey, JSON.stringify(records));
	}
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/plugin/src/state/conflict-list.test.ts`

Expected: PASS, 5 tests.

- [x] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint:fix && pnpm typecheck
git add packages/plugin/src/state/conflict-list.ts packages/plugin/src/state/conflict-list.test.ts
git commit -m "feat: persist unresolved conflicts per device"
```

---

## Task 3: The modal

Deliverable: a modal that shows one conflict and reports the user's choice through a callback. It holds no business logic — it maps a button to a `ConflictChoice` — which is what makes it acceptable that `testing/obsidian-stub.ts` has no `Modal` to instantiate in a test. Verification here is typecheck plus the manual pass in Task 4.

Because there is no diff view in this scope, the mtime and size lines are the *only* information the user has to choose with. They are not decoration; do not drop them.

**Files:**
- Create: `packages/plugin/src/obsidian/conflict-modal.ts`
- Modify: `packages/plugin/styles.css`

**Interfaces:**
- Consumes: `ConflictChoice`, `ConflictRecord` from `engine/sync.js` (Task 1).
- Produces: `class ConflictModal extends Modal`, constructed as `new ConflictModal(app, record, onChoose)` where `onChoose: (choice: ConflictChoice) => Promise<void>`.

- [x] **Step 1: Write the modal**

`packages/plugin/src/obsidian/conflict-modal.ts`:

```typescript
import { type App, Modal, Setting } from 'obsidian';
import type { ConflictChoice, ConflictRecord } from '../engine/sync.js';

function describeSide(app: App, path: string): string {
	const file = app.vault.getFileByPath(path);
	if (file === null) {
		return 'missing';
	}
	const when = new Date(file.stat.mtime).toLocaleString();
	return `${when} · ${Math.max(1, Math.round(file.stat.size / 1024))} KB`;
}

/**
 * One conflict, one choice. Both sides are already files in the vault by the time this
 * opens (§8), so the modal reads them for metadata only and never holds their bytes.
 */
export class ConflictModal extends Modal {
	readonly #record: ConflictRecord;
	readonly #onChoose: (choice: ConflictChoice) => Promise<void>;

	constructor(
		app: App,
		record: ConflictRecord,
		onChoose: (choice: ConflictChoice) => Promise<void>,
	) {
		super(app);
		this.#record = record;
		this.#onChoose = onChoose;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Resolve conflict');

		contentEl.createEl('p', {
			text: `${this.#record.path} was edited on two devices and the changes could not be merged.`,
		});

		const sides = contentEl.createDiv({ cls: 'obsidian-sync-conflict__sides' });
		const mine = sides.createDiv({ cls: 'obsidian-sync-conflict__side' });
		mine.createEl('strong', { text: 'Yours' });
		mine.createDiv({ text: this.#record.conflictCopyPath });
		mine.createDiv({
			cls: 'obsidian-sync-conflict__meta',
			text: describeSide(this.app, this.#record.conflictCopyPath),
		});

		const remote = sides.createDiv({ cls: 'obsidian-sync-conflict__side' });
		remote.createEl('strong', { text: 'From another device' });
		remote.createDiv({ text: this.#record.path });
		remote.createDiv({
			cls: 'obsidian-sync-conflict__meta',
			text: describeSide(this.app, this.#record.path),
		});

		new Setting(contentEl).addButton((button) =>
			button.setButtonText('Open both side by side').onClick(() => {
				void this.#openBoth();
			}),
		);

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText('Keep mine')
					.setCta()
					.onClick(() => {
						void this.#choose('mine');
					}),
			)
			.addButton((button) =>
				button.setButtonText('Keep theirs').onClick(() => {
					void this.#choose('remote');
				}),
			)
			.addButton((button) =>
				button.setButtonText('Keep both').onClick(() => {
					void this.#choose('both');
				}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	async #choose(choice: ConflictChoice): Promise<void> {
		this.close();
		await this.#onChoose(choice);
	}

	async #openBoth(): Promise<void> {
		const theirs = this.app.vault.getFileByPath(this.#record.path);
		const mine = this.app.vault.getFileByPath(this.#record.conflictCopyPath);
		this.close();
		if (theirs !== null) {
			await this.app.workspace.getLeaf(false).openFile(theirs);
		}
		if (mine !== null) {
			await this.app.workspace.getLeaf('split', 'vertical').openFile(mine);
		}
	}
}
```

- [x] **Step 2: Add the styles**

Append to `packages/plugin/styles.css`, above the core-Sync-hiding block:

```css
.obsidian-sync-conflict__sides {
	display: flex;
	gap: 12px;
	flex-wrap: wrap;
	margin-bottom: 12px;
}

.obsidian-sync-conflict__side {
	flex: 1 1 200px;
	padding: 8px;
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-s);
	word-break: break-word;
}

.obsidian-sync-conflict__meta {
	color: var(--text-muted);
	font-size: var(--font-ui-smaller);
}
```

- [x] **Step 3: Typecheck and commit**

Nothing imports the modal yet, so `pnpm typecheck` is the whole gate here.

```bash
pnpm lint:fix && pnpm typecheck
git add packages/plugin/src/obsidian/conflict-modal.ts packages/plugin/styles.css
git commit -m "feat: add the conflict resolution modal"
```

---

## Task 4: Wire it up

Deliverable: a conflict is reachable and resolvable from the sidebar, the notice, and the command palette, and the list survives a restart.

**Files:**
- Modify: `packages/plugin/src/main.ts`
- Modify: `packages/plugin/src/obsidian/status-view.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `SyncPlugin.pendingConflicts: ConflictRecord[]` (now a getter over `ConflictList`), `SyncPlugin.resolveConflict(record, choice): Promise<void>`, `SyncPlugin.openConflict(record): void`.

- [x] **Step 1: Own the list in `main.ts`**

Add `ConflictChoice` to the **existing** engine import rather than a second statement from the same module — Biome's import organiser will reject a duplicate:

```typescript
import {
	type ConflictChoice,
	type ConflictRecord,
	type EngineStatus,
	SyncEngine,
} from './engine/sync.js';
import { ConflictModal } from './obsidian/conflict-modal.js';
import { ConflictList } from './state/conflict-list.js';
```

`createVaultAdapter` and `createLocalStateStore` are already imported.

Replace the `pendingConflicts` field with a lazily-constructed list plus a getter, so `status-view.ts` and `#updateStatusTooltip()` keep working unchanged:

```typescript
	#conflicts: ConflictList | null = null;

	get pendingConflicts(): ConflictRecord[] {
		return this.#conflicts?.all() ?? [];
	}
```

In `onload()`, construct it before the status bar is rendered:

```typescript
		this.#conflicts = new ConflictList(createLocalStateStore(this.app));
```

Replace the `onConflict` callback passed to `new SyncEngine({...})` in `#buildEngine` with:

```typescript
			onConflict: (conflict) => {
				this.#conflicts?.add(conflict);
				this.#renderStatusBar();
				this.#refreshStatusView();
				const notice = new Notice(`Conflict on ${conflict.path} — click to resolve.`, 15000);
				notice.noticeEl.addEventListener('click', () => {
					this.openConflict(conflict);
				});
			},
```

- [x] **Step 2: Prune the list once the vault is actually visible**

Obsidian populates its file cache *after* layout, so at `onload()` every `exists()` answers `false` and a prune would delete the whole list — the same trap that made absence read as a mass delete on the push path.

The existing code guards `onLayoutReady` with `if (this.settings.enabled)`. Pruning must happen even when sync is off, so that conflicts left behind by a now-disabled sync are still listed and resolvable. Replace the whole block at the end of `onload()`:

```typescript
		this.app.workspace.onLayoutReady(() => {
			void this.#afterLayoutReady();
		});
```

and add the method (`.then()` is banned by the constraints, hence a real async method rather than a chained callback):

```typescript
	async #afterLayoutReady(): Promise<void> {
		// Obsidian populates its file cache after layout. Pruning any earlier sees an
		// empty vault and drops every live conflict.
		const vault = createVaultAdapter(this.app);
		await this.#conflicts?.prune((path) => vault.exists(path));
		this.#renderStatusBar();
		this.#refreshStatusView();
		if (this.settings.enabled) {
			// Same reason the engine starts here rather than in onload().
			await this.reloadEngine();
		}
	}
```

- [x] **Step 3: Add the resolve and open methods to `SyncPlugin`**

```typescript
	openConflict(record: ConflictRecord): void {
		new ConflictModal(this.app, record, (choice) => this.resolveConflict(record, choice)).open();
	}

	async resolveConflict(record: ConflictRecord, choice: ConflictChoice): Promise<void> {
		if (this.#engine === null) {
			new Notice('Sync is not running, so this conflict cannot be resolved yet.');
			return;
		}
		// A resolution writes the same file a running sync may be mid-apply on.
		if (this.#syncing !== null) {
			await this.#syncing;
		}

		try {
			const outcome = await this.#engine.resolveConflict(record, choice);
			if (outcome === 'stale') {
				new Notice(`${record.path} changed just now — open it and resolve again.`);
				return;
			}
			this.#conflicts?.remove(record.path);
			// The engine raises 'conflict' and only a later sync lowers it, so without this
			// the warning glyph outlives the last resolved conflict.
			if (this.lastStatus === 'conflict' && this.pendingConflicts.length === 0) {
				this.#setStatus('idle');
			}
			if (outcome === 'missing-copy') {
				new Notice(`The conflict copy for ${record.path} is gone; nothing to resolve.`);
			} else if (choice === 'mine') {
				void this.requestSync();
			}
		} catch (error) {
			this.#setStatus('error');
			this.#logError(error);
			new Notice(`Could not resolve ${record.path}: ${(error as Error).message}`);
		} finally {
			this.#renderStatusBar();
			this.#refreshStatusView();
		}
	}
```

- [x] **Step 4: Register a command**

In `#registerCommands()`, after the existing `open-status` command:

```typescript
		this.addCommand({
			id: 'resolve-conflicts',
			name: 'Resolve sync conflicts',
			callback: () => {
				const next = this.pendingConflicts[0];
				if (next === undefined) {
					new Notice('No unresolved sync conflicts.');
					return;
				}
				this.openConflict(next);
			},
		});
```

- [x] **Step 5: Make the sidebar rows resolve**

In `status-view.ts`, replace the `pendingConflicts` block with rows that open the modal:

```typescript
		const conflicts = this.#plugin.pendingConflicts;
		if (conflicts.length > 0) {
			const list = root.createDiv({ cls: 'obsidian-sync-status__conflicts' });
			list.createDiv({ text: `${conflicts.length} unresolved conflict(s):` });
			for (const conflict of conflicts) {
				const row = list.createDiv({ cls: 'obsidian-sync-status__conflict' });
				row.createSpan({ text: conflict.path });
				row
					.createEl('button', { text: 'Resolve' })
					.addEventListener('click', () => this.#plugin.openConflict(conflict));
			}
		}
```

And widen the row rule in `styles.css` so the button sits beside the path:

```css
.obsidian-sync-status__conflict {
	color: var(--text-error);
	padding-left: 8px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
```

- [x] **Step 6: Verify the whole suite still passes**

Run: `pnpm lint:fix && pnpm typecheck && pnpm test && pnpm build`

Expected: PASS everywhere. `main.ts` has no unit tests, so the build is the compile-level gate.

- [ ] **Step 7: Manual pass against two real vaults**

Automated tests cannot reach Obsidian's Modal. Run this once; a plugin reload is not enough to pick up a new bundle — restart Obsidian (a toggle keeps the old `main.js`).

1. On device A and device B, sync the same note.
2. Take B offline. Edit the same line differently on both. Bring B back and sync.
3. B shows a notice — click it. The modal names both sides with times and sizes.
4. *Open both side by side* shows the two files in a split. Reopen the modal from the sidebar.
5. *Keep mine* → the note holds your text, the copy is gone, and within a sync A shows your text.
6. Repeat for *Keep theirs* (copy gone, note unchanged) and *Keep both* (nothing changes, row disappears).
7. Force a conflict, then **restart Obsidian without resolving** → the sidebar still lists it.
8. Open the modal, and before clicking, edit the note in another pane → *Keep mine* reports "changed just now" and keeps both files.

- [x] **Step 8: Update the README**

In *Not yet implemented*, delete the bullet:

> - Conflict resolution modal — conflicts produce a copy and a notice, but no interactive resolve.

and add to the feature list, near the sync-status description:

> - Conflict resolution: an unmergeable edit is copied aside and listed in the sync status view until you choose *keep mine*, *keep theirs*, or *keep both*. The list survives a restart. There is no diff view yet — the modal opens both files side by side instead.

- [x] **Step 9: Commit**

```bash
git add packages/plugin/src/main.ts packages/plugin/src/obsidian/status-view.ts packages/plugin/styles.css README.md
git commit -m "feat: resolve sync conflicts from the sidebar, a notice, or a command"
```

---

## Done when

- [ ] A conflict can be resolved three ways from the sidebar, the notice, and the command palette.
- [ ] *Keep mine* republishes to the other device on the next sync (covered by an engine test, verified manually).
- [ ] An unresolved conflict is still listed after an Obsidian restart.
- [x] Resolving never destroys bytes: the losing side goes to the trash, never `remove()`, and a concurrent edit aborts the write rather than clobbering it.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.

## Known residual race

Awaiting `#syncing` narrows the window but does not close it: a nudge can start a new
sync between that await and the write. The real protection is the `expected` guard —
the write then fails with `StaleWriteError` and the user is told to choose again, which
is a correct, non-destructive outcome. Do not add a lock to close the window; the CAS
guard is the invariant, and a lock would be a second, weaker copy of it.

## Deliberately deferred

- **Diff view.** The next increment: render `lcsOps` (`engine/merge.ts:14`) as an inline line diff inside the modal. No new dependency needed.
- **Hunk-level merge.** Requires reshaping `merge3` to collect every conflicting cluster instead of returning at the first, and threading the base text into `ConflictRecord`.
- **Clicking the status bar icon** to open the sync status view.
- **Conflict copies of binary files** get the same three choices; there is nothing to diff, so this plan is already their final UI.

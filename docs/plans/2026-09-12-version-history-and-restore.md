# Obsidian Sync — Version History and Restore

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec §6.3.5 — a per-note version history modal that lists a file's versions with timestamp, originating device and size, previews the diff between any version and the current file, and restores a version *as a new version*, never by rewriting history.

**Spec:** `docs/specs/2026-09-10-obsidian-sync-design.md` §5.5 (API surface), §6.3.5 (modal), §6.3.7 (commands), §4.4/D5 (chunk addressing and meta authentication).

**Prior plan:** `docs/plans/2026-09-10-server-and-protocol.md` — Task 12 built the commit/version storage this plan reads from, Task 15 built the retention that bounds it.

---

## What actually exists today

The README says "the server API exists; the plugin does not call it". Half of that is true. Verified against the source:

| Piece | State |
|---|---|
| `version` table with `parent_version`, `meta_blob`, `chunks`, `size`, `device_id`, `created_at` | Exists (`packages/server/src/db/schema.ts`) |
| `listVersions()` + `GET /v1/vaults/:v/files/:fileId/versions` | Exists, returns `VersionSummary[]` |
| `ApiClient.versions()` | Exists, **called from nowhere** in the plugin |
| Version rows surviving a delete | Exists — `deleteFile()` tombstones the file and deliberately leaves the version rows |
| Retention that prunes a version row *and* releases its chunk refcounts together | Exists (`retention.ts`) |

Four things are missing, and three of them are on the server, not only in the UI:

1. **`VersionSummary` carries no `metaBlob`.** The ordered chunk-address list lives *inside* the encrypted meta envelope (decision D5), not in the summary. Without the meta blob a client can list versions but cannot decrypt the path, cannot learn which chunks to fetch, and therefore cannot render or restore a single historical byte. This is the blocking gap.
2. **The list is unbounded.** `listVersions` returns every row for a file. With `VERSION_RETENTION_MIN=10` and 90 days of retention, a note saved often holds hundreds.
3. **`device_id` is a raw UUID.** `LocalState.ensureDeviceId()` mints `crypto.randomUUID()`; the human-readable `settings.deviceLabel` is never sent anywhere. "Originating device" in §6.3.5 would render as `9f3c1a7e-…`.
4. **No UI.** No modal, no command, no file-menu entry.

---

## Global constraints

Everything in `docs/plans/2026-09-10-server-and-protocol.md` → *Global Constraints* applies unchanged. The load-bearing ones for this plan:

- Node 26 / TypeScript 7 / ESM, `.js` on every relative import, pnpm only.
- `exactOptionalPropertyTypes: true` is on. An optional field that may be explicitly assigned `undefined` must be declared `field?: T | undefined`, not `field?: T`.
- `noUncheckedIndexedAccess: true` is on. Every array index read is `T | undefined`.
- No `any`. `undefined` over `null`. `??` never `||`. Braces always. Single quotes. Tabs.
- Comments explain *why*, or record a constraint the code cannot show. Never restate the code.
- Conventional commits, no Claude co-author trailer, no new branches.
- **The server never decrypts anything.** Every field this plan adds to the server is opaque ciphertext or a plaintext number the server already stores.

---

## Design decisions

### H1 — The version list carries `metaBlob`; there is no separate detail endpoint

`GET .../versions` gains `metaBlob` on every entry, plus `limit`/`offset` paging.

The rejected alternative was a second endpoint, `GET .../versions/:versionId`, returning the meta blob for one version. It keeps the list small, but the device label and the file size-on-disk both live inside the encrypted meta, so rendering a 50-row list would need 50 extra round trips before the first row could show a device name — an N+1 over Tailscale, on a phone, to populate a list the user is already looking at.

The cost of inlining is response size. A meta blob is base64 of `{encryptedPath, mtime, ctime, mime, size, chunks[], deviceLabel}`; the chunk list dominates, at 64 hex characters per 4 MiB of file. A typical note is one chunk (~250 bytes of blob); a 1 GiB attachment is 256 chunks (~25 KiB of blob per version). Fifty versions of that attachment is a ~1.2 MiB response — acceptable for an explicit, rare user action, and bounded by `limit`.

### H2 — The device label travels inside the encrypted meta, never in a server column

`version.device_id` stays exactly as it is: an opaque per-device UUID the server uses for nothing. The human label is added to `FileMeta`, which is AES-GCM sealed under `K_content` with `AAD = fileId`. The server therefore learns no device names, and the label is per-version, which is precisely what history wants — renaming a device does not retroactively relabel old versions.

`deviceLabel` is optional in `FileMeta`: every version committed before this ships has none. The UI falls back to `this device` when the version's `deviceId` matches the local one, and to a short `deviceId` prefix otherwise.

### H3 — Restore writes through the vault and lets the ordinary push commit it

`restore()` decodes the chosen version, writes those bytes to the file with the compare-and-set `expected` guard, and triggers a normal sync. The push path then commits them as a new version whose `parentVersion` is the current head.

The rejected alternative was committing directly to the server from the modal. It bypasses the file index and the base cache, races the debounced watcher, and needs its own 409 handling — a second, thinner copy of the logic `SyncEngine` already gets right. Writing through the vault means restore inherits stale-write detection, three-way merge, conflict copies and the offline path for free, and satisfies "restores a version as a new version, never by rewriting history" by construction: nothing in the restore path touches a `version` row.

### H4 — Restore always targets the version's own path, and that is provably the current path

`fileId = HMAC(K_name, normalisedPath)` (§4.2, D4), so a rename mints a new identity and starts a new version chain. Every version under one `fileId` therefore decrypts to the same path. The modal does not need to ask where to restore to, and a "this version was at a different path" case cannot arise. The cost — history does not survive a rename — is decision D4, already accepted; the modal states it in a footer line rather than pretending otherwise.

### H5 — Diff preview is capped, because the merge engine's LCS table is quadratic

`lcsOps` allocates a `(a.length + 1) × (b.length + 1)` number table. At 2000 lines a side that is ~4M cells, roughly 16–32 MB in V8 — tolerable once, on demand, on a phone. At 20000 lines it is 400M cells and the renderer dies. The preview therefore refuses above `previewMaxLines = 2000` or `previewMaxBytes = 1 MiB` and shows a byte-level summary instead. Restore itself has no cap; only the preview does.

(`merge3` carries the same quadratic cost on the sync path today. Out of scope here, noted in the self-review.)

### H6 — Restoring a *deleted* file is out of scope for this plan

`GET /state` omits tombstones and `#applyRemoteDelete` drops the index entry, so no device can name the `fileId` of a deleted note. Undeleting needs a server-side tombstone listing; it is specified as optional Task 10 and can ship separately without changing anything below.

---

## File structure

```
packages/protocol/src/
├── wire.ts                          MODIFY  VersionSummary gains metaBlob; VersionsResponse gains hasMore
packages/server/src/
├── files.ts                         MODIFY  listVersions gains meta_blob + limit/offset
├── files.test.ts                    MODIFY  paging, ordering, meta blob round-trip
├── routes/files.ts                  MODIFY  query parsing, fileId validation on the versions route
└── routes/files.test.ts             CREATE  route-level tests for the versions endpoint
packages/plugin/src/
├── crypto/meta.ts                   MODIFY  FileMeta.deviceLabel
├── engine/codec.ts                  MODIFY  encodeFile takes an options object carrying deviceLabel
├── engine/copy.ts                   CREATE  timestamped, collision-free sidecar paths
├── engine/copy.test.ts              CREATE
├── engine/history.ts                CREATE  VersionHistoryService — list, read, restore, restoreAsCopy
├── engine/history.test.ts           CREATE  against FakeServer with real crypto
├── engine/merge.ts                  MODIFY  export DiffOp + diffLines
├── engine/merge.test.ts             MODIFY  diffLines cases
├── engine/preview.ts                CREATE  capped diff/binary/identical preview model
├── engine/preview.test.ts           CREATE
├── engine/sync.ts                   MODIFY  deviceLabel, shared text helpers, shared copy-path helper
├── engine/text.ts                   CREATE  isTextPath, extracted from sync.ts
├── main.ts                          MODIFY  service wiring, command, file-menu entry
├── obsidian/version-history-modal.ts CREATE  the view
├── testing/fake-server.ts           MODIFY  versions route, ordinal-stable ordering
└── transport/client.ts              MODIFY  ApiClient.versions gains paging
packages/plugin/styles.css           MODIFY  modal styles
```

---

## Task 1: Protocol — the version list carries the meta blob and pages

**Files:**
- Modify: `packages/protocol/src/wire.ts`

**Interfaces:**
- Produces: `VersionSummary` with `metaBlob: string`; `VersionsResponse` with `hasMore: boolean`.

- [x] **Step 1: Extend the wire types**

In `packages/protocol/src/wire.ts`, replace the existing `VersionSummary` and `VersionsResponse`:

```typescript
export interface VersionSummary {
	versionId: string;
	parentVersion: string | undefined;
	/**
	 * Base64 of the encrypted metadata envelope committed with this version. It is
	 * what makes a version readable: the ordered chunk-address list lives inside it
	 * (decision D5), not in this record, so the server cannot enumerate a version's
	 * content and a client without K_content cannot either.
	 */
	metaBlob: string;
	/** Plaintext byte length, for display only. */
	size: number;
	deviceId: string;
	createdAt: number;
}

export interface VersionsResponse {
	versions: VersionSummary[];
	/** True when older versions exist beyond the requested window. */
	hasMore: boolean;
}
```

No validator is needed: this is a response shape, and `packages/protocol/src/validate.ts` guards request bodies only.

- [x] **Step 2: Verify**

Run: `pnpm --filter @obsidian-sync/protocol typecheck`
Expected: passes. `packages/server/src/routes/files.ts` will now fail to typecheck until Task 2 — that is the intended signal.

---

## Task 2: Server — return the meta blob, bound the window, validate the file id

`listVersions` currently returns every row for a file with no limit. A note saved every few minutes for 90 days produces thousands; the endpoint must not be able to return them all in one response.

**Files:**
- Modify: `packages/server/src/files.ts`
- Modify: `packages/server/src/routes/files.ts`
- Modify: `packages/server/src/files.test.ts`
- Create: `packages/server/src/routes/files.test.ts`

**Interfaces:**
- Produces: `listVersions(db, vaultId, fileId, window: VersionWindow): VersionPage`
  - `interface VersionWindow { limit: number; offset: number }`
  - `interface VersionPage { versions: VersionSummary[]; hasMore: boolean }`
- Consumes: `versionListDefaultLimit`, `versionListMaxLimit` (new constants, local to `files.ts`).

- [x] **Step 1: Write the failing test**

Append to `packages/server/src/files.test.ts`, replacing the existing `describe('listVersions')` block:

```typescript
describe('listVersions', () => {
	test('returns newest first with the committed meta blob', () => {
		const first = commit(undefined);
		const second = commit(first.status === 'committed' ? first.versionId : undefined);

		const page = listVersions(db, 'v1', fileId, { limit: 50, offset: 0 });

		expect(page.versions).toHaveLength(2);
		expect(page.versions[0]?.versionId).toBe(
			second.status === 'committed' ? second.versionId : 'unreachable',
		);
		expect(page.versions[0]?.metaBlob).toBe('bWV0YQ==');
		expect(page.versions[1]?.parentVersion).toBeUndefined();
		expect(page.hasMore).toBe(false);
	});

	test('orders versions committed in the same millisecond by insertion, newest first', () => {
		// created_at has millisecond resolution, so a scripted restore or a fast
		// rebuild can land two versions on the same tick. rowid is the tiebreak;
		// without it history renders in an order the user did not edit in.
		let parent: string | undefined;
		const committed: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const outcome = commit(parent);
			if (outcome.status !== 'committed') {
				throw new Error('setup commit rejected');
			}
			parent = outcome.versionId;
			committed.push(outcome.versionId);
		}

		const page = listVersions(db, 'v1', fileId, { limit: 50, offset: 0 });

		expect(page.versions.map((version) => version.versionId)).toEqual([...committed].reverse());
	});

	test('pages, and reports that more remain', () => {
		let parent: string | undefined;
		for (let index = 0; index < 5; index += 1) {
			const outcome = commit(parent);
			parent = outcome.status === 'committed' ? outcome.versionId : undefined;
		}

		const first = listVersions(db, 'v1', fileId, { limit: 2, offset: 0 });
		const second = listVersions(db, 'v1', fileId, { limit: 2, offset: 2 });
		const last = listVersions(db, 'v1', fileId, { limit: 2, offset: 4 });

		expect(first.versions).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		expect(second.versions).toHaveLength(2);
		expect(second.hasMore).toBe(true);
		expect(last.versions).toHaveLength(1);
		expect(last.hasMore).toBe(false);
	});

	test('keeps the versions of a deleted file', () => {
		const created = commit(undefined);
		deleteFile(db, {
			vaultId: 'v1',
			fileId,
			parentVersion: created.status === 'committed' ? created.versionId : undefined,
		});

		expect(listVersions(db, 'v1', fileId, { limit: 50, offset: 0 }).versions).toHaveLength(1);
	});

	test('never crosses a vault boundary', () => {
		commit(undefined);

		expect(listVersions(db, 'v2', fileId, { limit: 50, offset: 0 }).versions).toHaveLength(0);
	});
});
```

Run: `pnpm test -- files.test`
Expected: fails — `listVersions` takes three arguments and returns an array.

- [x] **Step 2: Implement**

In `packages/server/src/files.ts`, replace `listVersions`:

```typescript
export interface VersionWindow {
	limit: number;
	offset: number;
}

export interface VersionPage {
	versions: VersionSummary[];
	hasMore: boolean;
}

export function listVersions(
	db: DatabaseSync,
	vaultId: string,
	fileId: string,
	window: VersionWindow,
): VersionPage {
	// One row beyond the window answers hasMore without a second COUNT query.
	const rows = db
		.prepare(
			'SELECT version_id, parent_version, meta_blob, size, device_id, created_at FROM version WHERE vault_id = ? AND file_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
		)
		.all(vaultId, fileId, window.limit + 1, window.offset) as {
		version_id: string;
		parent_version: string | null;
		meta_blob: string;
		size: number;
		device_id: string;
		created_at: number;
	}[];

	const hasMore = rows.length > window.limit;
	return {
		versions: rows.slice(0, window.limit).map((row) => ({
			versionId: row.version_id,
			parentVersion: row.parent_version ?? undefined,
			metaBlob: row.meta_blob,
			size: row.size,
			deviceId: row.device_id,
			createdAt: row.created_at,
		})),
		hasMore,
	};
}
```

Add the import of `VersionSummary` if it is not already present, and keep the existing `FileState` import.

- [x] **Step 3: Wire the route**

In `packages/server/src/routes/files.ts`, replace the versions handler:

```typescript
const versionListDefaultLimit = 50;
const versionListMaxLimit = 200;

function parseWindow(query: { limit?: string; offset?: string }): VersionWindow {
	const limit = Number(query.limit ?? versionListDefaultLimit);
	const offset = Number(query.offset ?? 0);
	return {
		limit:
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, versionListMaxLimit) : versionListDefaultLimit,
		offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
	};
}
```

```typescript
	scope.get<{ Params: FileParams; Querystring: { limit?: string; offset?: string } }>(
		'/v1/vaults/:vaultId/files/:fileId/versions',
		async (request, reply) => {
			const { vaultId, fileId } = request.params;
			if (!fileIdPattern.test(fileId)) {
				return reply.code(400).send({ error: 'invalid_file_id' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const response: VersionsResponse = listVersions(db, vaultId, fileId, parseWindow(request.query));
			return reply.send(response);
		},
	);
```

`VersionWindow` and `VersionsResponse` join the existing imports in this file; `listVersions` now returns the response shape directly, so no mapping is left in the route.

The `fileIdPattern` guard is new. The route previously accepted any string and returned an empty list, which is harmless but inconsistent with the commit and delete handlers on the same path.

- [x] **Step 4: Route-level test**

Create `packages/server/src/routes/files.test.ts`, copying the `beforeEach`/`afterEach` harness from `packages/server/src/routes/vaults.test.ts` (temp dir, `buildApp`, two users). Cover:

```typescript
describe('GET /v1/vaults/:vaultId/files/:fileId/versions', () => {
	test('rejects a non-hex file id', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/not-a-file-id/versions`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(400);
	});

	test('hides another user vault behind a 404', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/${fileId}/versions`,
			headers: authorised(bobToken),
		});
		expect(response.statusCode).toBe(404);
	});

	test('clamps an oversized limit instead of returning everything', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/${fileId}/versions?limit=100000`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect((response.json() as VersionsResponse).versions.length).toBeLessThanOrEqual(200);
	});

	test('ignores a junk limit rather than returning zero rows', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/files/${fileId}/versions?limit=abc&offset=-5`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect((response.json() as VersionsResponse).versions.length).toBeGreaterThan(0);
	});
});
```

- [x] **Step 5: Verify**

Run: `pnpm lint && pnpm --filter @obsidian-sync/server typecheck && pnpm test`
Expected: all pass.

---

## Task 3: Transport — paging on the client, and a faithful fake

**Files:**
- Modify: `packages/plugin/src/transport/client.ts`
- Modify: `packages/plugin/src/testing/fake-server.ts`

**Interfaces:**
- Produces: `ApiClient.versions(vaultId, fileId, window?: { limit?: number; offset?: number }): Promise<VersionsResponse>`

- [x] **Step 1: Client**

Replace `ApiClient.versions`:

```typescript
	versions(
		vaultId: string,
		fileId: string,
		window?: { limit?: number; offset?: number },
	): Promise<VersionsResponse> {
		const query: Record<string, string | number> = {};
		if (window?.limit !== undefined) {
			query.limit = window.limit;
		}
		if (window?.offset !== undefined) {
			query.offset = window.offset;
		}
		return this.#call<VersionsResponse>({
			path: withQuery(`/v1/vaults/${vaultId}/files/${fileId}/versions`, query),
			method: 'GET',
		});
	}
```

- [x] **Step 2: Fake server**

`FakeServer` already stores every committed version but serves no route for them. Two changes.

First, ordering fidelity. `StoredVersion` gains an `ordinal`, because `Date.now()` repeats within a millisecond and the real server tiebreaks on `rowid` **descending** — a stable sort over insertion order would tiebreak *ascending* and the fake would disagree with the server exactly where a test is most likely to look:

```typescript
interface StoredVersion {
	versionId: string;
	fileId: string;
	parentVersion: string | undefined;
	metaBlob: string;
	chunks: string[];
	size: number;
	deviceId: string;
	createdAt: number;
	/** Stands in for the server's rowid: the DESC tiebreak within one millisecond. */
	ordinal: number;
}
```

Set `ordinal: this.versionCounter` inside `commit()`, after `nextVersionId()` has incremented it.

Second, the route. In `request()`, before the `POST`/`DELETE` dispatch:

```typescript
		if (parts[3] === 'files' && parts[4] !== undefined && parts[5] === 'versions') {
			if (method === 'GET') {
				return this.listVersions(parts[4], url.searchParams);
			}
		}
```

```typescript
	private listVersions(fileId: string, params: URLSearchParams): SyncResponse {
		const limit = Number(params.get('limit') ?? '50');
		const offset = Number(params.get('offset') ?? '0');
		const all = [...this.versions.values()]
			.filter((version) => version.fileId === fileId)
			.sort((left, right) => right.createdAt - left.createdAt || right.ordinal - left.ordinal);
		const page = all.slice(offset, offset + limit);
		return this.json(200, {
			versions: page.map((version) => ({
				versionId: version.versionId,
				parentVersion: version.parentVersion,
				metaBlob: version.metaBlob,
				size: version.size,
				deviceId: version.deviceId,
				createdAt: version.createdAt,
			})),
			hasMore: offset + page.length < all.length,
		});
	}
```

- [x] **Step 3: Verify**

Run: `pnpm --filter @obsidian-sync/plugin typecheck && pnpm test`
Expected: the existing engine tests still pass; nothing calls the new route yet.

---

## Task 4: The device label, sealed inside the meta envelope

Spec §6.3.5 wants "originating device". The server holds only a random UUID, and it must stay that way (H2). The label rides inside the AES-GCM envelope the server already stores untouched.

**Files:**
- Modify: `packages/plugin/src/crypto/meta.ts`
- Modify: `packages/plugin/src/engine/codec.ts`
- Modify: `packages/plugin/src/engine/sync.ts`
- Modify: `packages/plugin/src/main.ts`
- Modify: `packages/plugin/src/engine/engine.test.ts` — `SyncEngineDeps` gains a required field

**Interfaces:**
- Produces: `FileMeta.deviceLabel?: string | undefined`; `encodeFile(keys: PurposeKeys, options: EncodeFileOptions)`; `SyncEngine.updateDeviceLabel(label: string)`.

- [x] **Step 1: Extend `FileMeta`**

In `packages/plugin/src/crypto/meta.ts`, add to the `FileMeta` interface:

```typescript
	/**
	 * The committing device's human name, for version history. Sealed here rather
	 * than sent as a column so the server never learns device names; absent on every
	 * version committed before this field existed, hence optional in both directions.
	 */
	deviceLabel?: string | undefined;
```

`| undefined` is required by `exactOptionalPropertyTypes`, because the call site assigns the value unconditionally.

- [x] **Step 2: Move `encodeFile` to an options object**

Five positional parameters was already the ceiling. In `packages/plugin/src/engine/codec.ts`:

```typescript
export interface EncodeFileOptions {
	path: string;
	data: Uint8Array;
	mtime: number;
	ctime: number;
	mime: string;
	deviceLabel: string;
}

export async function encodeFile(
	keys: PurposeKeys,
	options: EncodeFileOptions,
): Promise<EncodedFile> {
	const fileId = await computeFileId(keys.nameMacKey, options.path);
	const encryptedPath = await encryptPath(keys.pathCryptoKey, options.path);

	const chunks: EncodedChunk[] = [];
	for (const chunk of splitChunks(options.data)) {
		chunks.push({
			address: await blobAddress(keys.contentMacKey, chunk),
			blob: await encryptChunkBlob(keys.contentCryptoKey, keys.contentMacKey, chunk),
		});
	}

	const meta: FileMeta = {
		encryptedPath,
		mtime: options.mtime,
		ctime: options.ctime,
		mime: options.mime,
		size: options.data.length,
		chunks: chunks.map((chunk) => chunk.address),
		deviceLabel: options.deviceLabel,
	};

	return {
		fileId,
		chunks,
		metaBlob: await encryptFileMeta(keys.contentCryptoKey, fileId, meta),
		size: options.data.length,
	};
}
```

- [x] **Step 3: Thread the label through the engine**

In `packages/plugin/src/engine/sync.ts`:

- add `deviceLabel: string;` to `SyncEngineDeps`, next to `deviceId`;
- hold it in a mutable field beside `#selective`, and add the live setter:

```typescript
	#deviceLabel: string;
```

```typescript
	/** Renaming a device applies to versions committed from now on, never retroactively. */
	updateDeviceLabel(deviceLabel: string): void {
		this.#deviceLabel = deviceLabel;
	}
```

- update the single `encodeFile` call site in `#pushFile`:

```typescript
		const encoded = await encodeFile(keys, {
			path: file.path,
			data,
			mtime: file.mtime,
			ctime: file.ctime,
			mime: mimeFor(file.path),
			deviceLabel: this.#deviceLabel,
		});
```

- [x] **Step 4: Wire the plugin**

In `packages/plugin/src/main.ts`, pass `deviceLabel: this.settings.deviceLabel` into the `SyncEngine` constructor, and add to `applyLiveSettings()`:

```typescript
		this.#engine?.updateDeviceLabel(this.settings.deviceLabel);
```

`detectDeviceName()` already fills `deviceLabel` on first load, so this is never empty in practice; the modal still guards for it.

- [x] **Step 5: Fix the engine tests**

`packages/plugin/src/engine/engine.test.ts` builds `SyncEngineDeps` literally in `makeDevice`. Add `deviceLabel: deviceId` there — using the device id as the label keeps the two-device assertions readable.

- [x] **Step 6: Verify**

Run: `pnpm --filter @obsidian-sync/plugin typecheck && pnpm test`
Expected: all existing tests pass. A version committed by the current build now carries a label; older ones do not, which is the case Task 6 covers.

---

## Task 5: Shared text, diff and sidecar-path helpers

Three small extractions, all of which exist to stop the history feature growing a second, divergent copy of logic the sync engine already owns.

**Files:**
- Create: `packages/plugin/src/engine/text.ts`
- Create: `packages/plugin/src/engine/copy.ts`
- Create: `packages/plugin/src/engine/copy.test.ts`
- Modify: `packages/plugin/src/engine/merge.ts`
- Modify: `packages/plugin/src/engine/merge.test.ts`
- Modify: `packages/plugin/src/engine/sync.ts`

**Interfaces:**
- Produces: `isTextPath(path: string): boolean`; `uniqueCopyPath(exists, path, marker): Promise<string>`; `copyStamp(at: number): string`; `type DiffOp`; `interface DiffRow`; `diffLines(beforeText, afterText): DiffRow[]`.

- [x] **Step 1: `engine/text.ts`**

Move `textExtensions` and `isTextPath` out of `sync.ts` verbatim:

```typescript
const textExtensions = [
	'.md',
	'.markdown',
	'.txt',
	'.csv',
	'.json',
	'.css',
	'.js',
	'.html',
	'.yml',
	'.yaml',
];

/** Whether the engine will attempt a line-based merge or diff on this path. */
export function isTextPath(path: string): boolean {
	return textExtensions.some((extension) => path.endsWith(extension));
}
```

In `sync.ts`, delete the local `textExtensions`, `isTextPath`, `bytesToText` and `textToBytes`, and import `isTextPath` from `./text.js` plus `bytesToText`/`textToBytes` from `../crypto/encoding.js` — which already export byte-identical implementations that `sync.ts` had duplicated.

- [x] **Step 2: `engine/copy.ts`**

`#conflictCopy` in `sync.ts` builds a timestamped, collision-free sidecar path. Restore-as-copy needs exactly the same thing with a different marker.

```typescript
/** `2026-09-12-14-31-07` — filename-safe, sorts chronologically, no colons for Windows. */
export function copyStamp(at: number): string {
	return new Date(at).toISOString().slice(0, 19).replace(/[T:]/g, '-');
}

/**
 * A sidecar path next to `path`, marked and timestamped, that no existing file
 * holds. Two restores in the same second, or a restore onto an earlier conflict
 * copy, must not silently overwrite the earlier sidecar.
 */
export async function uniqueCopyPath(
	exists: (candidate: string) => Promise<boolean>,
	path: string,
	marker: string,
): Promise<string> {
	const extension = /\.[^./]+$/.exec(path)?.[0] ?? '';
	const stem = `${path.slice(0, path.length - extension.length)} (${marker})`;
	let candidate = `${stem}${extension}`;
	for (let suffix = 2; await exists(candidate); suffix += 1) {
		candidate = `${stem} ${suffix}${extension}`;
	}
	return candidate;
}
```

Rewrite `SyncEngine.#conflictCopy` to use them, preserving today's `(conflict <stamp>)` marker so existing conflict copies keep their naming:

```typescript
	async #conflictCopy(path: string, localBytes: Uint8Array): Promise<void> {
		const copyPath = await uniqueCopyPath(
			(candidate) => this.#deps.vault.exists(candidate),
			path,
			`conflict ${copyStamp(Date.now())}`,
		);
		await this.#deps.vault.write(copyPath, localBytes);
		const record: ConflictRecord = { path, conflictCopyPath: copyPath };
		this.#status('conflict');
		this.#deps.onConflict?.(record);
	}
```

`packages/plugin/src/engine/copy.test.ts` covers: extension preserved, extensionless path, the `2`/`3` suffix ladder when the first two candidates exist, and a path whose folder contains a dot (`docs.v2/note.md` must not have `.v2/note` treated as the extension).

- [x] **Step 3: Export a line diff from `merge.ts`**

`lcsOps` is already there and already correct; only a walk over its output is missing. Export the op type and add:

```typescript
/** 'equal' advances both, 'delete' advances a only, 'insert' advances b only. */
export type DiffOp = 'equal' | 'delete' | 'insert';

export interface DiffRow {
	op: DiffOp;
	text: string;
}

/**
 * Line diff over the same LCS the three-way merge uses, so a preview can never
 * disagree with what the merge would do. Quadratic in line count — callers cap
 * the input; see preview.ts.
 */
export function diffLines(beforeText: string, afterText: string): DiffRow[] {
	const before = splitLines(beforeText);
	const after = splitLines(afterText);
	const rows: DiffRow[] = [];
	let beforeIndex = 0;
	let afterIndex = 0;

	for (const op of lcsOps(before, after)) {
		if (op === 'insert') {
			rows.push({ op, text: after[afterIndex] ?? '' });
			afterIndex += 1;
			continue;
		}
		rows.push({ op, text: before[beforeIndex] ?? '' });
		beforeIndex += 1;
		if (op === 'equal') {
			afterIndex += 1;
		}
	}
	return rows;
}
```

Tests in `merge.test.ts`: identical input yields all-`equal`; a pure append yields trailing `insert`s; a pure deletion yields `delete`s; a replaced line yields one `delete` and one `insert`; empty-to-nonempty and nonempty-to-empty both terminate.

- [x] **Step 4: Verify**

Run: `pnpm lint && pnpm --filter @obsidian-sync/plugin typecheck && pnpm test`
Expected: all pass, including the untouched `merge.test.ts` and `engine.test.ts` cases — the extraction must be behaviour-preserving.

---

## Task 6: The preview model

Pure, synchronous, no Obsidian, no network: the modal renders whatever this returns.

**Files:**
- Create: `packages/plugin/src/engine/preview.ts`
- Create: `packages/plugin/src/engine/preview.test.ts`

**Interfaces:**
- Produces: `previewMaxLines`, `previewMaxBytes`, `type VersionPreview`, `buildPreview(path, current, version): VersionPreview`.

- [x] **Step 1: Write the failing test**

`packages/plugin/src/engine/preview.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import { textToBytes } from '../crypto/encoding.js';
import { buildPreview, previewMaxLines } from './preview.js';

describe('buildPreview', () => {
	test('reports identical content without diffing', () => {
		const bytes = textToBytes('one\ntwo\n');
		expect(buildPreview('note.md', bytes, bytes).kind).toBe('identical');
	});

	test('diffs a text file and counts the change', () => {
		const preview = buildPreview(
			'note.md',
			textToBytes('one\ntwo\n'),
			textToBytes('one\ntwo\nthree\n'),
		);
		expect(preview.kind).toBe('diff');
		if (preview.kind === 'diff') {
			expect(preview.added).toBe(1);
			expect(preview.removed).toBe(0);
		}
	});

	test('refuses to diff a binary path', () => {
		const preview = buildPreview('image.png', new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]));
		expect(preview.kind).toBe('binary');
	});

	test('refuses to diff beyond the line cap', () => {
		const big = textToBytes(`${'line\n'.repeat(previewMaxLines + 1)}`);
		const preview = buildPreview('note.md', big, textToBytes('line\n'));
		expect(preview.kind).toBe('tooLarge');
	});

	test('treats a missing local file as an all-insert diff', () => {
		const preview = buildPreview('note.md', undefined, textToBytes('one\ntwo\n'));
		expect(preview.kind).toBe('diff');
		if (preview.kind === 'diff') {
			expect(preview.removed).toBe(0);
			expect(preview.added).toBeGreaterThan(0);
		}
	});
});
```

Run: `pnpm test -- preview.test`
Expected: fails, module absent.

- [x] **Step 2: Implement**

`packages/plugin/src/engine/preview.ts`:

```typescript
import { bytesToText } from '../crypto/encoding.js';
import { type DiffRow, diffLines } from './merge.js';
import { isTextPath } from './text.js';

/**
 * The LCS table in merge.ts is `(lines + 1)²` numbers: at 2000 lines a side that is
 * ~4M cells, roughly 16–32 MB in V8, which a phone survives once, on demand. An
 * order of magnitude more lines is 400M cells and kills the renderer, so the preview
 * declines rather than trying. Restore itself is unaffected — only the diff is capped.
 */
export const previewMaxLines = 2000;
export const previewMaxBytes = 1024 * 1024;

export type VersionPreview =
	| { kind: 'identical' }
	| { kind: 'diff'; rows: DiffRow[]; added: number; removed: number }
	| { kind: 'binary'; currentBytes: number | undefined; versionBytes: number }
	| {
			kind: 'tooLarge';
			reason: 'bytes' | 'lines';
			currentBytes: number | undefined;
			versionBytes: number;
	  };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	return left.every((byte, index) => byte === right[index]);
}

function countLines(text: string): number {
	let lines = 1;
	for (const character of text) {
		if (character === '\n') {
			lines += 1;
		}
	}
	return lines;
}

/**
 * What to show for one historical version against what is on disk now.
 * `current` is undefined when the file no longer exists locally.
 */
export function buildPreview(
	path: string,
	current: Uint8Array | undefined,
	version: Uint8Array,
): VersionPreview {
	const currentBytes = current?.byteLength;

	if (current !== undefined && sameBytes(current, version)) {
		return { kind: 'identical' };
	}
	if (!isTextPath(path)) {
		return { kind: 'binary', currentBytes, versionBytes: version.byteLength };
	}
	if ((currentBytes ?? 0) > previewMaxBytes || version.byteLength > previewMaxBytes) {
		return { kind: 'tooLarge', reason: 'bytes', currentBytes, versionBytes: version.byteLength };
	}

	const currentText = current === undefined ? '' : bytesToText(current);
	const versionText = bytesToText(version);
	if (countLines(currentText) > previewMaxLines || countLines(versionText) > previewMaxLines) {
		return { kind: 'tooLarge', reason: 'lines', currentBytes, versionBytes: version.byteLength };
	}

	const rows = diffLines(currentText, versionText);
	return {
		kind: 'diff',
		rows,
		added: rows.filter((row) => row.op === 'insert').length,
		removed: rows.filter((row) => row.op === 'delete').length,
	};
}
```

The diff direction is deliberate: **current → version**, so `insert` rows are what restoring would add and `delete` rows are what it would remove. The modal labels them that way.

- [x] **Step 3: Verify**

Run: `pnpm test -- preview.test`
Expected: passes.

---

## Task 7: `VersionHistoryService` — list, read, restore

The whole feature's logic, with no `obsidian` import, so it is testable against `FakeServer` with real crypto in the same way `engine.test.ts` tests the sync engine.

**Files:**
- Create: `packages/plugin/src/engine/history.ts`
- Create: `packages/plugin/src/engine/history.test.ts`

**Interfaces:**
- Consumes: `ApiClient`, `PurposeKeys`, `VaultAdapter`, `FileIndex`, `decodeFile`, `decryptFileMeta`, `computeFileId`, `uniqueCopyPath`.
- Produces:
  - `interface HistoryEntry`, `interface HistoryPage`, `type RestoreOutcome`
  - `class VersionContentUnavailableError extends Error`
  - `class VersionUnreadableError extends Error`
  - `class VersionHistoryService` with `list`, `read`, `restore`, `restoreAsCopy`

- [x] **Step 1: Write the failing test**

`packages/plugin/src/engine/history.test.ts` — reuse the `makeDevice` harness shape from `engine.test.ts` (FakeServer, `derivePurposeKeys`, `MemoryVault`, `MemoryStorage`):

```typescript
describe('VersionHistoryService', () => {
	test('lists versions newest first, labelled with the committing device', async () => {
		const device = await makeDevice('device-1', 'Studio Mac');
		await device.vault.write('note.md', textToBytes('one\n'));
		await device.engine.pushAll();
		await device.vault.write('note.md', textToBytes('one\ntwo\n'));
		await device.engine.pushAll();

		const page = await device.history.list('note.md');

		expect(page.entries).toHaveLength(2);
		expect(page.entries[0]?.isCurrent).toBe(true);
		expect(page.entries[0]?.deviceLabel).toBe('Studio Mac');
		expect(page.entries[1]?.parentVersion).toBeUndefined();
		expect(page.path).toBe('note.md');
	});

	test('reads a historical version back to its exact bytes', async () => {
		const device = await makeDevice('device-1', 'Studio Mac');
		await device.vault.write('note.md', textToBytes('one\n'));
		await device.engine.pushAll();
		await device.vault.write('note.md', textToBytes('one\ntwo\n'));
		await device.engine.pushAll();

		const page = await device.history.list('note.md');
		const oldest = page.entries[1];
		if (oldest === undefined) {
			throw new Error('expected two versions');
		}

		expect(bytesToText(await device.history.read(page.fileId, oldest))).toBe('one\n');
	});

	test('restore writes the old bytes and commits them as a new head version', async () => {
		const device = await makeDevice('device-1', 'Studio Mac');
		await device.vault.write('note.md', textToBytes('one\n'));
		await device.engine.pushAll();
		await device.vault.write('note.md', textToBytes('one\ntwo\n'));
		await device.engine.pushAll();

		const page = await device.history.list('note.md');
		const oldest = page.entries[1];
		if (oldest === undefined) {
			throw new Error('expected two versions');
		}
		const headBefore = server.headOf(page.fileId);

		const outcome = await device.history.restore({
			path: 'note.md',
			fileId: page.fileId,
			entry: oldest,
		});

		expect(outcome.status).toBe('restored');
		expect(bytesToText(await device.vault.read('note.md'))).toBe('one\n');

		// A new version, not a rewind: the old head is still the parent of the new one,
		// and the restored version id is not the one that was restored from.
		const headAfter = server.headOf(page.fileId);
		expect(headAfter).not.toBe(headBefore);
		expect(headAfter).not.toBe(oldest.versionId);
		expect((await device.history.list('note.md')).entries).toHaveLength(3);
	});

	test('restoring the version already on disk changes nothing', async () => {
		const device = await makeDevice('device-1', 'Studio Mac');
		await device.vault.write('note.md', textToBytes('one\n'));
		await device.engine.pushAll();

		const page = await device.history.list('note.md');
		const only = page.entries[0];
		if (only === undefined) {
			throw new Error('expected one version');
		}

		expect((await device.history.restore({ path: 'note.md', fileId: page.fileId, entry: only })).status).toBe(
			'unchanged',
		);
		expect((await device.history.list('note.md')).entries).toHaveLength(1);
	});

	test('restore as a copy leaves the live note untouched', async () => {
		const device = await makeDevice('device-1', 'Studio Mac');
		await device.vault.write('note.md', textToBytes('one\n'));
		await device.engine.pushAll();
		await device.vault.write('note.md', textToBytes('rewritten\n'));
		await device.engine.pushAll();

		const page = await device.history.list('note.md');
		const oldest = page.entries[1];
		if (oldest === undefined) {
			throw new Error('expected two versions');
		}

		const copy = await device.history.restoreAsCopy({
			path: 'note.md',
			fileId: page.fileId,
			entry: oldest,
		});

		expect(bytesToText(await device.vault.read('note.md'))).toBe('rewritten\n');
		expect(bytesToText(await device.vault.read(copy.copyPath))).toBe('one\n');
		expect(copy.copyPath).toMatch(/^note \(restored .+\)\.md$/);
	});

	test('lists history for a file the local index has forgotten', async () => {
		const device = await makeDevice('device-1', 'Studio Mac');
		await device.vault.write('note.md', textToBytes('one\n'));
		await device.engine.pushAll();
		device.index.delete('note.md');

		// fileId is derived from the path, so history survives a lost index entry.
		const page = await device.history.list('note.md');

		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]?.isCurrent).toBe(false);
	});

	test('surfaces a pruned version as unavailable rather than a raw 404', async () => {
		const device = await makeDevice('device-1', 'Studio Mac');
		await device.vault.write('note.md', textToBytes('one\n'));
		await device.engine.pushAll();

		const page = await device.history.list('note.md');
		const only = page.entries[0];
		if (only === undefined) {
			throw new Error('expected one version');
		}
		server.blobs.clear();

		await expect(device.history.read(page.fileId, only)).rejects.toBeInstanceOf(
			VersionContentUnavailableError,
		);
	});

	test('marks a version whose meta will not decrypt as unreadable', async () => {
		const device = await makeDevice('device-1', 'Studio Mac');
		await device.vault.write('note.md', textToBytes('one\n'));
		await device.engine.pushAll();

		const fileId = await computeFileId(keys.nameMacKey, 'note.md');
		const stored = [...server.versions.values()].find((version) => version.fileId === fileId);
		if (stored === undefined) {
			throw new Error('expected a stored version');
		}
		stored.metaBlob = Buffer.from('not a meta envelope').toString('base64');

		const page = await device.history.list('note.md');

		expect(page.entries[0]?.readable).toBe(false);
		await expect(
			device.history.restore({ path: 'note.md', fileId, entry: page.entries[0] as HistoryEntry }),
		).rejects.toBeInstanceOf(VersionUnreadableError);
	});
});
```

`makeDevice` grows a second parameter for the label and returns `history: new VersionHistoryService({...})` alongside the engine, sharing the same `client`, `keys`, `vault` and `index`, with `requestSync: () => device.engine.pushAll()`.

Run: `pnpm test -- history.test`
Expected: fails, module absent.

- [x] **Step 2: Implement**

`packages/plugin/src/engine/history.ts`:

```typescript
import type { VersionSummary } from '@obsidian-sync/protocol';
import { computeFileId } from '../crypto/identity.js';
import type { PurposeKeys } from '../crypto/keys.js';
import { decryptFileMeta } from '../crypto/meta.js';
import type { FileIndex } from '../state/file-index.js';
import type { ApiClient } from '../transport/client.js';
import { decodeFile } from './codec.js';
import { copyStamp, uniqueCopyPath } from './copy.js';
import type { VaultAdapter } from './vault.js';

/** A version whose chunks are no longer on the server: retention drift, or a swept blob. */
export class VersionContentUnavailableError extends Error {
	constructor(versionId: string) {
		super(`the content of version ${versionId} is no longer stored on the server`);
		this.name = 'VersionContentUnavailableError';
	}
}

/** A version whose meta envelope will not decrypt under the current passphrase. */
export class VersionUnreadableError extends Error {
	constructor(versionId: string) {
		super(`version ${versionId} cannot be decrypted with the current passphrase`);
		this.name = 'VersionUnreadableError';
	}
}

export interface HistoryEntry extends VersionSummary {
	/** From the encrypted meta; undefined on versions committed before labels existed. */
	deviceLabel: string | undefined;
	/** False when the meta envelope did not decrypt; such a version cannot be restored. */
	readable: boolean;
	/** The version this device's index last reconciled with. */
	isCurrent: boolean;
	isLocalDevice: boolean;
}

export interface HistoryPage {
	fileId: string;
	path: string;
	entries: HistoryEntry[];
	hasMore: boolean;
}

export interface RestoreRequest {
	path: string;
	fileId: string;
	entry: HistoryEntry;
}

export type RestoreOutcome = { status: 'restored' } | { status: 'unchanged' };

export interface VersionHistoryDeps {
	vaultId: string;
	client: ApiClient;
	keys: PurposeKeys;
	vault: VaultAdapter;
	index: FileIndex;
	deviceId: string;
	/** Pushes the restored bytes; injected so the service never owns the sync loop. */
	requestSync: () => Promise<void>;
}

const defaultPageSize = 50;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	return left.every((byte, index) => byte === right[index]);
}

/**
 * Version history and restore (§6.3.5).
 *
 * Restore deliberately goes through the vault and the ordinary push, never straight
 * to the server: that is what makes a restore a new version committed against the
 * current head, and what lets it inherit stale-write detection, merge, and the
 * offline path instead of reimplementing them.
 */
export class VersionHistoryService {
	readonly #deps: VersionHistoryDeps;

	constructor(deps: VersionHistoryDeps) {
		this.#deps = deps;
	}

	async list(path: string, window?: { limit?: number; offset?: number }): Promise<HistoryPage> {
		const { client, vaultId, index, keys, deviceId } = this.#deps;
		// The index is a cache, not the identity: fileId is derived from the path, so
		// history is still reachable for a file whose index entry was lost or never made.
		const fileId = index.get(path)?.fileId ?? (await computeFileId(keys.nameMacKey, path));
		const currentVersion = index.get(path)?.versionId;

		const response = await client.versions(vaultId, fileId, {
			limit: window?.limit ?? defaultPageSize,
			offset: window?.offset ?? 0,
		});

		const entries: HistoryEntry[] = [];
		for (const version of response.versions) {
			const label = await this.#readLabel(fileId, version.metaBlob);
			entries.push({
				...version,
				deviceLabel: label.deviceLabel,
				readable: label.readable,
				isCurrent: version.versionId === currentVersion,
				isLocalDevice: version.deviceId === deviceId,
			});
		}

		return { fileId, path, entries, hasMore: response.hasMore };
	}

	async #readLabel(
		fileId: string,
		metaBlob: string,
	): Promise<{ deviceLabel: string | undefined; readable: boolean }> {
		try {
			const meta = await decryptFileMeta(this.#deps.keys.contentCryptoKey, fileId, metaBlob);
			return { deviceLabel: meta.deviceLabel, readable: true };
		} catch {
			// A version committed under a different passphrase, or a tampered blob. It is
			// listed rather than hidden, so the user sees that the gap in history is real.
			return { deviceLabel: undefined, readable: false };
		}
	}

	/** The plaintext bytes of one version, integrity-checked chunk by chunk. */
	async read(fileId: string, entry: HistoryEntry): Promise<Uint8Array> {
		if (!entry.readable) {
			throw new VersionUnreadableError(entry.versionId);
		}
		const { client, vaultId, keys } = this.#deps;
		try {
			const decoded = await decodeFile(keys, fileId, entry.metaBlob, (address) =>
				client.getBlob(vaultId, address),
			);
			return decoded.data;
		} catch (error) {
			// Retention deletes a version row and releases its chunk refcounts in the same
			// transaction, so a listed version normally still has every blob. A miss here
			// means refcount drift or an interrupted sweep — real, but not the user's fault.
			if (error instanceof Error && error.name === 'ServerError') {
				throw new VersionContentUnavailableError(entry.versionId);
			}
			throw error;
		}
	}

	/**
	 * Write the version's bytes back over the live file and let the next push commit
	 * them as a new version parented on the current head (§6.3.5: never rewrite history).
	 */
	async restore(request: RestoreRequest): Promise<RestoreOutcome> {
		const { vault } = this.#deps;
		const bytes = await this.read(request.fileId, request.entry);
		const present = await vault.exists(request.path);
		const current = present ? await vault.read(request.path) : undefined;

		if (current !== undefined && sameBytes(current, bytes)) {
			return { status: 'unchanged' };
		}

		// `expected` is the same compare-and-set the pull path uses: a keystroke landing
		// between the read above and this write raises StaleWriteError instead of
		// silently discarding it. The caller reports that and the user retries.
		await vault.write(request.path, bytes, { mtime: Date.now(), expected: current });
		await this.#deps.requestSync();
		return { status: 'restored' };
	}

	/** Write the version alongside the live file instead of over it. */
	async restoreAsCopy(request: RestoreRequest): Promise<{ copyPath: string }> {
		const { vault } = this.#deps;
		const bytes = await this.read(request.fileId, request.entry);
		const copyPath = await uniqueCopyPath(
			(candidate) => vault.exists(candidate),
			request.path,
			`restored ${copyStamp(request.entry.createdAt)}`,
		);
		await vault.write(copyPath, bytes);
		await this.#deps.requestSync();
		return { copyPath };
	}
}
```

Note the copy marker uses the **version's** `createdAt`, not the current time: `Note (restored 2026-09-04-11-02-19).md` says which version it came from, which is the question the user will ask a week later.

- [x] **Step 3: Verify**

Run: `pnpm lint && pnpm --filter @obsidian-sync/plugin typecheck && pnpm test`
Expected: all pass.

---

## Task 8: The modal, the command and the file menu

The view layer. Like `settings-tab.ts` and `status-view.ts` it carries no tests: the vitest environment is `node` and `testing/obsidian-stub.ts` has no `Modal`. All logic it could get wrong already lives in Tasks 6 and 7, which are tested. Keep it that way — no decisions in this file.

**Files:**
- Create: `packages/plugin/src/obsidian/version-history-modal.ts`
- Modify: `packages/plugin/src/main.ts`
- Modify: `packages/plugin/styles.css`

**Interfaces:**
- Produces: `class VersionHistoryModal extends Modal`; `SyncPlugin.openVersionHistory(path: string): Promise<void>`.

- [x] **Step 1: The modal**

`packages/plugin/src/obsidian/version-history-modal.ts`:

```typescript
import { type App, Modal, Notice, Platform } from 'obsidian';
import type { HistoryEntry, HistoryPage, VersionHistoryService } from '../engine/history.js';
import { VersionContentUnavailableError, VersionUnreadableError } from '../engine/history.js';
import { buildPreview, type VersionPreview } from '../engine/preview.js';
import { StaleWriteError } from '../engine/vault.js';
import { relativeTime } from './status-display.js';

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeDevice(entry: HistoryEntry): string {
	if (entry.deviceLabel !== undefined && entry.deviceLabel !== '') {
		return entry.deviceLabel;
	}
	// Versions committed before device labels existed, and versions from a device that
	// never set one: the id prefix is still enough to tell two devices apart.
	return entry.isLocalDevice ? 'This device' : `Device ${entry.deviceId.slice(0, 6)}`;
}

/**
 * Per-note version history (§6.3.5). Lists versions, previews the diff between the
 * selected version and what is on disk, and restores — always as a new version.
 */
export class VersionHistoryModal extends Modal {
	readonly #history: VersionHistoryService;
	readonly #path: string;
	#page: HistoryPage | undefined;
	#selected: HistoryEntry | undefined;
	#selectedBytes: Uint8Array | undefined;
	#listEl: HTMLElement | undefined;
	#detailEl: HTMLElement | undefined;

	constructor(app: App, history: VersionHistoryService, path: string) {
		super(app);
		this.#history = history;
		this.#path = path;
	}

	override async onOpen(): Promise<void> {
		this.modalEl.addClass('obsidian-sync-history');
		this.modalEl.toggleClass('obsidian-sync-history--stacked', Platform.isPhone);
		this.titleEl.setText(`Version history — ${this.#path}`);

		const body = this.contentEl.createDiv({ cls: 'obsidian-sync-history__body' });
		this.#listEl = body.createDiv({ cls: 'obsidian-sync-history__list' });
		this.#detailEl = body.createDiv({ cls: 'obsidian-sync-history__detail' });
		this.#listEl.createDiv({ text: 'Loading…' });

		// fileId is derived from the path, so a rename starts a new chain (decision D4).
		this.contentEl.createDiv({
			cls: 'obsidian-sync-history__footnote',
			text: 'History follows the path. Renaming a note starts a new history.',
		});

		await this.#reload(0);
	}

	async #reload(offset: number): Promise<void> {
		const list = this.#listEl;
		if (list === undefined) {
			return;
		}
		try {
			const page = await this.#history.list(this.#path, { offset });
			this.#page =
				this.#page === undefined || offset === 0
					? page
					: { ...page, entries: [...this.#page.entries, ...page.entries] };
		} catch (error) {
			list.empty();
			list.createDiv({ text: `Could not load history: ${(error as Error).message}` });
			return;
		}
		this.#renderList();
	}

	#renderList(): void {
		const list = this.#listEl;
		const page = this.#page;
		if (list === undefined || page === undefined) {
			return;
		}
		list.empty();

		if (page.entries.length === 0) {
			list.createDiv({ text: 'This note has no synced versions yet.' });
			return;
		}

		for (const entry of page.entries) {
			const row = list.createEl('button', { cls: 'obsidian-sync-history__row' });
			row.toggleClass('is-active', entry.versionId === this.#selected?.versionId);
			row.createDiv({
				cls: 'obsidian-sync-history__when',
				text: `${new Date(entry.createdAt).toLocaleString()} · ${relativeTime(entry.createdAt)}`,
			});
			row.createDiv({
				cls: 'obsidian-sync-history__meta',
				text: `${describeDevice(entry)} · ${formatBytes(entry.size)}`,
			});
			if (entry.isCurrent) {
				row.createSpan({ cls: 'obsidian-sync-history__badge', text: 'Current' });
			}
			if (!entry.readable) {
				row.createSpan({ cls: 'obsidian-sync-history__badge is-error', text: 'Unreadable' });
			}
			row.addEventListener('click', () => void this.#select(entry));
		}

		if (page.hasMore) {
			list
				.createEl('button', { cls: 'obsidian-sync-history__more', text: 'Load older versions' })
				.addEventListener('click', () => void this.#reload(page.entries.length));
		}
	}

	async #select(entry: HistoryEntry): Promise<void> {
		const detail = this.#detailEl;
		const page = this.#page;
		if (detail === undefined || page === undefined) {
			return;
		}
		this.#selected = entry;
		this.#selectedBytes = undefined;
		this.#renderList();
		detail.empty();
		detail.createDiv({ text: 'Loading version…' });

		try {
			this.#selectedBytes = await this.#history.read(page.fileId, entry);
		} catch (error) {
			detail.empty();
			detail.createDiv({ cls: 'obsidian-sync-history__error', text: this.#explain(error) });
			return;
		}

		const current = (await this.app.vault.adapter.exists(this.#path))
			? new Uint8Array(await this.app.vault.adapter.readBinary(this.#path))
			: undefined;
		this.#renderDetail(buildPreview(this.#path, current, this.#selectedBytes));
	}

	#renderDetail(preview: VersionPreview): void {
		const detail = this.#detailEl;
		const entry = this.#selected;
		if (detail === undefined || entry === undefined) {
			return;
		}
		detail.empty();

		const summary = detail.createDiv({ cls: 'obsidian-sync-history__summary' });
		switch (preview.kind) {
			case 'identical': {
				summary.setText('This version is identical to the note on disk.');
				break;
			}
			case 'binary': {
				summary.setText(
					`Binary file — no preview. ${formatBytes(preview.versionBytes)} in this version.`,
				);
				break;
			}
			case 'tooLarge': {
				summary.setText(
					preview.reason === 'lines'
						? 'Too many lines to diff. Restore to a copy and compare in the editor.'
						: 'Too large to diff. Restore to a copy and compare in the editor.',
				);
				break;
			}
			case 'diff': {
				summary.setText(`Restoring would add ${preview.added} and remove ${preview.removed} line(s).`);
				const rows = detail.createDiv({ cls: 'obsidian-sync-history__diff' });
				for (const row of preview.rows) {
					const marker = row.op === 'insert' ? '+' : row.op === 'delete' ? '-' : ' ';
					rows.createDiv({
						cls: `obsidian-sync-history__line is-${row.op}`,
						text: `${marker} ${row.text}`,
					});
				}
				break;
			}
		}

		const actions = detail.createDiv({ cls: 'obsidian-sync-history__actions' });
		const restore = actions.createEl('button', { cls: 'mod-cta', text: 'Restore this version' });
		restore.disabled = !entry.readable || preview.kind === 'identical';
		restore.addEventListener('click', () => void this.#restore(false));
		const copy = actions.createEl('button', { text: 'Restore to a copy' });
		copy.disabled = !entry.readable;
		copy.addEventListener('click', () => void this.#restore(true));
	}

	async #restore(asCopy: boolean): Promise<void> {
		const page = this.#page;
		const entry = this.#selected;
		if (page === undefined || entry === undefined) {
			return;
		}
		const request = { path: this.#path, fileId: page.fileId, entry };
		try {
			if (asCopy) {
				const { copyPath } = await this.#history.restoreAsCopy(request);
				new Notice(`Restored to ${copyPath}.`);
			} else {
				const outcome = await this.#history.restore(request);
				new Notice(
					outcome.status === 'unchanged'
						? 'That version is already what is on disk.'
						: `Restored ${this.#path} as a new version.`,
				);
			}
			this.close();
		} catch (error) {
			new Notice(this.#explain(error));
		}
	}

	#explain(error: unknown): string {
		if (error instanceof VersionContentUnavailableError) {
			return 'That version’s content is no longer stored on the server.';
		}
		if (error instanceof VersionUnreadableError) {
			return 'That version cannot be decrypted with the current passphrase.';
		}
		if (error instanceof StaleWriteError) {
			return 'The note changed while restoring. Try again.';
		}
		return `Restore failed: ${(error as Error).message}`;
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
```

- [x] **Step 2: Wire the plugin**

In `packages/plugin/src/main.ts`:

- add `#history: VersionHistoryService | null = null;`
- build it in `#buildEngine`, after the engine, reusing the same `client`, `keys`, vault adapter, `index` and `deviceId`:

```typescript
		this.#history = new VersionHistoryService({
			vaultId: vault.id,
			client,
			keys: this.#keys,
			vault: createVaultAdapter(this.app),
			index,
			deviceId,
			requestSync: () => this.requestSync(),
		});
```

- clear it in `#stopEngine()` alongside `#engine`;
- add the opener:

```typescript
	async openVersionHistory(path: string): Promise<void> {
		if (this.#history === null) {
			new Notice('Obsidian Sync: start sync before opening version history.');
			return;
		}
		new VersionHistoryModal(this.app, this.#history, path).open();
	}
```

- register the command in `#registerCommands()` (spec §6.3.7 names it exactly this):

```typescript
		this.addCommand({
			id: 'version-history',
			name: 'Show version history for current file',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file === null) {
					return false;
				}
				if (!checking) {
					void this.openVersionHistory(file.path);
				}
				return true;
			},
		});
```

- register the file-menu entry in `onload()`, after `#registerCommands()`:

```typescript
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile)) {
					return;
				}
				menu.addItem((item) =>
					item
						.setTitle('Sync version history')
						.setIcon('history')
						.onClick(() => void this.openVersionHistory(file.path)),
				);
			}),
		);
```

`TFile` is a new import from `obsidian`.

- [x] **Step 3: Styles**

Append to `packages/plugin/styles.css`, following the existing BEM-ish naming and Obsidian CSS variables:

```css
.obsidian-sync-history__body {
	display: flex;
	gap: 12px;
	min-height: 320px;
	max-height: 60vh;
}

.obsidian-sync-history__list {
	flex: 0 0 240px;
	overflow-y: auto;
	border-right: 1px solid var(--background-modifier-border);
	padding-right: 8px;
}

.obsidian-sync-history__row {
	display: block;
	width: 100%;
	text-align: left;
	background: transparent;
	border: none;
	padding: 6px 8px;
	border-radius: var(--radius-s);
	cursor: pointer;
}

.obsidian-sync-history__row:hover,
.obsidian-sync-history__row.is-active {
	background: var(--background-modifier-hover);
}

.obsidian-sync-history__meta,
.obsidian-sync-history__footnote {
	color: var(--text-muted);
	font-size: var(--font-ui-smaller);
}

.obsidian-sync-history__badge {
	font-size: var(--font-ui-smaller);
	color: var(--text-accent);
}

.obsidian-sync-history__badge.is-error {
	color: var(--text-error);
}

.obsidian-sync-history__detail {
	flex: 1 1 auto;
	overflow-y: auto;
}

.obsidian-sync-history__diff {
	font-family: var(--font-monospace);
	font-size: var(--font-ui-smaller);
	white-space: pre-wrap;
	margin-top: 8px;
}

.obsidian-sync-history__line.is-insert {
	background: rgba(var(--color-green-rgb), 0.15);
}

.obsidian-sync-history__line.is-delete {
	background: rgba(var(--color-red-rgb), 0.15);
}

.obsidian-sync-history__error {
	color: var(--text-error);
}

.obsidian-sync-history__actions {
	display: flex;
	gap: 8px;
	margin-top: 12px;
	flex-wrap: wrap;
}

/* Phones have no room for two columns; the list scrolls above the diff (§6.3.6). */
.obsidian-sync-history--stacked .obsidian-sync-history__body {
	flex-direction: column;
	max-height: 75vh;
}

.obsidian-sync-history--stacked .obsidian-sync-history__list {
	flex: 0 0 auto;
	max-height: 30vh;
	border-right: none;
	border-bottom: 1px solid var(--background-modifier-border);
	padding-right: 0;
}
```

- [ ] **Step 4: Verify by hand in a real vault**

Run: `pnpm lint && pnpm --filter @obsidian-sync/plugin typecheck && pnpm test && node packages/plugin/esbuild.config.mjs`

Then, in a vault symlinked to `packages/plugin`, with sync configured:

- Edit a note three times, letting each sync. Open the command palette → *Show version history for current file*. Three versions, newest first, each labelled with the device name from settings.
- **Disable and re-enable the plugin is not enough to load a new `main.js` — restart Obsidian.** (Toggling keeps the old bundle in memory.)
- Right-click the note in the file explorer: *Sync version history* appears **with its icon rendered**. A wrong Lucide id fails silently and leaves a blank space, so check the glyph, not just the label.
- Select the oldest version: the diff shows the later edits as removals.
- *Restore this version*: the editor content changes, the status bar syncs, and reopening history shows a **fourth** version — never three.
- *Restore to a copy* on the second device instead: a `(restored …)` sidecar appears and the live note is untouched.
- Open history for an attachment (a PNG): the preview says binary, restore still works.

---

## Task 9: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/2026-09-10-obsidian-sync-design.md`

- [x] **Step 1: README**

Remove *Version history and restore UI (the server API exists; the plugin does not call it).* from **Not yet implemented**. Add to the feature list a line describing what actually shipped, including the two limits users will hit:

> Version history per note, with a diff preview and restore. Restoring commits a new version rather than rewriting history. History follows the path, so a rename starts a new chain; how far back it goes is set by the server's `VERSION_RETENTION_DAYS` and `VERSION_RETENTION_MIN`.

If Task 10 does not ship, add to **Not yet implemented**:

> Restoring a deleted note. Version rows survive a delete on the server, but no endpoint lists tombstones, so no device can name a deleted file to restore it.

- [x] **Step 2: Spec**

Two edits to `docs/specs/2026-09-10-obsidian-sync-design.md`:

- §5.5, the API table: annotate the versions row with the response shape and the window, since `metaBlob` in the list is the load-bearing change this plan makes:

  | `GET` | `/v1/vaults/:v/files/:fileId/versions?limit&offset` | Version history, newest first; each entry carries the version's `meta_blob`. |

- The decision log: append **D6 — The version list carries the encrypted meta, and the device label rides inside it**, recording H1 and H2 and the rejected alternatives (a per-version detail endpoint; a `device_label` column). Follow the existing D1–D5 format: decision, alternative, why the alternative loses, what it costs.

- [x] **Step 3: Verify**

Run: `pnpm lint`
Expected: passes. Re-read the README section end to end — it must not still claim the plugin never calls the versions API.

---

## Task 10 (optional): Restoring a deleted note

Ship separately. Nothing above depends on it.

The problem is identity, not UI: `#applyRemoteDelete` drops the index entry and `GET /state` skips tombstones, so after a delete propagates no device can name the `fileId`. A local "recently deleted" journal would fix it only on devices that were online for the delete, and not at all on a freshly paired one, so the list belongs on the server.

**Sketch:**

- Server: `GET /v1/vaults/:vaultId/deleted?limit&offset` → `{ files: [{ fileId, metaBlob, size, deletedSeq }], hasMore }`, reading `file WHERE deleted = 1` joined to that file's newest surviving `version` row. The `metaBlob` is what lets the client decrypt the path — the server still names nothing.
- Protocol: `DeletedFileSummary`, `DeletedFilesResponse`.
- Plugin: `VersionHistoryService.listDeleted()` decrypts each path; a *Restore a deleted note* command opens a `SuggestModal` over them; choosing one opens the existing history modal at that path, where restore already works — writing the bytes to a path that no longer exists is a plain create, and the ordinary push commits it with `parentVersion: undefined`, which is exactly right because the server's `currentHead()` reads a tombstone as absent.
- Retention interaction: a tombstoned file whose versions have all been pruned must not be listed. The join drops it automatically.

---

## Task 11 (optional): Make the version-history settings honest

`PluginSettings.retentionDays` exists, defaults to 90, is rendered nowhere, and could not work if it were: retention is enforced by the server from `VERSION_RETENTION_DAYS` / `VERSION_RETENTION_MIN`, and no endpoint lets a client set them. Spec §6.3.1 also lists a *Show storage usage* action with no endpoint behind it.

Two honest options, in preference order:

1. **Delete `retentionDays` from `PluginSettings`** and leave a settings note stating that retention is a server setting. Smallest change; nothing can mislead.
2. Add `GET /v1/vaults/:vaultId/usage` → `{ files, versions, bytes, retentionDays, retentionMin }` and render it read-only under a *Version history* heading, which also satisfies *Show storage usage*.

Do not build a writable retention control. It would need a per-vault retention column and an admin surface neither the spec nor the threat model has.

---

## Verification Checklist

Run before declaring this plan complete:

- [x] `pnpm lint && pnpm build && pnpm typecheck && pnpm test` all pass from a clean clone.
- [x] `GET .../versions` returns `metaBlob` on every entry, clamps `limit` to 200, and 400s a non-hex `fileId` (covered by `routes/files.test.ts`).
- [x] Versions committed in the same millisecond come back newest-first from both the real server and `FakeServer` (covered by `files.test.ts` and exercised by `history.test.ts`).
- [x] The server source still contains no code path that decodes `meta_blob` or a chunk body — `grep -rn 'decrypt\|meta_blob' packages/server/src` shows storage and transport only.
- [x] A restore produces a **new** version whose parent is the previous head; the restored-from version is untouched and still listed (covered by `history.test.ts`).
- [x] Restoring the version already on disk is a no-op that commits nothing.
- [x] A version whose blobs are gone raises `VersionContentUnavailableError`, and a version whose meta will not decrypt is listed as unreadable and refuses to restore.
- [x] The diff preview declines above 2000 lines or 1 MiB instead of allocating the LCS table.
- [ ] Manual pass in a real vault (Task 8, Step 4) — including the file-menu **icon actually rendering** and an Obsidian restart rather than a plugin toggle.
- [ ] Two devices: restore on device A, and device B pulls the restored bytes as an ordinary version with no conflict copy.

---

## Plan Self-Review

**Spec coverage.**

| Spec section | Task |
|---|---|
| §5.5 API surface — versions endpoint | 1, 2, 9 |
| §6.3.5 version history modal | 6, 7, 8 |
| §6.3.6 stacked diff on phones | 8 |
| §6.3.7 *Show version history for current file* | 8 |
| §4.2 / D4 path-derived identity and renames | 7 (list falls back to `computeFileId`), 8 (footnote) |
| §4.4 / D5 meta-authenticated chunk order | 7 (`decodeFile` integrity check on every restore) |
| §6.3.1 *Show storage usage* | 11 (optional) |

**Corrections made while planning.**

1. **The README's claim is wrong in a way that matters.** "The server API exists; the plugin does not call it" implies a UI-only task. The endpoint cannot serve version history as specified: it returns no `metaBlob`, so no client can render or restore a version, and no device name can be shown. Tasks 1–4 are server and protocol work, not plumbing.
2. **`listVersions` was unbounded.** Left alone, opening history on a heavily edited note would have pulled every row for that file in one response. Task 2 caps it.
3. **`FakeServer` would have lied about ordering.** Its `Map` insertion order stable-sorted by `createdAt` tiebreaks *ascending*; the real server tiebreaks on `rowid DESC`. Versions committed within one millisecond — which a scripted restore or a rebuild produces — would have listed in opposite orders, and the test suite would have certified the wrong one. Task 3 adds an explicit ordinal.

**Deliberate non-goals.**

- **Restoring a deleted note** (Task 10) — a server-side tombstone listing, separable.
- **`merge3`'s own quadratic LCS** on the sync path. Task 6 caps the *preview* only. A 20000-line note that conflicts will still allocate a 400M-cell table inside `merge3` today; that is a pre-existing sync-path risk, out of scope here, and worth its own plan.
- **Diffing two historical versions against each other.** §6.3.5 specifies "the diff between any version and the current file". `buildPreview` takes two byte arrays and does not care where they came from, so adding it later is a UI change only.
- **Conflict resolution modal** (§6.3.6) — a separate README item with its own plan.

**Risk notes.**

- `encodeFile`'s signature change is the only breaking edit to existing code. One call site, one test harness; caught by `typecheck`, not at runtime.
- `FileMeta.deviceLabel` is additive JSON inside an existing envelope: an older plugin reading a newer version ignores the field, and a newer plugin reading an older version gets `undefined`, which `describeDevice` handles. No envelope version bump is needed.
- The modal reads the current file through `app.vault.adapter` rather than the `VaultAdapter` port, because it needs raw bytes for a path that may be under the config directory. That is the one place the view touches Obsidian storage directly; if it grows a second, move the read into `VersionHistoryService`.

---

## Execution Handoff

Tasks 1–9 are the shippable unit; 10 and 11 are independent follow-ups.

Suggested order and commits:

| Commit | Tasks |
|---|---|
| `feat: return the encrypted meta with each version, and page the list` | 1, 2, 3 |
| `feat: record the committing device name inside the version meta` | 4 |
| `refactor: share the text, diff and sidecar-path helpers` | 5 |
| `feat: version preview and restore engine` | 6, 7 |
| `feat: version history modal, command and file-menu entry` | 8 |
| `docs: version history is implemented` | 9 |

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.

**2. Inline Execution** — execute in this session using superpowers:executing-plans, with a checkpoint after Task 7 (everything testable) and before Task 8 (everything not).

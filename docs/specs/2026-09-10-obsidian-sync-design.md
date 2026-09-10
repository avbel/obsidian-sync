# Obsidian Sync — Design

**Date:** 2026-09-10
**Status:** Approved for planning

A self-hosted replacement for Obsidian's paid Sync service: an Obsidian plugin (desktop, iOS, Android) plus a synchronisation server, with end-to-end encryption, full-vault coverage, version history, and near-real-time propagation.

---

## 1. Goals and non-goals

### Goals

- Sync a whole vault — markdown, attachments, and `.obsidian` configuration — between an arbitrary number of devices.
- End-to-end encryption: the server stores ciphertext and never holds a key.
- Near-real-time propagation without the battery cost of fixed-interval polling.
- Correct offline behaviour: edit on a plane, land, and converge without losing writes.
- Version history with restore.
- Selective sync, so a device can decline folders or whole categories.
- Run on Node.js 26 in a minimal container, reachable over a Tailscale tailnet.

### Non-goals

- Live collaborative editing (multiple cursors in one document). Sync converges after edits settle; it is not a CRDT co-editing system.
- Multi-tenant SaaS. This targets a small, known set of users authenticated by pre-shared tokens.
- Server-side search, indexing, or a web UI. End-to-end encryption forecloses all three by construction.
- Horizontal scale-out. The design is deliberately single-process.

### Reference implementation

`../ai-notes` is a prior project by the same author with the same two-part shape. It is a source of ideas, not code to copy. Specifically inherited: the offline queue with exponential backoff, the per-file debounce before pushing, and the two-client integration test shape. Specifically rejected: git-as-storage, server-side merge, markdown-only scope, the git hash used as a sync cursor, and storing the auth token in `data.json`.

---

## 2. Constraints that shape the design

These are not preferences. Each one closes off options that would otherwise look reasonable.

### 2.1 Obsidian mobile is a Capacitor WebView

The mobile app runs its UI on an `https://localhost` origin. Any request the WebView's own network stack issues to a plain `http://` or `ws://` endpoint is blocked by the browser mixed-content policy.

The server will be reached at `http://<tailscale-ip>:<port>`. Therefore:

- **All data transfer uses `requestUrl`**, Obsidian's native HTTP client, which bypasses the WebView network stack entirely — no CORS, no mixed-content check, no certificate validation. `fetch` is unusable on mobile against this server.
- **`WebSocket` has no native equivalent.** It runs inside the WebView and *is* subject to mixed content, so `ws://` to a tailnet address will fail on iOS and Android while working on desktop Electron.
- `RequestUrlParam` exposes only `url`, `method`, `contentType`, `body`, `headers`, `throw`. **There is no timeout option**, so the maximum duration of a held-open request is set by an undocumented native ceiling. See Risk R1.

### 2.2 `requestUrl` does not stream

The whole response body materialises in memory as an `ArrayBuffer`. A 200 MB video read in one call would be a 200 MB allocation on a phone. This forces **chunking** of file content, which the content-addressed store then makes useful for deduplication as well.

### 2.3 iOS suspends background apps

A live connection dies silently when the app backgrounds, and Tailscale roams between networks. A live channel can therefore never be treated as a record of what a device has received. Every device must be able to reconstruct its position from durable state alone.

This is why the transport carries no data — only "something changed" nudges — and why a full reconcile runs on load and on mobile foreground.

### 2.4 End-to-end encryption blinds the server

The server cannot merge, diff, index, or search. All conflict resolution is client-side. Selective-sync filtering is client-side. This is a consequence of the encryption decision, not an independent choice.

---

## 3. Architecture

```
obsidian-sync/
├── packages/
│   ├── protocol/          Wire types, validators, crypto envelope format
│   ├── plugin/            Obsidian plugin — TS7, bundled by esbuild to main.js
│   └── server/            Node.js 26 + TS7 + node:sqlite
├── docs/specs/
└── .github/workflows/     ci.yml, release.yml
```

`packages/protocol` is a workspace package imported by both halves. It holds the request and response types, their runtime validators, the envelope binary layout, and the version constants. It exists because a silent divergence between client and server serialisation would corrupt data rather than fail visibly.

### Transport choice

Plain HTTP with JSON bodies for metadata and `application/octet-stream` for chunks.

gRPC was evaluated and rejected. It requires HTTP/2 with trailers, which `requestUrl` cannot speak; WebViews need a gRPC-Web proxy in front; and gRPC-Web from the WebView uses `fetch`, which reintroduces the mixed-content block that §2.1 exists to avoid. The compactness argument does not apply either — payloads are already opaque AES-GCM ciphertext, which cannot be schema-compressed. The typed-contract benefit is obtained from `packages/protocol` instead, with no codegen step and no sidecar.

---

## 4. Cryptography

### 4.1 Key hierarchy

| Stage | Algorithm | Rationale |
|---|---|---|
| Passphrase → master key | PBKDF2-SHA-512, 650,000 iterations, per-vault 16-byte random salt | Present in WebCrypto on Electron and both mobile WebViews with zero dependencies. See Decision D1 for why not Argon2id. |
| Master → purpose keys | HKDF-SHA-256 → `K_content`, `K_path`, `K_name` | One key per purpose; never reuse across contexts. |

The salt is stored server-side per vault and is not secret. The passphrase is never transmitted.

### 4.2 File identity

```
fileId = HMAC-SHA-256(K_name, normalised_path)     // 32 bytes, hex-encoded
```

Deterministic, so every device independently derives the same identifier for the same path and the server can key records without ever learning a path. Not invertible without `K_name`.

Path normalisation is defined once in `packages/protocol`: forward slashes, no leading slash, NFC Unicode normalisation. NFC matters because macOS and iOS hand back decomposed (NFD) filenames while Linux and Android do not; without normalising, the same note yields two different `fileId`s and syncs as two files.

Because identity is derived from the path, **renaming a file changes its `fileId`**. A rename is therefore a delete of the old identity plus a create of the new one. The chunks are reused — `blobs/check` finds every address already present, so no content is re-uploaded and the transfer is nearly free — but the version chain restarts under the new identity, and history for the old path is retained only until pruning removes it. See Decision D4.

### 4.3 Path payload

```
encryptedPath = AES-256-GCM(K_path, randomNonce, normalised_path)
```

Non-determinism is acceptable here — this is cargo the client decrypts, not an index key.

### 4.4 Content encryption and the deduplication problem

Content is split into 4 MiB chunks. Each chunk is encrypted with AES-256-GCM under `K_content`, with

```
AAD = fileId ‖ versionId ‖ chunkIndex
```

The AAD binds every chunk to its position. Without it, a malicious or compromised server could reorder chunks or splice a chunk from one file into another and the client would decrypt the result without complaint.

The store needs a content address per chunk. Two obvious choices are both wrong:

- Hashing the **ciphertext** breaks deduplication, because a random nonce produces different bytes for identical plaintext every time — version history would store a fresh copy of every chunk on every save.
- Hashing the **plaintext** leaks a fingerprint. The server could test whether a vault contains a known file by hashing a candidate and looking for the address — a confirmation attack.

The design uses a keyed address instead:

```
blobAddress = HMAC-SHA-256(K_content, plaintext_chunk)
blobContent = nonce ‖ ciphertext ‖ tag
```

Deterministic within a vault, so deduplication and version history work. Uncomputable without `K_content`, so it reveals nothing to the server. Identical plaintext reuses the stored blob together with its stored nonce, which is safe precisely because the plaintext is identical — the nonce-reuse weakness requires *different* plaintexts under the same key and nonce.

Cross-vault deduplication is lost. That is intended.

### 4.5 Accepted leakage

The server learns, and this is written down so it is not discovered later:

- the number of files in a vault,
- the size of each file, rounded up to chunk granularity,
- when uploads happen and from which device,
- the shape of the version graph.

It does not learn file names, folder structure, tags, or content.

### 4.6 Failure behaviour

A decryption failure means a wrong passphrase or a corrupted blob. It **halts sync for that vault and surfaces a blocking error**. It must never write undecrypted or partially decrypted bytes into the vault, and must never be retried silently in a loop.

---

## 5. Server

Node.js 26, TypeScript 7, `node:sqlite`, filesystem blob store. Single process.

### 5.1 Storage layout

```
$DATA_DIR/
├── sync.db                          SQLite, WAL mode
└── blobs/<vault>/<aa>/<aabbccdd...> Immutable encrypted chunks
```

Content-addressed rather than mirroring the vault tree:

| Property | Vault-tree mirror | Content-addressed |
|---|---|---|
| Version history | full copy per version | versions share unchanged chunks |
| Same note from five devices | five writes | one blob, five rows |
| Rename | rewrite file on disk | no blob movement; chunks reused verbatim |
| Torn write on crash | possible | impossible — write-once |
| Encrypted payloads | awkward | identical handling |

### 5.2 Schema

```sql
CREATE TABLE vault (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  kdf_salt    BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (owner, name)
);

CREATE TABLE device (
  id            TEXT PRIMARY KEY,
  vault_id      TEXT NOT NULL REFERENCES vault(id),
  label         TEXT NOT NULL,
  platform      TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE file (
  vault_id     TEXT NOT NULL REFERENCES vault(id),
  file_id      TEXT NOT NULL,
  head_version TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  updated_seq  INTEGER NOT NULL,
  PRIMARY KEY (vault_id, file_id)
);

CREATE TABLE version (
  vault_id       TEXT NOT NULL,
  file_id        TEXT NOT NULL,
  version_id     TEXT NOT NULL,
  parent_version TEXT,
  meta_blob      BLOB NOT NULL,   -- encrypted: path, mtime, ctime, mime
  chunks         TEXT NOT NULL,   -- JSON array of blob addresses, in order
  size           INTEGER NOT NULL,
  device_id      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (vault_id, file_id, version_id)
);

CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id   TEXT NOT NULL,
  file_id    TEXT NOT NULL,
  version_id TEXT,
  kind       TEXT NOT NULL,        -- 'upsert' | 'delete'
  created_at INTEGER NOT NULL
);
CREATE INDEX change_log_vault_seq ON change_log (vault_id, seq);

CREATE TABLE blob_ref (
  vault_id TEXT NOT NULL,
  addr     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  refcount INTEGER NOT NULL,
  PRIMARY KEY (vault_id, addr)
);
```

`change_log.seq` is the entire cursor mechanism. A client asks for everything after the sequence number it last durably recorded. Renames, deletes, and edits are all just rows, which is why this succeeds where a git hash — the approach in `ai-notes` — cannot express "what changed for me."

`blob_ref.refcount` drives retention: pruning an old version decrements the count of each chunk it referenced, and a background sweep deletes blobs that reach zero.

### 5.3 Durability ordering

**Write and fsync the blob, then commit the SQLite row.** In that order, always.

An orphaned blob is garbage that the sweep collects. A row referencing a missing blob is unrecoverable corruption that presents as a decryption failure on some other device days later. The asymmetry is the reason the rule is absolute.

### 5.4 Concurrency

SQLite in WAL mode supports many readers and one writer. Writes are serialised through a single queue in-process. This is sufficient for the target scale and is the reason the design is explicitly single-process: running two replicas against one SQLite file would corrupt it. Moving to Postgres is the migration path if that ever becomes necessary, and nothing above depends on SQLite specifics beyond `AUTOINCREMENT` semantics.

### 5.5 API

All routes require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Liveness. No auth. |
| `GET` | `/v1/me` | Resolves token to `{ user, vaults[] }`. |
| `POST` | `/v1/vaults` | Create a remote vault with a KDF salt. |
| `GET` | `/v1/vaults/:v/changes?since=N&wait=25` | Long-poll. Returns `{ changes[], seq }`. |
| `POST` | `/v1/vaults/:v/blobs/check` | Given addresses, returns which are absent. |
| `PUT` | `/v1/vaults/:v/blobs/:addr` | Idempotent chunk upload. `204` if already present. |
| `GET` | `/v1/vaults/:v/blobs/:addr` | Returns the chunk as `application/octet-stream`. |
| `POST` | `/v1/vaults/:v/files/:fileId` | Commit a version. |
| `DELETE` | `/v1/vaults/:v/files/:fileId` | Tombstone a file. |
| `GET` | `/v1/vaults/:v/files/:fileId/versions` | Version history. |
| `GET` | `/v1/vaults/:v/state` | Full file list with head versions, for reconcile. |
| `WS` | `/v1/vaults/:v/stream` | Optional push channel. Carries `seq` nudges only. |

`blobs/check` is what makes editing one word in a 40 MB PDF cost one chunk instead of forty. The client computes all addresses locally, asks which are missing, and uploads only those.

### 5.6 Optimistic concurrency

A commit carries `parent_version`, the version the client believes is current. If it no longer matches the head, the server responds `409 Conflict` with the current head and commits nothing.

This is the correctness hinge of the whole system. The server never merges — it cannot read the bytes — so it must reject rather than overwrite. `409` is normal control flow: the client pulls, merges locally, and retries.

### 5.7 Authentication

Tokens are pre-shared and read from the environment at startup:

```
SYNC_USER_ALICE=<token>
SYNC_USER_BOB=<token>
```

The username is the lowercased suffix. Comparison is constant-time. Startup fails loudly on a duplicate token, a case-colliding username, or a token shorter than 32 characters — a weak token behind Tailscale is still the only thing between a tailnet peer and the whole store.

There is no registration, no password reset, and no session state.

### 5.8 Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | `/data` | SQLite file and blob store root |
| `SYNC_USER_<NAME>` | — | Defines a user and their bearer token |
| `MAX_BLOB_BYTES` | `8388608` | Upload size ceiling per chunk |
| `LONGPOLL_MAX_WAIT_MS` | `25000` | Server-side hold ceiling |
| `VERSION_RETENTION_DAYS` | `90` | Age at which old versions become pruneable |
| `VERSION_RETENTION_MIN` | `10` | Versions per file always kept regardless of age |
| `LOG_LEVEL` | `info` | pino level |

---

## 6. Plugin

### 6.1 Module layout

```
packages/plugin/src/
├── main.ts                Entry, lifecycle, command and view registration
├── crypto/                Key derivation, envelope encrypt/decrypt, chunking
├── transport/
│   ├── http.ts            requestUrl wrapper, retry, auth header
│   ├── longpoll.ts        Held-open GET /changes
│   ├── websocket.ts       wss:// nudge channel
│   └── index.ts           Selection and failover between the two
├── state/
│   ├── index.ts           path → { fileId, versionId, hash, mtime, chunks }
│   └── base-cache.ts      Ancestor content for three-way merge
├── engine/
│   ├── push.ts            Dirty set → chunk → check → upload → commit
│   ├── pull.ts            changes since seq → fetch → decrypt → apply
│   ├── merge.ts           diff3
│   ├── apply.ts           Vault writes, deletes, renames
│   └── reconcile.ts       Full comparison on load and on foreground
├── ui/                    See §6.3
├── watcher.ts             Vault events → debounced dirty set
└── settings/              Declarative setting definitions
```

### 6.2 Current Obsidian APIs used

The API baseline is **1.13.2**. These are load-bearing, and each replaces a pattern that `ai-notes` uses because it predates them.

| API | Since | Use |
|---|---|---|
| `app.secretStorage` | 1.11.4 | Auth token and passphrase. Never `data.json` — that file lives inside the vault, is plaintext, and would itself be synced. |
| Declarative settings (`getSettingDefinitions`) | 1.13.0 | The whole settings tree, including validation and search. |
| `SettingSecretControl` (`type: 'secret'`) | 1.13.2 | Masked token and passphrase entry. |
| `SettingFolderControl` with `filter` | 1.13.0 | Selective-sync folder picker. |
| `SettingDefinitionList` | 1.13.0 | Exclusion list with add, delete, reorder. |
| `displayValue`, `status: 'warning'` | 1.13.1 | Inline connection state on setting rows. |
| `adapter.process()` | 1.7.2 | Atomic read-modify-write when applying a remote text change, closing the window where a pull lands mid-keystroke. |
| `FileManager.trashFile()` | 1.6.6 | Remote deletes honour the user's trash preference, so a bad sync is recoverable. |
| `onExternalSettingsChange()` | 1.5.7 | Lets other plugins reload after config sync rewrites their `data.json`. |
| `Vault.copy()` | 1.8.7 | Conflict-copy creation. |
| `adapter.readBinary` / `writeBinary` | 1.7.2 | Attachments. |
| `app.loadLocalStorage` / `saveLocalStorage` | 1.8.7 | Per-vault device identity and cursor. |
| `Platform.isPhone` / `isIosApp` / `isAndroidApp` | 0.12.2 | Layout and transport decisions. |
| `requireApiVersion()` | — | Guard so an older Obsidian degrades rather than crashes. |

### 6.3 User interface

Seven surfaces. On phones, `Platform.isPhone` collapses side-by-side layouts into stacked ones, and the status bar is unavailable — so the ribbon icon and the status view carry the indicator role there.

#### 6.3.1 Settings tab

Built with the declarative settings API as a `SettingDefinitionPage` tree rather than a hand-rolled `display()` method. Pages:

**Connection**
- Server URL — text, validated as a URL, with a warning status when unreachable.
- Auth token — `type: 'secret'`.
- *Test connection* action, showing the resolved username and server version inline via `displayValue`.
- Device label — text, defaulting to a platform-derived name.

**Encryption**
- Passphrase — `type: 'secret'`.
- Remote vault — dropdown of vaults available to the token, plus *Create new*.
- A permanent, non-dismissable warning that a lost passphrase means unrecoverable data. This is stated in the UI, not only the docs.
- *Verify passphrase* action, which fetches one known blob and attempts decryption.

**Sync**
- Sync enabled — toggle.
- Debounce delay — slider, 500–30000 ms, default 2000, `displayFormat` rendering seconds.
- Transport — dropdown: Automatic (default), Long-poll only, WebSocket only, Interval polling.
- Poll interval — number, shown only when Transport is Interval polling (`visible` predicate).
- Sync on startup — toggle, default on.

**Selective sync**
- Category toggles: Markdown notes, Attachments, Vault configuration, Themes, Snippets, Community plugin settings.
- Excluded folders — a `SettingDefinitionList` of `SettingFolderControl` rows with add, delete, and reorder.
- Maximum file size — number, default 100 MiB, above which files are skipped and reported.

**Version history**
- Retention days — number, default 90.
- Minimum versions kept per file — number, default 10.
- *Show storage usage* action.

**Advanced**
- Chunk size — dropdown: 1, 4, 16 MiB. Default 4.
- Log level.
- *Rebuild local index* — recomputes state from the vault and server without re-uploading content.
- *Reset and re-pair device* — clears local state and device identity.

#### 6.3.2 Sync status view

An `ItemView` in the right sidebar, registered under a stable view type and opened from the ribbon or a command.

- Overall state: idle, syncing, offline, conflict, error, paused.
- Progress: current file, transferred of total bytes, queue depth.
- Last successful sync, as a relative time.
- Conflicts needing attention, each opening the resolution modal on click.
- Recent activity — a bounded log of the last 50 operations with direction and outcome.
- Actions: *Sync now*, *Pause*, *Full reconcile*.

This view is the primary sync indicator on mobile, where no status bar exists.

#### 6.3.3 Status bar item

Desktop only. A compact icon plus state, clicking through to the status view. Reflects idle, syncing, error, conflict, offline, paused.

#### 6.3.4 First-run setup wizard

A multi-step modal, triggered when no configuration exists. This exists because a mistyped passphrase on first run produces a vault that cannot be decrypted later, and a plain settings form does not defend against that.

1. Server URL and token → *Test*, blocking until it succeeds.
2. Choose an existing remote vault, or create one.
3. Passphrase. When creating a vault, entered twice with a strength indicator. When joining an existing vault, verified immediately against a real blob before proceeding.
4. Selective-sync choices.
5. Preview: how many files will upload, how many will download, and total bytes — before anything is written.
6. Start.

#### 6.3.5 Version history modal

Opened per note from a command or the file menu. Lists versions with timestamp, originating device, and size; previews the diff between any version and the current file; restores a version as a new version, never by rewriting history.

#### 6.3.6 Conflict resolution modal

Shown when a three-way merge fails. Presents local, remote, and the conflict copy path, with a side-by-side diff on desktop and a stacked diff on phones. Offers: keep local, keep remote, keep both, or open the conflict copy for manual editing. Nothing is destroyed until an explicit choice is made.

#### 6.3.7 Ribbon icon and commands

Ribbon icon opens the status view. Commands: *Sync now*, *Open sync status*, *Show version history for current file*, *Resolve conflicts*, *Pause sync*, *Full reconcile*.

### 6.4 Local state

Local state must not live in `data.json`, because that file sits inside the vault and would be synced. It is split by durability requirement:

- **Secrets** — `app.secretStorage`.
- **Device identity and last-seen sequence** — `app.saveLocalStorage`, which is per-vault and per-device by construction.
- **File index and base-content cache** — files under the plugin directory, explicitly excluded from sync.

The base-content cache holds the common ancestor for each tracked file. It is what makes three-way merge possible; without it, only last-write-wins is available. It is pruned alongside the index.

### 6.5 Configuration sync guardrails

Syncing `.obsidian/` means writing files that a running Obsidian holds open. The rules are absolute:

- `workspace.json` and `workspace-mobile.json` are **never** synced. They describe device-local pane layout; syncing them makes a phone reopen a desktop's panes.
- This plugin's own state directory is never synced.
- `.obsidian/plugins/*/data.json` is synced; `onExternalSettingsChange` gives the owning plugin the chance to reload.
- A change to core configuration surfaces a notice offering a reload. It never force-reloads Obsidian underneath the user.

---

## 7. Sync protocol

### 7.1 Push

1. A vault event marks a path dirty.
2. Per-file debounce, default 2000 ms, resets on each further edit.
3. Read the file, split into chunks, compute each `blobAddress`.
4. `POST /blobs/check` with the address list.
5. `PUT` each missing chunk.
6. `POST /files/:fileId` with `parent_version` set to the locally known head.
7. On `409`, run the pull path for that file, merge, and retry from step 3.

### 7.2 Pull

1. A nudge arrives, or a reconcile begins.
2. `GET /changes?since=<durable cursor>`.
3. For each change: decrypt the metadata envelope, recover the real path, and drop it if selective sync excludes it.
4. Fetch missing chunks, decrypt, and reassemble.
5. Apply according to §8.
6. Persist the cursor **after** the batch is applied, never before. A crash then replays rather than skips.

### 7.3 Transport selection

The nudge channel is an interface with three implementations, chosen automatically unless overridden:

- Server URL is `https://` → WebSocket, falling back to long-poll on failure.
- Server URL is `http://` → long-poll, since `ws://` is blocked in the mobile WebView.
- Explicit override → as configured.

Because the channel carries only sequence numbers, switching implementations is invisible to the engine, and failover requires no special handling beyond reconnection.

### 7.4 Reconcile

A full comparison of local state against `GET /state`, run on plugin load, on mobile foreground, and on demand. It resolves anything the incremental path could have missed: changes made while the app was terminated, files edited outside Obsidian, and a cursor lost to a crash.

---

## 8. Conflict resolution

All resolution is client-side; the server cannot read the content.

| Situation | Resolution |
|---|---|
| Local unchanged since base | Write remote directly via `adapter.process`. |
| Local changed, text file, base known | `diff3(base, local, remote)`. Clean → write merged and push. Conflicted → write remote and save local as `note (conflict YYYY-MM-DD HH-mm-ss).md`, then raise the conflict modal. |
| Local changed, base unknown | Conflict copy. Merging without an ancestor invents changes. |
| Binary file | Conflict copy always. No meaningful merge exists. |
| Deleted remotely, modified locally | Keep local, push as a new version. Deletion never beats an edit. |
| Modified remotely, deleted locally | Restore from remote and notify. Same principle. |
| Renamed on both sides | `fileId` follows the path, so this appears as one delete and one create per side. Both survive; the user reconciles. |

The invariant: **no path through this table destroys data without an explicit user choice.**

---

## 9. Error handling

- **Offline queue.** Push operations persist to disk with exponential backoff capped at five minutes, surviving restarts. Deletes and renames are ordered ahead of pushes so a queue drained after a long offline period replays coherently.
- **`409 Conflict`** is control flow, not an error, and is not surfaced to the user or logged as a failure.
- **`401`** halts sync and raises a persistent settings warning. It never retries in a loop against a rejecting server.
- **Decryption failure** halts the vault's sync entirely and raises a blocking error naming the passphrase as the likely cause.
- **Partial pull** is safe by construction, because the cursor advances only after a batch applies.
- **Oversized file** is skipped, named in the status view, and does not stall the queue behind it.
- **Server disk full** returns `507`; the client pauses uploads and surfaces the cause rather than retrying into a wall.

---

## 10. Packaging and CI

### 10.1 Container

Base image: **`gcr.io/distroless/nodejs26-debian13:nonroot`**. Verified present in the registry with `nonroot`, `nonroot-amd64`, and `nonroot-arm64` tags. No shell, no package manager, non-root by default, and its entrypoint is already `node`.

`FROM scratch` is not achievable and was not attempted: scratch provides no libc, and the Node binary is dynamically linked against glibc, libstdc++, libgcc, libm, and pthreads. Only a statically linked runtime can target scratch.

```dockerfile
FROM node:26-trixie-slim AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @obsidian-sync/server build \
 && pnpm deploy --filter @obsidian-sync/server --prod /out

FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build /out /app
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["/app/dist/index.js"]
```

Because storage is `node:sqlite` — built into the Node binary — there are no native modules to compile, so the ARM leg of the multi-arch build has nothing to break on.

### 10.2 Workflows

**`ci.yml`** — on pull request and push: install, `tsc --noEmit` across the workspace, lint, `vitest run` for both packages, and build the plugin bundle.

**`release.yml`** — on push to `main` and on `v*` tags:

- `docker/metadata-action` derives tags: `main` and `sha-<short>` from main; `1.2.3`, `1.2`, and `latest` from a semver tag.
- `docker/build-push-action` builds `linux/amd64,linux/arm64` with GitHub Actions cache, publishing to `ghcr.io/<owner>/obsidian-sync-server`.
- On a tag, a GitHub Release is created with `main.js`, `manifest.json`, and `styles.css` attached, which is the distribution format Obsidian and BRAT expect.

One operational note: the **first** GHCR push must come from the workflow. A package created by a manual push with a personal access token is not linked to the repository, and subsequent pushes authenticated by `GITHUB_TOKEN` are then rejected with `denied: permission_denied: write_package`.

---

## 11. Testing

- **Two-client integration.** Two in-process virtual clients driving one real server through concurrent edit, rename-versus-edit, delete-versus-edit, and offline-then-reconnect. This is the highest-value suite; sync bugs live in races, not in units.
- **Crypto.** Known-answer tests for key derivation and the envelope format, property-based round-trip tests, and an explicit test that a tampered AAD fails to decrypt.
- **Merge.** Table-driven `diff3` cases including clean merges, true conflicts, and the ancestor-unknown path.
- **Server.** Real SQLite in a temporary directory, exercised through the HTTP surface rather than internal calls. Includes a crash-ordering test asserting that an interrupted commit leaves an orphan blob and never a dangling row.
- **Plugin.** Vitest against a mocked Obsidian API, following the `__mocks__/obsidian.ts` shape used in `ai-notes`.
- **Path normalisation.** Explicit NFC/NFD cases, since this is silent cross-platform corruption when wrong.

---

## 12. Milestones

| # | Scope |
|---|---|
| M1 | `packages/protocol`; server core — auth, vaults, blobs, changes, SQLite schema, durability ordering; server test suite. |
| M2 | Plugin skeleton — crypto, settings tree, secret storage, local index, markdown push and pull, interval polling. |
| M3 | Long-poll transport, WebSocket upgrade, three-way merge, conflict copies, conflict modal. |
| M4 | Attachments and binaries, chunking, `blobs/check` optimisation, selective sync. |
| M5 | `.obsidian` configuration sync with guardrails, version history, restore, storage usage. |
| M6 | Status view, setup wizard, Docker image, CI and release workflows, documentation. |

M1 and M2 are the critical path; M3 is where the design's correctness claims first become testable end to end.

---

## 13. Decisions and risks

### D1 — PBKDF2 rather than Argon2id

Argon2id resists GPU attack far better. It requires a WASM module, which adds a build dependency and meaningful CPU cost on phones. PBKDF2-SHA-512 at 650,000 iterations is available natively in every Obsidian runtime with no dependency. Given the server sits behind Tailscale — so an attacker needs tailnet access *and* the disk — this is adequate. The key hierarchy is versioned in `packages/protocol`, so migrating to Argon2id later is a re-derivation, not a redesign.

### D2 — Client-side merge rather than CRDT

A CRDT would merge automatically and never produce a conflict file, but requires a document per note, a growing update log to compact, and awkward reconciliation when a file is edited outside Obsidian. Three-way merge over a cached ancestor delivers most of the benefit at a fraction of the complexity, and it is already better than the paid product, which uses last-write-wins.

### D3 — Single process, SQLite

Rules out replicas behind a load balancer. Accepted deliberately: the target is one self-hosted server for a small number of users. Postgres is the escape hatch if that changes.

### D4 — Path-derived identity, so history does not survive a rename

`fileId = HMAC(K_name, path)` makes identity converge automatically: two devices that independently create the same path agree on the same record with no coordination, and a fresh device derives every identity locally without a lookup table.

The alternative — assigning each file a random UUID at creation and keying on `HMAC(K_name, uuid)` — would let history follow a rename, and would make renames metadata-only. It was rejected for this version because it breaks convergence: two devices creating the same path while offline mint different UUIDs and the vault ends up with duplicates, which is a worse failure than a restarted version chain. It also requires a path-to-UUID map on every device before any file can be addressed.

The cost is accepted and stated in §4.2. If history across renames later matters more than convergence, the migration is a re-keying pass rather than a redesign, because the envelope format is versioned.

### R1 — `requestUrl` has no timeout parameter

The long-poll hold duration depends on an undocumented native ceiling that may differ across desktop, iOS, and Android. **Mitigation:** measure the real ceiling on each platform as the first task of M3, and set `LONGPOLL_MAX_WAIT_MS` below the lowest observed value. The interval-polling implementation already exists as a fallback, so a bad outcome degrades latency rather than breaking sync.

### R2 — Selective sync still downloads all metadata

Because the server cannot read paths, a client must fetch and decrypt every file's metadata to decide what to skip. At a few hundred bytes per file this is a few megabytes for a ten-thousand-note vault on first sync, and negligible incrementally. Accepted as an inherent cost of encrypted paths.

### R3 — Configuration sync can fight a running Obsidian

Writing `.obsidian/` under a live application is the sharpest edge in the project. Mitigated by the exclusion list in §6.5, by never force-reloading, and by scheduling this work last, in M5, once everything beneath it is stable.

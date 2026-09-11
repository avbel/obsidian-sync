# obsidian-sync

A self-hosted replacement for Obsidian's paid Sync service: an Obsidian plugin (desktop, iOS, Android) plus a synchronisation server, with end-to-end encryption, full-vault coverage, version history, and near-real-time propagation.

The server stores ciphertext and never holds a key. It cannot read your notes, their names, or your folder structure.

> **Status:** early. The protocol, server, crypto, and sync engine are implemented and tested; several plugin surfaces described in the design are not yet built — see [Not yet implemented](#not-yet-implemented).

---

## What it does

- Syncs a whole vault — markdown, attachments, and `.obsidian` configuration — between any number of devices.
- End-to-end encrypted with a passphrase that never leaves your device.
- Three-way merge over a cached common ancestor, so two devices editing different parts of the same note converge instead of one overwriting the other. Obsidian's own Sync uses last-write-wins.
- Chunked, content-addressed storage: editing one word in a 40 MB PDF uploads one chunk, and version history shares unchanged chunks.
- Near-real-time propagation over a WebSocket or long-poll nudge channel, with interval polling as a fallback.
- Selective sync by category and by folder, with a per-device file-size ceiling.
- Version history per file, retained by age and by minimum count.

### Non-goals

Live collaborative editing (this is not a CRDT), multi-tenant SaaS, server-side search or a web UI (end-to-end encryption forecloses all three), and horizontal scale-out.

---

## How it works

```
┌────────────┐   nudge (seq only)   ┌──────────────┐
│  Plugin    │◄─────────────────────│   Server     │
│  (device)  │                      │  Node 26     │
│            │  encrypted chunks    │  node:sqlite │
│  crypto    │─────────────────────►│  blob store  │
│  engine    │  + version commits   │              │
└────────────┘                      └──────────────┘
```

**Identity.** `fileId = HMAC-SHA-256(K_name, normalised_path)`. Deterministic, so every device derives the same identifier for the same path with no coordination, and the server keys its records without ever learning a path. Paths are normalised to NFC — macOS and iOS hand back decomposed filenames while Linux and Android do not, and without normalising the same note would sync as two files.

**Keys.** Passphrase → PBKDF2-SHA-512, 650,000 iterations, per-vault 16-byte salt → HKDF-SHA-256 → `K_content`, `K_path`, `K_name`. The salt is stored server-side and is not secret; the passphrase is never transmitted.

**Content.** Files are split into 4 MiB chunks, each encrypted with AES-256-GCM under `K_content`. Both the chunk's address and its nonce are derived from the plaintext:

```
blobAddress = HMAC-SHA-256(K_content, 0x01 ‖ chunk)
nonce       = HMAC-SHA-256(K_content, 0x02 ‖ chunk)[0:12]
```

A stored blob is therefore a pure function of its content, which is what makes deduplication, chunk sharing across versions, and the `blobs/check` upload optimisation work — while remaining uncomputable to a server that lacks `K_content`. Position integrity lives one layer up: the ordered chunk list is inside the encrypted metadata envelope, authenticated with `AAD = fileId`, and the client recomputes every address on pull. A server that reorders, drops, or splices a chunk is detected by the client.

**Concurrency.** A commit names the version the client believes is current. If it is no longer the head, the server replies `409` and commits nothing. The server never merges — it cannot read the bytes — so it rejects, and the client pulls, merges locally, and retries. `409` is normal control flow, not an error.

**What the server learns.** The number of files in a vault, each file's size rounded to chunk granularity, when uploads happen and from which device, and the shape of the version graph. Not file names, folder structure, tags, or content.

Full rationale, including the decisions and their trade-offs, is in [`docs/specs/2026-09-10-obsidian-sync-design.md`](docs/specs/2026-09-10-obsidian-sync-design.md).

---

## Repository layout

| Package | Contents |
|---|---|
| `packages/protocol` | Wire types, validators, envelope format, path normalisation, shared constants. |
| `packages/server` | Fastify server, SQLite schema, blob store, change log, retention, Dockerfile. |
| `packages/plugin` | Obsidian plugin: crypto, transport, sync engine, three-way merge, UI. |

---

## Running the server

The server is a single process. Running two replicas against one SQLite file would corrupt it; Postgres is the migration path if that ever matters.

### Docker

```bash
docker run -d --name obsidian-sync \
  -p 3000:3000 \
  -v obsidian-sync-data:/data \
  -e SYNC_USER_ALICE="$(openssl rand -hex 32)" \
  ghcr.io/avbel/obsidian-sync-server:latest
```

The image is `gcr.io/distroless/nodejs26-debian13:nonroot` — no shell, no package manager, non-root, `linux/amd64` and `linux/arm64`.

### From source

```bash
pnpm install
pnpm build
SYNC_USER_ALICE=<token> DATA_DIR=./data node packages/server/dist/index.js
```

### Exposing it

Put the server on a [Tailscale](https://tailscale.com) tailnet rather than the public internet. The auth tokens are pre-shared and there is no rate limiting, account recovery, or session management by design — the tailnet is the outer perimeter and the token is the inner one.

Over plain `http://` the plugin uses long-poll, because a mobile WebView blocks `ws://` to a tailnet address. Over `https://` it upgrades to a WebSocket and falls back to long-poll on failure.

### Configuration

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
| `ORPHAN_BLOB_GRACE_MS` | `86400000` | Age before an unreferenced blob may be reclaimed |
| `LOG_LEVEL` | `info` | pino level |

Users are defined entirely by environment: `SYNC_USER_ALICE=<token>` creates the user `alice`. Startup fails loudly on a duplicate token, a case-colliding username, or a token shorter than 32 characters.

### API

All routes require `Authorization: Bearer <token>` except health.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Liveness. No auth. |
| `GET` | `/v1/me` | Resolves a token to `{ user, vaults[] }`. |
| `POST` | `/v1/vaults` | Create a remote vault with a KDF salt. |
| `GET` | `/v1/vaults/:v/changes?since=N&wait=25` | Long-poll for changes past a cursor. |
| `POST` | `/v1/vaults/:v/blobs/check` | Given addresses, returns which are absent. |
| `PUT` | `/v1/vaults/:v/blobs/:addr` | Idempotent chunk upload. |
| `GET` | `/v1/vaults/:v/blobs/:addr` | Fetch a chunk. |
| `POST` | `/v1/vaults/:v/files/:fileId` | Commit a version. |
| `DELETE` | `/v1/vaults/:v/files/:fileId` | Tombstone a file. |
| `GET` | `/v1/vaults/:v/files/:fileId/versions` | Version history. |
| `GET` | `/v1/vaults/:v/state` | Full file list with head versions, for reconcile. |
| `WS` | `/v1/vaults/:v/stream` | Optional push channel. Carries `seq` nudges only. |

---

## Installing the plugin

No community-plugin listing yet. Install manually or through [BRAT](https://github.com/TfTHacker/obsidian42-brat).

Manually, per vault:

1. Download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/avbel/obsidian-sync/releases).
2. Put them in `<vault>/.obsidian/plugins/obsidian-sync/`.
3. Reload Obsidian and enable **Obsidian Sync** in Community plugins.

Requires Obsidian **1.13.2** or newer, on any platform.

Then, in the plugin's settings tab: set the server URL and token, test the connection, choose a vault name and a passphrase, and turn sync on. The token and passphrase go into Obsidian's `secretStorage`, never into `data.json` — that file lives inside the vault and would itself be synced.

> **Your passphrase is not recoverable.** It never reaches the server, so nobody can reset it. Losing it means losing the remote copy of the vault. Enter it carefully on the first device and record it somewhere safe.

### Conflict handling

| Situation | Resolution |
|---|---|
| Local unchanged since the last sync | Remote is written directly. |
| Local changed, text file, ancestor known | Three-way merge. Clean → merged and pushed. Conflicted → remote takes the file, local is saved as `note (conflict YYYY-MM-DD HH-mm-ss).md`. |
| Local changed, no ancestor | Conflict copy. Merging without an ancestor invents changes. |
| Binary file | Conflict copy always. |
| Deleted remotely, modified locally | Local wins and is pushed as a new version. Deletion never beats an edit. |
| Renamed on both sides | Both survive; you reconcile. Identity follows the path, so a rename is a delete plus a create. |

No path through that table destroys data without an explicit choice.

### What is never synced

`workspace.json` and `workspace-mobile.json` (they describe device-local pane layout), and this plugin's own state directory.

---

## Development

Requires Node.js 26+ and pnpm.

```bash
pnpm install
pnpm test        # vitest, all packages
pnpm typecheck   # tsc --noEmit, all packages
pnpm lint        # biome
pnpm build       # protocol + server (tsc), plugin (esbuild bundle)
```

To iterate on the plugin against a real vault, symlink `packages/plugin` into `<vault>/.obsidian/plugins/obsidian-sync/` and run `node packages/plugin/esbuild.config.mjs` for a watching build.

The highest-value suite is `packages/plugin/src/engine/engine.test.ts`: two in-process virtual devices driving one in-memory model of the server through concurrent edits, merges, conflicts, deletes, and reconnects. Sync bugs live in races, not in units.

---

## Not yet implemented

The design describes more than is built. Currently missing:

- First-run setup wizard, and the *Verify passphrase* action.
- Version history and restore UI (the server API exists; the plugin does not call it).
- Conflict resolution modal — conflicts produce a copy and a notice, but no interactive resolve.
- Full reconcile against `GET /state`. The *Full reconcile* command currently runs an ordinary incremental sync.
- Durable, restart-surviving offline queue. Pending deletes are held in memory; a lost delete is recovered on the next sync by reconciling the index against the vault, so correctness holds, but the queue itself is not persisted.

---

## Licence

[MIT](LICENSE).

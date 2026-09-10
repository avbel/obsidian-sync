# Obsidian Sync — Server & Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployable, end-to-end-encrypted Obsidian sync server on Node.js 26, plus the shared protocol package both halves of the system depend on.

**Architecture:** A single-process Fastify server storing encrypted chunks in a content-addressed filesystem blob store, with all metadata in SQLite (`node:sqlite`, WAL mode, one serialised writer). Clients pull incrementally using a monotonic `change_log.seq` cursor and commit versions under optimistic concurrency — the server never merges, because end-to-end encryption means it cannot read the bytes. A long-poll endpoint and an optional WebSocket carry sequence-number nudges only, never data.

**Tech Stack:** Node.js 26, TypeScript 7, pnpm workspaces, Fastify 5, `node:sqlite`, pino, Vitest, Biome, Docker (`gcr.io/distroless/nodejs26-debian13`), GitHub Actions.

**Spec:** `docs/specs/2026-09-10-obsidian-sync-design.md`

## Global Constraints

These apply to every task. Do not restate them; do not violate them.

- **Runtime:** Node.js 26+. TypeScript 7 (`typescript@^7`). ESM only — `"type": "module"` in every `package.json`, `.js` extensions on every relative import.
- **Package manager:** pnpm only. Never npm or yarn.
- **Node built-ins:** always `node:`-prefixed (`node:crypto`, `node:sqlite`, `node:fs/promises`).
- **No `any`.** Use `unknown` and narrow. No dynamic `await import()` — static imports only.
- **Strings:** single quotes.
- **Naming:** camelCase for variables and constants — never UPPER_SNAKE_CASE for identifiers. Environment *variable names* stay upper snake because they are strings, not identifiers. Full descriptive names; no abbreviations.
- **Nullish:** prefer `undefined` over `null`. The one exception is a value being written as SQL `NULL`.
- **Defaults:** `??`, never `||`.
- **Braces:** always brace `if` / `for` / `while` bodies, even single-line.
- **Async:** `async`/`await` only. Never `.then()`. Never `void`-prefix a promise. Use `node:fs/promises`, never `*Sync` filesystem calls (`node:sqlite`'s `DatabaseSync` is the sole exception — it is the only API the module offers).
- **Errors:** always throw `Error` subclasses with descriptive messages. Never throw strings. Never leave a `catch` block empty. Never include a token or passphrase in an error message.
- **Comments:** only for *why*, or for a measured fact or constraint the code cannot show. Never restate what the code says.
- **Commits:** conventional format (`feat:`, `fix:`, `test:`, `chore:`). Never add a Claude co-author trailer. Never create a git branch.
- **Crypto constants (spec §4):** AES-256-GCM, 12-byte nonce, 16-byte tag. PBKDF2-SHA-512 at 650000 iterations, 16-byte salt. HKDF-SHA-256 for subkeys. Default chunk size 4 MiB.
- **The server never decrypts anything.** It holds no keys and must never grow a code path that assumes it can read content or paths.

---

## File Structure

```
obsidian-sync/
├── package.json                     workspace root, scripts only
├── pnpm-workspace.yaml
├── tsconfig.base.json               shared compiler options
├── biome.json                       format + lint
├── vitest.config.ts                 workspace-wide test config
├── .gitignore
├── packages/
│   ├── protocol/                    shared by server and plugin
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts             barrel re-export
│   │       ├── constants.ts         crypto + protocol constants
│   │       ├── paths.ts             path normalisation (NFC)
│   │       ├── envelope.ts          encrypted blob binary layout
│   │       ├── wire.ts              request/response types
│   │       └── validate.ts          runtime type guards
│   └── server/
│       ├── package.json
│       ├── tsconfig.json
│       ├── Dockerfile
│       └── src/
│           ├── index.ts             entry: config → deps → listen → shutdown
│           ├── config.ts            environment parsing and validation
│           ├── users.ts             SYNC_USER_* registry
│           ├── auth.ts              bearer authentication hook
│           ├── app.ts               Fastify assembly
│           ├── db/
│           │   ├── schema.ts        DDL and migration runner
│           │   ├── database.ts      DatabaseSync lifecycle, WAL pragmas
│           │   └── writer.ts        serialised single-writer queue
│           ├── blobs.ts             content-addressed filesystem store
│           ├── changes.ts           change log append/query + long-poll waiters
│           ├── retention.ts         version pruning and orphan blob sweep
│           └── routes/
│               ├── health.ts        /v1/health, /v1/me
│               ├── vaults.ts        /v1/vaults
│               ├── blobs.ts         /v1/vaults/:vaultId/blobs/*
│               ├── files.ts         /v1/vaults/:vaultId/files/*
│               └── changes.ts       /v1/vaults/:vaultId/changes, /stream
└── .github/workflows/
    ├── ci.yml
    └── release.yml
```

**Why these boundaries:** `db/writer.ts` is separate from `db/database.ts` because serialisation is a policy that must be testable without a schema. `blobs.ts` never touches SQLite and `changes.ts` never touches the filesystem — that separation is what lets the durability-ordering rule (spec §5.3) be enforced in exactly one place, `routes/files.ts`, instead of being scattered.

---

## Task 1: Workspace scaffold and path normalisation

Scaffolding is folded in here because `normalisePath` is the first thing needing a compiler and test runner. It is also the highest-risk small function in the system: get NFC wrong and macOS/iOS silently sync every accented filename twice.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/paths.ts`
- Test: `packages/protocol/src/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalisePath(rawPath: string): string`, `isValidVaultPath(rawPath: string): boolean`.

- [ ] **Step 1: Create the workspace root files**

`package.json`:
```json
{
  "name": "obsidian-sync",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=26" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^2.3.0",
    "@types/node": "^26.0.0",
    "typescript": "^7.0.0",
    "vitest": "^4.0.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "es2025",
    "lib": ["es2025", "esnext.temporal"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedSideEffectImports": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true,
    "noEmitOnError": true
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.0/schema.json",
  "formatter": { "indentStyle": "tab", "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error" },
      "style": { "useConst": "error", "noNonNullAssertion": "error" }
    }
  },
  "files": { "includes": ["**", "!**/dist/**", "!**/node_modules/**"] }
}
```

`vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['packages/*/src/**/*.test.ts'],
		environment: 'node',
	},
});
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
data/
.DS_Store
```

- [ ] **Step 2: Create the protocol package files**

`packages/protocol/package.json`:
```json
{
  "name": "@obsidian-sync/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

`packages/protocol/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, `node_modules` populated, no errors.

- [ ] **Step 4: Write the failing test**

`packages/protocol/src/paths.test.ts`:
```typescript
import { describe, expect, test } from 'vitest';
import { isValidVaultPath, normalisePath } from './paths.js';

describe('normalisePath', () => {
	test('strips leading slashes', () => {
		expect(normalisePath('/notes/today.md')).toBe('notes/today.md');
	});

	test('converts backslashes to forward slashes', () => {
		expect(normalisePath('notes\\sub\\today.md')).toBe('notes/sub/today.md');
	});

	test('collapses repeated slashes', () => {
		expect(normalisePath('notes//sub///today.md')).toBe('notes/sub/today.md');
	});

	test('strips trailing slashes', () => {
		expect(normalisePath('notes/sub/')).toBe('notes/sub');
	});

	// macOS and iOS return NFD filenames; Linux and Android return NFC.
	// Without normalising, the same note yields two different fileIds.
	test('normalises decomposed unicode to NFC', () => {
		const decomposed = 'notes/café.md';
		const composed = 'notes/café.md';
		expect(decomposed).not.toBe(composed);
		expect(normalisePath(decomposed)).toBe(composed);
		expect(normalisePath(decomposed)).toBe(normalisePath(composed));
	});

	test('is idempotent', () => {
		const once = normalisePath('/notes//Café/a.md');
		expect(normalisePath(once)).toBe(once);
	});
});

describe('isValidVaultPath', () => {
	test('accepts an ordinary note path', () => {
		expect(isValidVaultPath('notes/today.md')).toBe(true);
	});

	test('rejects an empty path', () => {
		expect(isValidVaultPath('')).toBe(false);
	});

	test('rejects parent-directory traversal', () => {
		expect(isValidVaultPath('../outside.md')).toBe(false);
		expect(isValidVaultPath('notes/../../outside.md')).toBe(false);
	});

	test('rejects a null byte', () => {
		expect(isValidVaultPath('notes/bad .md')).toBe(false);
	});

	test('rejects a path that normalises to nothing', () => {
		expect(isValidVaultPath('/')).toBe(false);
	});
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm vitest run packages/protocol/src/paths.test.ts`
Expected: FAIL — `Failed to resolve import "./paths.js"`.

- [ ] **Step 6: Write the implementation**

`packages/protocol/src/paths.ts`:
```typescript
/**
 * Canonical vault path form: forward slashes, no leading or trailing slash,
 * no repeated slashes, NFC-normalised.
 *
 * NFC is load-bearing, not cosmetic. macOS and iOS return decomposed (NFD)
 * filenames from the filesystem while Linux and Android return composed ones,
 * so the same note on two platforms would otherwise hash to two different
 * fileIds and sync as two separate files.
 */
export function normalisePath(rawPath: string): string {
	return rawPath
		.replaceAll('\\', '/')
		.split('/')
		.filter((segment) => segment.length > 0)
		.join('/')
		.normalize('NFC');
}

export function isValidVaultPath(rawPath: string): boolean {
	if (rawPath.includes(' ')) {
		return false;
	}

	const normalised = normalisePath(rawPath);
	if (normalised.length === 0) {
		return false;
	}

	return !normalised.split('/').some((segment) => segment === '.' || segment === '..');
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run packages/protocol/src/paths.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 8: Verify lint and types are clean**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json biome.json vitest.config.ts .gitignore packages/protocol
git commit -m "feat: scaffold workspace and add NFC path normalisation"
```

---

## Task 2: Protocol constants, wire types and validators

**Files:**
- Create: `packages/protocol/src/constants.ts`
- Create: `packages/protocol/src/wire.ts`
- Create: `packages/protocol/src/validate.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/validate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: constants `protocolVersion`, `defaultChunkBytes`, `maxChunkBytes`, `nonceBytes`, `tagBytes`, `keyBytes`, `pbkdf2Iterations`, `kdfSaltBytes`, `blobAddressPattern`, `fileIdPattern`, `versionIdPattern`; types `ChangeKind`, `ChangeEntry`, `ChangesResponse`, `CommitVersionRequest`, `CommitVersionResponse`, `ConflictResponse`, `BlobCheckRequest`, `BlobCheckResponse`, `FileState`, `VaultStateResponse`, `VaultSummary`, `MeResponse`, `CreateVaultRequest`, `VersionSummary`, `VersionsResponse`; guards `isCommitVersionRequest`, `isBlobCheckRequest`, `isCreateVaultRequest`.

Runtime guards are hand-written rather than schema-generated because this package is bundled into the Obsidian plugin, where every kilobyte ships to a phone. A validation library would be the largest dependency in the mobile bundle.

- [ ] **Step 1: Write the constants**

`packages/protocol/src/constants.ts`:
```typescript
export const protocolVersion = 1;

export const defaultChunkBytes = 4 * 1024 * 1024;
export const maxChunkBytes = 16 * 1024 * 1024;

export const nonceBytes = 12;
export const tagBytes = 16;
export const keyBytes = 32;

export const pbkdf2Iterations = 650_000;
export const kdfSaltBytes = 16;

/** Hex-encoded HMAC-SHA-256 output. */
export const blobAddressPattern = /^[0-9a-f]{64}$/;
/** Hex-encoded HMAC-SHA-256 output. */
export const fileIdPattern = /^[0-9a-f]{64}$/;
/** UUID v4, as produced by randomUUID(). */
export const versionIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
```

- [ ] **Step 2: Write the wire types**

`packages/protocol/src/wire.ts`:
```typescript
export type ChangeKind = 'upsert' | 'delete';

export interface ChangeEntry {
	seq: number;
	fileId: string;
	kind: ChangeKind;
	versionId: string | undefined;
	size: number;
	createdAt: number;
}

export interface ChangesResponse {
	changes: ChangeEntry[];
	seq: number;
	hasMore: boolean;
}

export interface CommitVersionRequest {
	/** Version this client believes is current; omitted when creating the file. */
	parentVersion: string | undefined;
	/** Base64 of the encrypted metadata envelope: path, mtime, ctime, mime. */
	metaBlob: string;
	/** Ordered blob addresses. Empty for a zero-byte file. */
	chunks: string[];
	/** Plaintext byte length, for display and quota only. */
	size: number;
	deviceId: string;
}

export interface CommitVersionResponse {
	versionId: string;
	seq: number;
}

export interface ConflictResponse {
	error: 'conflict';
	/** The version the server actually holds; undefined when the file is deleted. */
	headVersion: string | undefined;
}

export interface BlobCheckRequest {
	addresses: string[];
}

export interface BlobCheckResponse {
	/** Subset of the requested addresses the server does not hold. */
	missing: string[];
}

export interface FileState {
	fileId: string;
	headVersion: string;
	metaBlob: string;
	size: number;
	updatedSeq: number;
}

export interface VaultStateResponse {
	files: FileState[];
	seq: number;
}

export interface VaultSummary {
	id: string;
	name: string;
	/** Base64 of the per-vault PBKDF2 salt. Not secret. */
	kdfSalt: string;
}

export interface MeResponse {
	user: string;
	vaults: VaultSummary[];
	protocolVersion: number;
}

export interface CreateVaultRequest {
	name: string;
}

export interface VersionSummary {
	versionId: string;
	parentVersion: string | undefined;
	size: number;
	deviceId: string;
	createdAt: number;
}

export interface VersionsResponse {
	versions: VersionSummary[];
}
```

- [ ] **Step 3: Write the failing test**

`packages/protocol/src/validate.test.ts`:
```typescript
import { describe, expect, test } from 'vitest';
import { isBlobCheckRequest, isCommitVersionRequest, isCreateVaultRequest } from './validate.js';

const validAddress = 'a'.repeat(64);
const validVersion = '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

function validCommit(): Record<string, unknown> {
	return {
		parentVersion: validVersion,
		metaBlob: 'AAAA',
		chunks: [validAddress],
		size: 42,
		deviceId: 'device-1',
	};
}

describe('isCommitVersionRequest', () => {
	test('accepts a well-formed body', () => {
		expect(isCommitVersionRequest(validCommit())).toBe(true);
	});

	test('accepts an omitted parentVersion for a new file', () => {
		expect(isCommitVersionRequest({ ...validCommit(), parentVersion: undefined })).toBe(true);
	});

	test('accepts an empty chunk list for a zero-byte file', () => {
		expect(isCommitVersionRequest({ ...validCommit(), chunks: [], size: 0 })).toBe(true);
	});

	test('rejects a non-object', () => {
		expect(isCommitVersionRequest('nope')).toBe(false);
		expect(isCommitVersionRequest(undefined)).toBe(false);
		expect(isCommitVersionRequest([])).toBe(false);
	});

	test('rejects a malformed blob address', () => {
		expect(isCommitVersionRequest({ ...validCommit(), chunks: ['zz'] })).toBe(false);
	});

	test('rejects a malformed parentVersion', () => {
		expect(isCommitVersionRequest({ ...validCommit(), parentVersion: 'not-a-uuid' })).toBe(false);
	});

	test('rejects a negative size', () => {
		expect(isCommitVersionRequest({ ...validCommit(), size: -1 })).toBe(false);
	});

	test('rejects a fractional size', () => {
		expect(isCommitVersionRequest({ ...validCommit(), size: 1.5 })).toBe(false);
	});

	test('rejects an empty deviceId', () => {
		expect(isCommitVersionRequest({ ...validCommit(), deviceId: '' })).toBe(false);
	});
});

describe('isBlobCheckRequest', () => {
	test('accepts a list of addresses', () => {
		expect(isBlobCheckRequest({ addresses: [validAddress] })).toBe(true);
	});

	test('accepts an empty list', () => {
		expect(isBlobCheckRequest({ addresses: [] })).toBe(true);
	});

	test('rejects a malformed address', () => {
		expect(isBlobCheckRequest({ addresses: ['nope'] })).toBe(false);
	});

	test('rejects a missing addresses field', () => {
		expect(isBlobCheckRequest({})).toBe(false);
	});
});

describe('isCreateVaultRequest', () => {
	test('accepts a plain name', () => {
		expect(isCreateVaultRequest({ name: 'personal' })).toBe(true);
	});

	test('rejects an empty name', () => {
		expect(isCreateVaultRequest({ name: '' })).toBe(false);
	});

	test('rejects a name over 64 characters', () => {
		expect(isCreateVaultRequest({ name: 'x'.repeat(65) })).toBe(false);
	});
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run packages/protocol/src/validate.test.ts`
Expected: FAIL — `Failed to resolve import "./validate.js"`.

- [ ] **Step 5: Write the validators**

`packages/protocol/src/validate.ts`:
```typescript
import { blobAddressPattern, versionIdPattern } from './constants.js';
import type { BlobCheckRequest, CommitVersionRequest, CreateVaultRequest } from './wire.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isAddressList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === 'string' && blobAddressPattern.test(entry))
	);
}

export function isCommitVersionRequest(body: unknown): body is CommitVersionRequest {
	const record = asRecord(body);
	if (record === undefined) {
		return false;
	}

	const { parentVersion, metaBlob, chunks, size, deviceId } = record;

	if (parentVersion !== undefined) {
		if (typeof parentVersion !== 'string' || !versionIdPattern.test(parentVersion)) {
			return false;
		}
	}

	return (
		isNonEmptyString(metaBlob) &&
		isAddressList(chunks) &&
		typeof size === 'number' &&
		Number.isInteger(size) &&
		size >= 0 &&
		isNonEmptyString(deviceId)
	);
}

export function isBlobCheckRequest(body: unknown): body is BlobCheckRequest {
	const record = asRecord(body);
	if (record === undefined) {
		return false;
	}
	return isAddressList(record.addresses);
}

export function isCreateVaultRequest(body: unknown): body is CreateVaultRequest {
	const record = asRecord(body);
	if (record === undefined) {
		return false;
	}
	return isNonEmptyString(record.name) && record.name.length <= 64;
}
```

- [ ] **Step 6: Write the barrel export**

`packages/protocol/src/index.ts`:
```typescript
export * from './constants.js';
export * from './envelope.js';
export * from './paths.js';
export * from './validate.js';
export * from './wire.js';
```

`./envelope.js` arrives in Task 3, so `pnpm build` fails until then. Tests in this task import modules directly and are unaffected.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run packages/protocol/src/validate.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src
git commit -m "feat: add protocol constants, wire types and runtime validators"
```

---

## Task 3: Encrypted blob envelope format

The envelope is the one binary contract shared by client and server. The server never parses it — but it is defined here, in shared code, so both plugin implementations (encrypt on push, decrypt on pull) cannot drift.

**Files:**
- Create: `packages/protocol/src/envelope.ts`
- Test: `packages/protocol/src/envelope.test.ts`

**Interfaces:**
- Consumes: `nonceBytes`, `tagBytes`, `protocolVersion` from `./constants.js`.
- Produces: `encodeEnvelope(nonce: Uint8Array, ciphertextWithTag: Uint8Array): Uint8Array`, `decodeEnvelope(blob: Uint8Array): { version: number; nonce: Uint8Array; ciphertextWithTag: Uint8Array }`, `envelopeOverheadBytes: number`, class `EnvelopeFormatError extends Error`.

Layout, little-endian, no padding:

```
offset 0        1 byte   format version
offset 1        12 bytes AES-GCM nonce
offset 13       N bytes  ciphertext followed by its 16-byte GCM tag
```

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/envelope.test.ts`:
```typescript
import { describe, expect, test } from 'vitest';
import { protocolVersion } from './constants.js';
import { EnvelopeFormatError, decodeEnvelope, encodeEnvelope, envelopeOverheadBytes } from './envelope.js';

function bytes(length: number, fill: number): Uint8Array {
	return new Uint8Array(length).fill(fill);
}

describe('encodeEnvelope', () => {
	test('prefixes the version byte and nonce', () => {
		const blob = encodeEnvelope(bytes(12, 7), bytes(20, 9));
		expect(blob[0]).toBe(protocolVersion);
		expect(blob.subarray(1, 13)).toEqual(bytes(12, 7));
		expect(blob.subarray(13)).toEqual(bytes(20, 9));
	});

	test('adds exactly the declared overhead', () => {
		const blob = encodeEnvelope(bytes(12, 0), bytes(100, 0));
		expect(blob.length).toBe(100 + envelopeOverheadBytes);
	});

	test('rejects a wrong-length nonce', () => {
		expect(() => encodeEnvelope(bytes(11, 0), bytes(20, 0))).toThrow(EnvelopeFormatError);
	});

	test('rejects a payload shorter than the GCM tag', () => {
		expect(() => encodeEnvelope(bytes(12, 0), bytes(15, 0))).toThrow(EnvelopeFormatError);
	});
});

describe('decodeEnvelope', () => {
	test('round-trips an encoded envelope', () => {
		const nonce = bytes(12, 3);
		const payload = bytes(64, 5);
		const decoded = decodeEnvelope(encodeEnvelope(nonce, payload));
		expect(decoded.version).toBe(protocolVersion);
		expect(decoded.nonce).toEqual(nonce);
		expect(decoded.ciphertextWithTag).toEqual(payload);
	});

	test('rejects a blob too short to contain a tag', () => {
		expect(() => decodeEnvelope(bytes(20, 0))).toThrow(EnvelopeFormatError);
	});

	test('rejects an unknown format version', () => {
		const blob = encodeEnvelope(bytes(12, 0), bytes(20, 0));
		blob[0] = 99;
		expect(() => decodeEnvelope(blob)).toThrow(/unsupported envelope version 99/);
	});

	test('returns views that do not alias mutable input', () => {
		const nonce = bytes(12, 1);
		const blob = encodeEnvelope(nonce, bytes(20, 2));
		const decoded = decodeEnvelope(blob);
		blob[1] = 200;
		expect(decoded.nonce[0]).toBe(1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/protocol/src/envelope.test.ts`
Expected: FAIL — `Failed to resolve import "./envelope.js"`.

- [ ] **Step 3: Write the implementation**

`packages/protocol/src/envelope.ts`:
```typescript
import { nonceBytes, protocolVersion, tagBytes } from './constants.js';

export class EnvelopeFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EnvelopeFormatError';
	}
}

const versionOffset = 0;
const nonceOffset = 1;
const payloadOffset = nonceOffset + nonceBytes;

export const envelopeOverheadBytes = payloadOffset;

export function encodeEnvelope(nonce: Uint8Array, ciphertextWithTag: Uint8Array): Uint8Array {
	if (nonce.length !== nonceBytes) {
		throw new EnvelopeFormatError(`nonce must be ${nonceBytes} bytes, received ${nonce.length}`);
	}
	if (ciphertextWithTag.length < tagBytes) {
		throw new EnvelopeFormatError(
			`payload must include a ${tagBytes}-byte tag, received ${ciphertextWithTag.length} bytes`,
		);
	}

	const blob = new Uint8Array(payloadOffset + ciphertextWithTag.length);
	blob[versionOffset] = protocolVersion;
	blob.set(nonce, nonceOffset);
	blob.set(ciphertextWithTag, payloadOffset);
	return blob;
}

export function decodeEnvelope(blob: Uint8Array): {
	version: number;
	nonce: Uint8Array;
	ciphertextWithTag: Uint8Array;
} {
	if (blob.length < payloadOffset + tagBytes) {
		throw new EnvelopeFormatError(
			`blob must be at least ${payloadOffset + tagBytes} bytes, received ${blob.length}`,
		);
	}

	const version = blob[versionOffset] ?? 0;
	if (version !== protocolVersion) {
		throw new EnvelopeFormatError(`unsupported envelope version ${version}`);
	}

	// Copied rather than subarray'd so a later mutation of the source buffer
	// cannot silently corrupt an in-flight decryption.
	return {
		version,
		nonce: blob.slice(nonceOffset, payloadOffset),
		ciphertextWithTag: blob.slice(payloadOffset),
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/protocol/src/envelope.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Verify the package builds**

Run: `pnpm --filter @obsidian-sync/protocol build && pnpm lint`
Expected: `dist/` emitted, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src
git commit -m "feat: add versioned encrypted blob envelope format"
```

---

## Task 4: Server configuration and user registry

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`
- Create: `packages/server/src/config.ts`
- Create: `packages/server/src/users.ts`
- Test: `packages/server/src/config.test.ts`, `packages/server/src/users.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface ServerConfig`, `loadConfig(env: Record<string, string | undefined>): ServerConfig`, `class ConfigError extends Error`, `interface UserRegistry { findByToken(token: string): string | undefined; usernames(): string[] }`, `buildUserRegistry(env: Record<string, string | undefined>): UserRegistry`.

Token comparison is constant-time. Because `timingSafeEqual` requires equal-length inputs — and unequal lengths would themselves leak — both sides are SHA-256 hashed first, which fixes the length at 32 bytes.

- [ ] **Step 1: Create the server package files**

`packages/server/package.json`:
```json
{
  "name": "@obsidian-sync/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@fastify/websocket": "^11.0.2",
    "@obsidian-sync/protocol": "workspace:*",
    "close-with-grace": "^2.2.0",
    "fastify": "^5.6.0"
  }
}
```

`packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing user registry test**

`packages/server/src/users.test.ts`:
```typescript
import { describe, expect, test } from 'vitest';
import { ConfigError } from './config.js';
import { buildUserRegistry } from './users.js';

const strongToken = 'a'.repeat(40);
const otherToken = 'b'.repeat(40);

describe('buildUserRegistry', () => {
	test('lowercases the username from the variable suffix', () => {
		const registry = buildUserRegistry({ SYNC_USER_ALICE: strongToken });
		expect(registry.usernames()).toEqual(['alice']);
		expect(registry.findByToken(strongToken)).toBe('alice');
	});

	test('registers several users', () => {
		const registry = buildUserRegistry({
			SYNC_USER_ALICE: strongToken,
			SYNC_USER_BOB: otherToken,
		});
		expect(registry.usernames().sort()).toEqual(['alice', 'bob']);
		expect(registry.findByToken(otherToken)).toBe('bob');
	});

	test('ignores unrelated environment variables', () => {
		const registry = buildUserRegistry({ SYNC_USER_ALICE: strongToken, PATH: '/usr/bin' });
		expect(registry.usernames()).toEqual(['alice']);
	});

	test('returns undefined for an unknown token', () => {
		const registry = buildUserRegistry({ SYNC_USER_ALICE: strongToken });
		expect(registry.findByToken(otherToken)).toBeUndefined();
	});

	test('returns undefined for an empty token', () => {
		const registry = buildUserRegistry({ SYNC_USER_ALICE: strongToken });
		expect(registry.findByToken('')).toBeUndefined();
	});

	test('rejects a token shorter than 32 characters', () => {
		expect(() => buildUserRegistry({ SYNC_USER_ALICE: 'short' })).toThrow(ConfigError);
	});

	test('rejects two users sharing one token', () => {
		expect(() =>
			buildUserRegistry({ SYNC_USER_ALICE: strongToken, SYNC_USER_BOB: strongToken }),
		).toThrow(/duplicate token/);
	});

	test('rejects usernames that collide after lowercasing', () => {
		expect(() =>
			buildUserRegistry({ SYNC_USER_ALICE: strongToken, SYNC_USER_alice: otherToken }),
		).toThrow(/collides/);
	});

	test('rejects a username with characters outside the allowed set', () => {
		expect(() => buildUserRegistry({ 'SYNC_USER_A.B': strongToken })).toThrow(/invalid username/);
	});

	test('rejects an empty registry, since nobody could authenticate', () => {
		expect(() => buildUserRegistry({})).toThrow(/no users configured/);
	});

	test('never places a token in the error message', () => {
		try {
			buildUserRegistry({ SYNC_USER_ALICE: 'short' });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect((error as Error).message).not.toContain('short');
		}
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/users.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 4: Write the config error type and config loader**

`packages/server/src/config.ts`:
```typescript
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

export interface ServerConfig {
	port: number;
	host: string;
	dataDir: string;
	maxBlobBytes: number;
	longpollMaxWaitMs: number;
	versionRetentionDays: number;
	versionRetentionMin: number;
	orphanBlobGraceMs: number;
	logLevel: string;
}

function readInteger(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	minimum: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === '') {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < minimum) {
		throw new ConfigError(`${name} must be an integer of at least ${minimum}, received "${raw}"`);
	}
	return parsed;
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
	const logLevel = env.LOG_LEVEL ?? 'info';
	const allowedLogLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
	if (!allowedLogLevels.includes(logLevel)) {
		throw new ConfigError(`LOG_LEVEL must be one of ${allowedLogLevels.join(', ')}`);
	}

	return {
		port: readInteger(env, 'PORT', 3000, 1),
		host: env.HOST ?? '0.0.0.0',
		dataDir: env.DATA_DIR ?? '/data',
		maxBlobBytes: readInteger(env, 'MAX_BLOB_BYTES', 8 * 1024 * 1024, 1024),
		longpollMaxWaitMs: readInteger(env, 'LONGPOLL_MAX_WAIT_MS', 25_000, 1000),
		versionRetentionDays: readInteger(env, 'VERSION_RETENTION_DAYS', 90, 1),
		versionRetentionMin: readInteger(env, 'VERSION_RETENTION_MIN', 10, 1),
		// An uploaded blob has refcount 0 until its version commits. The sweep must
		// not reclaim one mid-upload, so it ignores anything younger than this.
		orphanBlobGraceMs: readInteger(env, 'ORPHAN_BLOB_GRACE_MS', 24 * 60 * 60 * 1000, 60_000),
		logLevel,
	};
}
```

- [ ] **Step 5: Write the user registry**

`packages/server/src/users.ts`:
```typescript
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/users.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 7: Write the config test**

`packages/server/src/config.test.ts`:
```typescript
import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
	test('applies documented defaults for an empty environment', () => {
		const config = loadConfig({});
		expect(config.port).toBe(3000);
		expect(config.host).toBe('0.0.0.0');
		expect(config.dataDir).toBe('/data');
		expect(config.maxBlobBytes).toBe(8 * 1024 * 1024);
		expect(config.longpollMaxWaitMs).toBe(25_000);
		expect(config.versionRetentionDays).toBe(90);
		expect(config.versionRetentionMin).toBe(10);
		expect(config.logLevel).toBe('info');
	});

	test('reads overrides from the environment', () => {
		const config = loadConfig({ PORT: '8080', DATA_DIR: '/srv/sync', LOG_LEVEL: 'debug' });
		expect(config.port).toBe(8080);
		expect(config.dataDir).toBe('/srv/sync');
		expect(config.logLevel).toBe('debug');
	});

	test('treats an empty string as absent', () => {
		expect(loadConfig({ PORT: '' }).port).toBe(3000);
	});

	test('rejects a non-numeric integer setting', () => {
		expect(() => loadConfig({ PORT: 'eighty' })).toThrow(ConfigError);
	});

	test('rejects a fractional integer setting', () => {
		expect(() => loadConfig({ PORT: '80.5' })).toThrow(/must be an integer/);
	});

	test('rejects a value below the allowed minimum', () => {
		expect(() => loadConfig({ LONGPOLL_MAX_WAIT_MS: '10' })).toThrow(/at least 1000/);
	});

	test('rejects an unknown log level', () => {
		expect(() => loadConfig({ LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL must be one of/);
	});
});
```

- [ ] **Step 8: Run the full suite**

Run: `pnpm vitest run packages/server/src && pnpm lint && pnpm typecheck`
Expected: PASS — 18 tests, no lint or type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat: add server configuration and constant-time user registry"
```

---

## Task 5: SQLite schema and database lifecycle

**Files:**
- Create: `packages/server/src/db/schema.ts`
- Create: `packages/server/src/db/database.ts`
- Test: `packages/server/src/db/database.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `openDatabase(filePath: string): DatabaseSync`, `closeDatabase(db: DatabaseSync): void`, `currentSchemaVersion: number`, `migrations: readonly string[]`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/db/database.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, currentSchemaVersion, openDatabase } from './database.js';

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-db-'));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('openDatabase', () => {
	test('creates the file and stamps the schema version', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
		expect(row.user_version).toBe(currentSchemaVersion);
		closeDatabase(db);
	});

	test('enables write-ahead logging', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
		expect(row.journal_mode).toBe('wal');
		closeDatabase(db);
	});

	test('enforces foreign keys', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
		expect(row.foreign_keys).toBe(1);
		closeDatabase(db);
	});

	test('creates every expected table', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		const names = (
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((row) => row.name);
		for (const expected of ['vault', 'device', 'file', 'version', 'change_log', 'blob_ref']) {
			expect(names).toContain(expected);
		}
		closeDatabase(db);
	});

	test('is idempotent when reopening an existing database', () => {
		const path = join(directory, 'sync.db');
		closeDatabase(openDatabase(path));
		const db = openDatabase(path);
		const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
		expect(row.user_version).toBe(currentSchemaVersion);
		closeDatabase(db);
	});

	test('assigns change_log sequence numbers monotonically', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		db.prepare(
			'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
		).run('v1', 'personal', 'alice', Buffer.alloc(16), 0);

		const insert = db.prepare(
			'INSERT INTO change_log (vault_id, file_id, version_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
		);
		const first = insert.run('v1', 'f1', null, 'upsert', 0, 0).lastInsertRowid;
		const second = insert.run('v1', 'f2', null, 'upsert', 0, 0).lastInsertRowid;
		expect(Number(second)).toBeGreaterThan(Number(first));
		closeDatabase(db);
	});

	test('rejects a change_log row for an unknown vault', () => {
		const db = openDatabase(join(directory, 'sync.db'));
		expect(() =>
			db
				.prepare(
					'INSERT INTO change_log (vault_id, file_id, version_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
				)
				.run('ghost', 'f1', null, 'upsert', 0, 0),
		).toThrow();
		closeDatabase(db);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/db/database.test.ts`
Expected: FAIL — `Failed to resolve import "./database.js"`.

- [ ] **Step 3: Write the schema**

`packages/server/src/db/schema.ts`:
```typescript
export const currentSchemaVersion = 1;

const initialSchema = `
CREATE TABLE vault (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner      TEXT NOT NULL,
  kdf_salt   BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner, name)
);

CREATE TABLE device (
  id            TEXT NOT NULL,
  vault_id      TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  platform      TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (vault_id, id)
);

CREATE TABLE file (
  vault_id     TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL,
  head_version TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0,
  updated_seq  INTEGER NOT NULL,
  PRIMARY KEY (vault_id, file_id)
);
CREATE INDEX file_vault_updated ON file (vault_id, updated_seq);

CREATE TABLE version (
  vault_id       TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  file_id        TEXT NOT NULL,
  version_id     TEXT NOT NULL,
  parent_version TEXT,
  meta_blob      TEXT NOT NULL,
  chunks         TEXT NOT NULL,
  size           INTEGER NOT NULL,
  device_id      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (vault_id, file_id, version_id)
);
CREATE INDEX version_file_created ON version (vault_id, file_id, created_at);

CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id   TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL,
  version_id TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX change_log_vault_seq ON change_log (vault_id, seq);

CREATE TABLE blob_ref (
  vault_id TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  addr     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  refcount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, addr)
);
CREATE INDEX blob_ref_reclaimable ON blob_ref (vault_id, refcount);
`;

/** Index N holds the migration that raises the schema from version N to N+1. */
export const migrations: readonly string[] = [initialSchema];
```

`meta_blob` and `chunks` are `TEXT` because they arrive base64-encoded and JSON-encoded respectively and are handed back to clients unchanged. The server never decodes either — decoding would be the first step toward a code path that assumes it can read content.

`AUTOINCREMENT` on `change_log.seq` is deliberate and not merely `INTEGER PRIMARY KEY`. Plain rowid reuses the identifiers of deleted rows, which would make a client's stored cursor point into the past after retention pruning.

- [ ] **Step 4: Write the database lifecycle module**

`packages/server/src/db/database.ts`:
```typescript
import { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion, migrations } from './schema.js';

export { currentSchemaVersion, migrations };

export function openDatabase(filePath: string): DatabaseSync {
	const db = new DatabaseSync(filePath);

	db.exec('PRAGMA journal_mode = WAL');
	// NORMAL can lose the most recent transaction on power loss but never corrupts.
	// A lost commit is recoverable: the client's next reconcile re-pushes it.
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec('PRAGMA busy_timeout = 5000');

	const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
		user_version: number;
	};

	if (version > currentSchemaVersion) {
		db.close();
		throw new Error(
			`database schema version ${version} is newer than this server supports (${currentSchemaVersion}); upgrade the server`,
		);
	}

	for (let step = version; step < currentSchemaVersion; step += 1) {
		const migration = migrations[step];
		if (migration === undefined) {
			db.close();
			throw new Error(`missing migration from schema version ${step}`);
		}
		db.exec('BEGIN');
		try {
			db.exec(migration);
			db.exec(`PRAGMA user_version = ${step + 1}`);
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			db.close();
			throw error;
		}
	}

	return db;
}

export function closeDatabase(db: DatabaseSync): void {
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	db.close();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/db/database.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db
git commit -m "feat: add SQLite schema and database lifecycle with migrations"
```

---

## Task 6: Serialised write queue

SQLite in WAL mode allows one writer. Fastify handles requests concurrently, so without serialisation two commits can interleave between the `SELECT` that reads the current head and the `INSERT` that replaces it — and the optimistic-concurrency check in Task 12 silently stops working. This queue is what makes that check sound.

**Files:**
- Create: `packages/server/src/db/writer.ts`
- Test: `packages/server/src/db/writer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class SerialWriter { run<T>(operation: () => T): Promise<T> }`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/db/writer.test.ts`:
```typescript
import { describe, expect, test } from 'vitest';
import { SerialWriter } from './writer.js';

describe('SerialWriter', () => {
	test('returns the operation result', async () => {
		const writer = new SerialWriter();
		await expect(writer.run(() => 42)).resolves.toBe(42);
	});

	test('never overlaps two operations', async () => {
		const writer = new SerialWriter();
		let active = 0;
		let maximumActive = 0;

		const operation = () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			active -= 1;
			return undefined;
		};

		await Promise.all(Array.from({ length: 50 }, () => writer.run(operation)));
		expect(maximumActive).toBe(1);
	});

	test('preserves submission order', async () => {
		const writer = new SerialWriter();
		const order: number[] = [];
		await Promise.all(
			[1, 2, 3, 4, 5].map((value) =>
				writer.run(() => {
					order.push(value);
					return undefined;
				}),
			),
		);
		expect(order).toEqual([1, 2, 3, 4, 5]);
	});

	test('propagates a thrown error to that caller only', async () => {
		const writer = new SerialWriter();
		await expect(
			writer.run(() => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
	});

	// A rejected tail promise must not poison every later submission.
	test('keeps accepting work after a failure', async () => {
		const writer = new SerialWriter();
		await expect(
			writer.run(() => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		await expect(writer.run(() => 'still working')).resolves.toBe('still working');
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/db/writer.test.ts`
Expected: FAIL — `Failed to resolve import "./writer.js"`.

- [ ] **Step 3: Write the implementation**

`packages/server/src/db/writer.ts`:
```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/db/writer.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/writer.ts packages/server/src/db/writer.test.ts
git commit -m "feat: add serialised write queue for SQLite mutations"
```

---

## Task 7: Content-addressed blob store

**Files:**
- Create: `packages/server/src/blobs.ts`
- Test: `packages/server/src/blobs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface BlobStore { has(vaultId, address): Promise<boolean>; put(vaultId, address, data): Promise<void>; get(vaultId, address): Promise<Uint8Array | undefined>; remove(vaultId, address): Promise<void>; writtenAt(vaultId, address): Promise<number | undefined> }`, `createBlobStore(rootDir: string): BlobStore`, `class BlobStoreError extends Error`.

All identifiers are hex-validated by the route layer before reaching here, but `put` re-checks, because a path built from an unvalidated address is a directory traversal.

- [ ] **Step 1: Write the failing test**

`packages/server/src/blobs.test.ts`:
```typescript
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type BlobStore, BlobStoreError, createBlobStore } from './blobs.js';

const address = 'ab'.padEnd(64, 'c');
const otherAddress = 'de'.padEnd(64, 'f');
const payload = new Uint8Array([1, 2, 3, 4]);

let directory: string;
let store: BlobStore;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-blobs-'));
	store = createBlobStore(directory);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('BlobStore', () => {
	test('reports an absent blob', async () => {
		await expect(store.has('v1', address)).resolves.toBe(false);
		await expect(store.get('v1', address)).resolves.toBeUndefined();
	});

	test('stores and reads back a blob', async () => {
		await store.put('v1', address, payload);
		await expect(store.has('v1', address)).resolves.toBe(true);
		await expect(store.get('v1', address)).resolves.toEqual(payload);
	});

	test('shards by the first two address characters', async () => {
		await store.put('v1', address, payload);
		await expect(readdir(join(directory, 'v1'))).resolves.toEqual(['ab']);
	});

	test('isolates vaults from each other', async () => {
		await store.put('v1', address, payload);
		await expect(store.has('v2', address)).resolves.toBe(false);
	});

	test('is idempotent when the same blob is written twice', async () => {
		await store.put('v1', address, payload);
		await store.put('v1', address, payload);
		await expect(store.get('v1', address)).resolves.toEqual(payload);
	});

	test('leaves no temporary files behind', async () => {
		await store.put('v1', address, payload);
		const shard = await readdir(join(directory, 'v1', 'ab'));
		expect(shard).toEqual([address]);
	});

	test('removes a blob', async () => {
		await store.put('v1', address, payload);
		await store.remove('v1', address);
		await expect(store.has('v1', address)).resolves.toBe(false);
	});

	test('tolerates removing an absent blob', async () => {
		await expect(store.remove('v1', otherAddress)).resolves.toBeUndefined();
	});

	test('reports the write time of a stored blob', async () => {
		const before = Date.now();
		await store.put('v1', address, payload);
		const writtenAt = await store.writtenAt('v1', address);
		expect(writtenAt).toBeGreaterThanOrEqual(before - 2000);
	});

	test('reports undefined write time for an absent blob', async () => {
		await expect(store.writtenAt('v1', address)).resolves.toBeUndefined();
	});

	test('rejects an address that is not 64 hex characters', async () => {
		await expect(store.put('v1', 'nope', payload)).rejects.toThrow(BlobStoreError);
		await expect(store.has('v1', '../escape')).resolves.toBe(false);
	});

	test('rejects a vault id containing a path separator', async () => {
		await expect(store.put('../escape', address, payload)).rejects.toThrow(BlobStoreError);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/blobs.test.ts`
Expected: FAIL — `Failed to resolve import "./blobs.js"`.

- [ ] **Step 3: Write the implementation**

`packages/server/src/blobs.ts`:
```typescript
import { open, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const addressPattern = /^[0-9a-f]{64}$/;
const vaultIdPattern = /^[0-9a-zA-Z_-]+$/;

export class BlobStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BlobStoreError';
	}
}

export interface BlobStore {
	has(vaultId: string, address: string): Promise<boolean>;
	put(vaultId: string, address: string, data: Uint8Array): Promise<void>;
	get(vaultId: string, address: string): Promise<Uint8Array | undefined>;
	remove(vaultId: string, address: string): Promise<void>;
	writtenAt(vaultId: string, address: string): Promise<number | undefined>;
}

function assertSafe(vaultId: string, address: string): void {
	if (!vaultIdPattern.test(vaultId)) {
		throw new BlobStoreError(`invalid vault id "${vaultId}"`);
	}
	if (!addressPattern.test(address)) {
		throw new BlobStoreError('blob address must be 64 lowercase hex characters');
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function createBlobStore(rootDir: string): BlobStore {
	const shardDir = (vaultId: string, address: string): string =>
		join(rootDir, vaultId, address.slice(0, 2));

	const blobPath = (vaultId: string, address: string): string =>
		join(shardDir(vaultId, address), address);

	return {
		async has(vaultId, address) {
			if (!vaultIdPattern.test(vaultId) || !addressPattern.test(address)) {
				return false;
			}
			try {
				await stat(blobPath(vaultId, address));
				return true;
			} catch (error) {
				if (isMissing(error)) {
					return false;
				}
				throw error;
			}
		},

		async put(vaultId, address, data) {
			assertSafe(vaultId, address);

			const directory = shardDir(vaultId, address);
			await mkdir(directory, { recursive: true });

			// Write to a temporary name, fsync, then rename. Rename is atomic within
			// a directory, so a reader never observes a partially written blob and a
			// crash leaves at most a stray temp file.
			const temporaryPath = join(directory, `.tmp-${randomUUID()}`);
			const handle = await open(temporaryPath, 'w');
			try {
				await handle.writeFile(data);
				await handle.sync();
			} finally {
				await handle.close();
			}

			try {
				await rename(temporaryPath, blobPath(vaultId, address));
			} catch (error) {
				await rm(temporaryPath, { force: true });
				throw error;
			}
		},

		async get(vaultId, address) {
			if (!vaultIdPattern.test(vaultId) || !addressPattern.test(address)) {
				return undefined;
			}
			try {
				return new Uint8Array(await readFile(blobPath(vaultId, address)));
			} catch (error) {
				if (isMissing(error)) {
					return undefined;
				}
				throw error;
			}
		},

		async remove(vaultId, address) {
			if (!vaultIdPattern.test(vaultId) || !addressPattern.test(address)) {
				return;
			}
			await rm(blobPath(vaultId, address), { force: true });
		},

		async writtenAt(vaultId, address) {
			if (!vaultIdPattern.test(vaultId) || !addressPattern.test(address)) {
				return undefined;
			}
			try {
				return (await stat(blobPath(vaultId, address))).mtimeMs;
			} catch (error) {
				if (isMissing(error)) {
					return undefined;
				}
				throw error;
			}
		},
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/blobs.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/blobs.ts packages/server/src/blobs.test.ts
git commit -m "feat: add content-addressed blob store with atomic writes"
```

---

## Task 8: Change log and long-poll notifier

**Files:**
- Create: `packages/server/src/changes.ts`
- Test: `packages/server/src/changes.test.ts`

**Interfaces:**
- Consumes: `openDatabase` from `./db/database.js`; `ChangeEntry`, `ChangeKind` from `@obsidian-sync/protocol`.
- Produces: `appendChange(db: DatabaseSync, entry: { vaultId: string; fileId: string; versionId: string | undefined; kind: ChangeKind; size: number }): number`, `readChangesSince(db: DatabaseSync, vaultId: string, since: number, limit: number): { changes: ChangeEntry[]; hasMore: boolean }`, `latestSeq(db: DatabaseSync, vaultId: string): number`, `class ChangeNotifier { notify(vaultId: string): void; waitForChange(vaultId: string, timeoutMs: number): Promise<void>; waiterCount(vaultId: string): number }`.

`appendChange` is synchronous and must be called inside the caller's transaction, so a change row and the version row it describes commit together or not at all.

- [ ] **Step 1: Write the failing test**

`packages/server/src/changes.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ChangeNotifier, appendChange, latestSeq, readChangesSince } from './changes.js';
import { closeDatabase, openDatabase } from './db/database.js';

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-changes-'));
	db = openDatabase(join(directory, 'sync.db'));
	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run('v1', 'personal', 'alice', Buffer.alloc(16), Date.now());
	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run('v2', 'work', 'alice', Buffer.alloc(16), Date.now());
});

afterEach(async () => {
	closeDatabase(db);
	await rm(directory, { recursive: true, force: true });
});

describe('appendChange', () => {
	test('returns an increasing sequence number', () => {
		const first = appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: undefined,
			kind: 'upsert',
			size: 10,
		});
		const second = appendChange(db, {
			vaultId: 'v1',
			fileId: 'f2',
			versionId: undefined,
			kind: 'upsert',
			size: 20,
		});
		expect(second).toBeGreaterThan(first);
	});
});

describe('readChangesSince', () => {
	test('returns nothing for an empty vault', () => {
		expect(readChangesSince(db, 'v1', 0, 10).changes).toEqual([]);
	});

	test('returns changes after the cursor only', () => {
		const first = appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: 'ver-1',
			kind: 'upsert',
			size: 10,
		});
		appendChange(db, {
			vaultId: 'v1',
			fileId: 'f2',
			versionId: 'ver-2',
			kind: 'upsert',
			size: 20,
		});

		const result = readChangesSince(db, 'v1', first, 10);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.fileId).toBe('f2');
	});

	test('maps a SQL NULL version to undefined', () => {
		appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: undefined,
			kind: 'delete',
			size: 0,
		});
		expect(readChangesSince(db, 'v1', 0, 10).changes[0]?.versionId).toBeUndefined();
	});

	test('does not leak changes across vaults', () => {
		appendChange(db, {
			vaultId: 'v2',
			fileId: 'other',
			versionId: undefined,
			kind: 'upsert',
			size: 1,
		});
		expect(readChangesSince(db, 'v1', 0, 10).changes).toEqual([]);
	});

	test('flags more results when the limit is reached', () => {
		for (let index = 0; index < 5; index += 1) {
			appendChange(db, {
				vaultId: 'v1',
				fileId: `f${index}`,
				versionId: undefined,
				kind: 'upsert',
				size: 1,
			});
		}
		const result = readChangesSince(db, 'v1', 0, 2);
		expect(result.changes).toHaveLength(2);
		expect(result.hasMore).toBe(true);
	});

	test('does not flag more results on the final page', () => {
		appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: undefined,
			kind: 'upsert',
			size: 1,
		});
		expect(readChangesSince(db, 'v1', 0, 10).hasMore).toBe(false);
	});
});

describe('latestSeq', () => {
	test('is zero for a vault with no changes', () => {
		expect(latestSeq(db, 'v1')).toBe(0);
	});

	test('tracks the newest change', () => {
		const seq = appendChange(db, {
			vaultId: 'v1',
			fileId: 'f1',
			versionId: undefined,
			kind: 'upsert',
			size: 1,
		});
		expect(latestSeq(db, 'v1')).toBe(seq);
	});
});

describe('ChangeNotifier', () => {
	test('resolves a waiter when its vault is notified', async () => {
		const notifier = new ChangeNotifier();
		const waiting = notifier.waitForChange('v1', 5000);
		notifier.notify('v1');
		await expect(waiting).resolves.toBeUndefined();
	});

	test('resolves on timeout when nothing happens', async () => {
		const notifier = new ChangeNotifier();
		await expect(notifier.waitForChange('v1', 20)).resolves.toBeUndefined();
	});

	test('does not wake a waiter on a different vault', async () => {
		const notifier = new ChangeNotifier();
		let woken = false;
		const waiting = notifier.waitForChange('v1', 60).then(() => {
			woken = true;
		});
		notifier.notify('v2');
		expect(woken).toBe(false);
		await waiting;
	});

	test('wakes every waiter on the same vault', async () => {
		const notifier = new ChangeNotifier();
		const waiters = [
			notifier.waitForChange('v1', 5000),
			notifier.waitForChange('v1', 5000),
			notifier.waitForChange('v1', 5000),
		];
		expect(notifier.waiterCount('v1')).toBe(3);
		notifier.notify('v1');
		await expect(Promise.all(waiters)).resolves.toHaveLength(3);
	});

	// A leak here would grow without bound on a long-lived server.
	test('releases waiters after they settle', async () => {
		const notifier = new ChangeNotifier();
		await notifier.waitForChange('v1', 10);
		expect(notifier.waiterCount('v1')).toBe(0);

		const waiting = notifier.waitForChange('v1', 5000);
		notifier.notify('v1');
		await waiting;
		expect(notifier.waiterCount('v1')).toBe(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/changes.test.ts`
Expected: FAIL — `Failed to resolve import "./changes.js"`.

- [ ] **Step 3: Write the implementation**

`packages/server/src/changes.ts`:
```typescript
import type { DatabaseSync } from 'node:sqlite';
import type { ChangeEntry, ChangeKind } from '@obsidian-sync/protocol';

interface ChangeRow {
	seq: number;
	file_id: string;
	version_id: string | null;
	kind: string;
	size: number;
	created_at: number;
}

export interface AppendChangeInput {
	vaultId: string;
	fileId: string;
	versionId: string | undefined;
	kind: ChangeKind;
	size: number;
}

/**
 * Synchronous by design: callers invoke this inside their own transaction so a
 * change row and the version row it describes commit together or not at all.
 */
export function appendChange(db: DatabaseSync, entry: AppendChangeInput): number {
	const result = db
		.prepare(
			'INSERT INTO change_log (vault_id, file_id, version_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
		)
		.run(
			entry.vaultId,
			entry.fileId,
			entry.versionId ?? null,
			entry.kind,
			entry.size,
			Date.now(),
		);

	return Number(result.lastInsertRowid);
}

export function readChangesSince(
	db: DatabaseSync,
	vaultId: string,
	since: number,
	limit: number,
): { changes: ChangeEntry[]; hasMore: boolean } {
	// One extra row tells us whether another page exists without a COUNT query.
	const rows = db
		.prepare(
			'SELECT seq, file_id, version_id, kind, size, created_at FROM change_log WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?',
		)
		.all(vaultId, since, limit + 1) as ChangeRow[];

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;

	return {
		hasMore,
		changes: page.map((row) => ({
			seq: row.seq,
			fileId: row.file_id,
			kind: row.kind as ChangeKind,
			versionId: row.version_id ?? undefined,
			size: row.size,
			createdAt: row.created_at,
		})),
	};
}

export function latestSeq(db: DatabaseSync, vaultId: string): number {
	const row = db
		.prepare('SELECT MAX(seq) AS seq FROM change_log WHERE vault_id = ?')
		.get(vaultId) as { seq: number | null } | undefined;

	return row?.seq ?? 0;
}

export class ChangeNotifier {
	readonly #waiters = new Map<string, Set<() => void>>();

	notify(vaultId: string): void {
		const waiting = this.#waiters.get(vaultId);
		if (waiting === undefined) {
			return;
		}

		// Copy before iterating: each resolver removes itself from the live set.
		for (const resolve of [...waiting]) {
			resolve();
		}
	}

	async waitForChange(vaultId: string, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const waiting = this.#waiters.get(vaultId) ?? new Set<() => void>();
			this.#waiters.set(vaultId, waiting);

			const settle = (): void => {
				clearTimeout(timer);
				waiting.delete(settle);
				if (waiting.size === 0) {
					this.#waiters.delete(vaultId);
				}
				resolve();
			};

			const timer = setTimeout(settle, timeoutMs);
			// Never hold the event loop open on an idle long-poll during shutdown.
			timer.unref();
			waiting.add(settle);
		});
	}

	waiterCount(vaultId: string): number {
		return this.#waiters.get(vaultId)?.size ?? 0;
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/changes.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/changes.ts packages/server/src/changes.test.ts
git commit -m "feat: add change log queries and long-poll notifier"
```

---

## Task 9: Fastify application, bearer authentication, health check

**Files:**
- Create: `packages/server/src/auth.ts`
- Create: `packages/server/src/routes/health.ts`
- Create: `packages/server/src/app.ts`
- Test: `packages/server/src/auth.test.ts`

**Interfaces:**
- Consumes: `ServerConfig` from `./config.js`; `UserRegistry` from `./users.js`; `SerialWriter` from `./db/writer.js`; `BlobStore` from `./blobs.js`; `ChangeNotifier` from `./changes.js`.
- Produces: `interface AppDependencies { config: ServerConfig; users: UserRegistry; db: DatabaseSync; writer: SerialWriter; blobs: BlobStore; notifier: ChangeNotifier }`, `buildApp(dependencies: AppDependencies): FastifyInstance`, `registerAuthentication(scope: FastifyInstance, users: UserRegistry): void`, and the module augmentation adding `username: string` to `FastifyRequest`.

Authentication is a scoped hook rather than a global one, so `/v1/health` is unauthenticated by construction. A future route cannot accidentally skip auth — it is either inside the authenticated scope or it is not registered.

- [ ] **Step 1: Write the failing test**

`packages/server/src/auth.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type AppDependencies, buildApp } from './app.js';
import { createBlobStore } from './blobs.js';
import { ChangeNotifier } from './changes.js';
import { loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { SerialWriter } from './db/writer.js';
import { buildUserRegistry } from './users.js';

const aliceToken = 'a'.repeat(40);

let directory: string;
let dependencies: AppDependencies;
let app: FastifyInstance;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-app-'));
	dependencies = {
		config: loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }),
		users: buildUserRegistry({ SYNC_USER_ALICE: aliceToken }),
		db: openDatabase(join(directory, 'sync.db')),
		writer: new SerialWriter(),
		blobs: createBlobStore(join(directory, 'blobs')),
		notifier: new ChangeNotifier(),
	};
	app = buildApp(dependencies);
	await app.ready();
});

afterEach(async () => {
	await app.close();
	closeDatabase(dependencies.db);
	await rm(directory, { recursive: true, force: true });
});

describe('GET /v1/health', () => {
	test('responds without authentication', async () => {
		const response = await app.inject({ method: 'GET', url: '/v1/health' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ status: 'ok' });
	});
});

describe('bearer authentication', () => {
	test('rejects a request with no Authorization header', async () => {
		const response = await app.inject({ method: 'GET', url: '/v1/me' });
		expect(response.statusCode).toBe(401);
	});

	test('rejects a non-bearer scheme', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Basic ${aliceToken}` },
		});
		expect(response.statusCode).toBe(401);
	});

	test('rejects an unknown token', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Bearer ${'z'.repeat(40)}` },
		});
		expect(response.statusCode).toBe(401);
	});

	test('accepts a known token', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ user: 'alice' });
	});

	test('accepts a lowercase bearer scheme', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `bearer ${aliceToken}` },
		});
		expect(response.statusCode).toBe(200);
	});

	test('never echoes the supplied token in the error body', async () => {
		const badToken = 'q'.repeat(40);
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Bearer ${badToken}` },
		});
		expect(response.body).not.toContain(badToken);
	});
});
```

This test also exercises `/v1/me`, which Task 10 implements. Expect the four `/v1/me` cases to fail until then; the health and unauthenticated cases must pass at the end of this task.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/auth.test.ts`
Expected: FAIL — `Failed to resolve import "./app.js"`.

- [ ] **Step 3: Write the authentication hook**

`packages/server/src/auth.ts`:
```typescript
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserRegistry } from './users.js';

declare module 'fastify' {
	interface FastifyRequest {
		username: string;
	}
}

const bearerPattern = /^bearer\s+(.+)$/i;

export function registerAuthentication(scope: FastifyInstance, users: UserRegistry): void {
	scope.decorateRequest('username', '');

	scope.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
		const header = request.headers.authorization;
		const match = header === undefined ? undefined : bearerPattern.exec(header);

		if (match === undefined || match === null) {
			await reply.code(401).send({ error: 'unauthorized' });
			return;
		}

		// Never log or echo the presented token; an operator reading logs must not
		// be able to recover a credential from a failed request.
		const username = users.findByToken(match[1] ?? '');
		if (username === undefined) {
			await reply.code(401).send({ error: 'unauthorized' });
			return;
		}

		request.username = username;
	});
}
```

- [ ] **Step 4: Write the health route**

`packages/server/src/routes/health.ts`:
```typescript
import type { FastifyInstance } from 'fastify';
import { protocolVersion } from '@obsidian-sync/protocol';

export function registerHealthRoutes(app: FastifyInstance): void {
	app.get('/v1/health', async () => ({ status: 'ok', protocolVersion }));
}
```

- [ ] **Step 5: Write the application assembly**

`packages/server/src/app.ts`:
```typescript
import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthentication } from './auth.js';
import type { BlobStore } from './blobs.js';
import type { ChangeNotifier } from './changes.js';
import type { ServerConfig } from './config.js';
import type { SerialWriter } from './db/writer.js';
import { registerHealthRoutes } from './routes/health.js';
import type { UserRegistry } from './users.js';

export interface AppDependencies {
	config: ServerConfig;
	users: UserRegistry;
	db: DatabaseSync;
	writer: SerialWriter;
	blobs: BlobStore;
	notifier: ChangeNotifier;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
	const app = Fastify({
		logger: { level: dependencies.config.logLevel },
		bodyLimit: dependencies.config.maxBlobBytes,
	});

	// Chunks arrive as raw bytes. Fastify has no built-in parser for them.
	app.addContentTypeParser(
		'application/octet-stream',
		{ parseAs: 'buffer' },
		(_request, body, done) => {
			done(null, body);
		},
	);

	registerHealthRoutes(app);

	// Everything below is inside an authenticated encapsulation context, so a
	// route cannot be added without auth by forgetting a decorator.
	app.register(async (scope) => {
		registerAuthentication(scope, dependencies.users);
	});

	return app;
}
```

- [ ] **Step 6: Run the test to verify health passes**

Run: `pnpm vitest run packages/server/src/auth.test.ts`
Expected: the `GET /v1/health` case PASSES; the six `/v1/me` cases FAIL with 404 because Task 10 has not registered that route yet.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/auth.ts packages/server/src/app.ts packages/server/src/routes packages/server/src/auth.test.ts
git commit -m "feat: add fastify application with scoped bearer authentication"
```

---

## Task 10: Vault data access and routes

**Files:**
- Create: `packages/server/src/vaults.ts`
- Create: `packages/server/src/routes/vaults.ts`
- Modify: `packages/server/src/app.ts` — register the vault routes inside the authenticated scope
- Test: `packages/server/src/routes/vaults.test.ts`

**Interfaces:**
- Consumes: `AppDependencies`, `buildApp`; `isCreateVaultRequest`, `VaultSummary`, `MeResponse`, `protocolVersion` from `@obsidian-sync/protocol`.
- Produces: `listVaultsForOwner(db: DatabaseSync, owner: string): VaultSummary[]`, `findVaultForOwner(db: DatabaseSync, vaultId: string, owner: string): VaultSummary | undefined`, `createVault(db: DatabaseSync, owner: string, name: string): VaultSummary`, `registerVaultRoutes(scope: FastifyInstance, dependencies: AppDependencies): void`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/routes/vaults.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type AppDependencies, buildApp } from '../app.js';
import { createBlobStore } from '../blobs.js';
import { ChangeNotifier } from '../changes.js';
import { loadConfig } from '../config.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { SerialWriter } from '../db/writer.js';
import { buildUserRegistry } from '../users.js';

const aliceToken = 'a'.repeat(40);
const bobToken = 'b'.repeat(40);

let directory: string;
let dependencies: AppDependencies;
let app: FastifyInstance;

function authorised(token: string): { authorization: string } {
	return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-vaults-'));
	dependencies = {
		config: loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }),
		users: buildUserRegistry({ SYNC_USER_ALICE: aliceToken, SYNC_USER_BOB: bobToken }),
		db: openDatabase(join(directory, 'sync.db')),
		writer: new SerialWriter(),
		blobs: createBlobStore(join(directory, 'blobs')),
		notifier: new ChangeNotifier(),
	};
	app = buildApp(dependencies);
	await app.ready();
});

afterEach(async () => {
	await app.close();
	closeDatabase(dependencies.db);
	await rm(directory, { recursive: true, force: true });
});

describe('GET /v1/me', () => {
	test('reports the user and an empty vault list', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ user: 'alice', vaults: [], protocolVersion: 1 });
	});
});

describe('POST /v1/vaults', () => {
	test('creates a vault and returns a base64 salt', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'personal' },
		});
		expect(response.statusCode).toBe(201);

		const body = response.json() as { id: string; name: string; kdfSalt: string };
		expect(body.name).toBe('personal');
		expect(Buffer.from(body.kdfSalt, 'base64')).toHaveLength(16);
	});

	test('gives two vaults different salts', async () => {
		const first = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'one' },
		});
		const second = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'two' },
		});
		expect(first.json().kdfSalt).not.toBe(second.json().kdfSalt);
	});

	test('rejects a malformed body', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: '' },
		});
		expect(response.statusCode).toBe(400);
	});

	test('rejects a duplicate name for the same owner', async () => {
		await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'personal' },
		});
		const response = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'personal' },
		});
		expect(response.statusCode).toBe(409);
	});

	test('allows two owners to use the same vault name', async () => {
		await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'personal' },
		});
		const response = await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(bobToken),
			payload: { name: 'personal' },
		});
		expect(response.statusCode).toBe(201);
	});
});

describe('vault isolation', () => {
	test('one owner never sees another owner vault', async () => {
		await app.inject({
			method: 'POST',
			url: '/v1/vaults',
			headers: authorised(aliceToken),
			payload: { name: 'secrets' },
		});

		const response = await app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: authorised(bobToken),
		});
		expect(response.json().vaults).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/routes/vaults.test.ts`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Write the vault data access module**

`packages/server/src/vaults.ts`:
```typescript
import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { kdfSaltBytes, type VaultSummary } from '@obsidian-sync/protocol';

interface VaultRow {
	id: string;
	name: string;
	kdf_salt: Uint8Array;
}

export class VaultNameTakenError extends Error {
	constructor(name: string) {
		super(`vault "${name}" already exists for this user`);
		this.name = 'VaultNameTakenError';
	}
}

function toSummary(row: VaultRow): VaultSummary {
	return {
		id: row.id,
		name: row.name,
		kdfSalt: Buffer.from(row.kdf_salt).toString('base64'),
	};
}

export function listVaultsForOwner(db: DatabaseSync, owner: string): VaultSummary[] {
	const rows = db
		.prepare('SELECT id, name, kdf_salt FROM vault WHERE owner = ? ORDER BY name')
		.all(owner) as VaultRow[];

	return rows.map(toSummary);
}

export function findVaultForOwner(
	db: DatabaseSync,
	vaultId: string,
	owner: string,
): VaultSummary | undefined {
	const row = db
		.prepare('SELECT id, name, kdf_salt FROM vault WHERE id = ? AND owner = ?')
		.get(vaultId, owner) as VaultRow | undefined;

	return row === undefined ? undefined : toSummary(row);
}

export function createVault(db: DatabaseSync, owner: string, name: string): VaultSummary {
	const existing = db
		.prepare('SELECT id FROM vault WHERE owner = ? AND name = ?')
		.get(owner, name);

	if (existing !== undefined) {
		throw new VaultNameTakenError(name);
	}

	const id = randomUUID();
	const salt = randomBytes(kdfSaltBytes);

	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run(id, name, owner, salt, Date.now());

	return { id, name, kdfSalt: salt.toString('base64') };
}
```

- [ ] **Step 4: Write the vault routes**

`packages/server/src/routes/vaults.ts`:
```typescript
import { type MeResponse, isCreateVaultRequest, protocolVersion } from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { VaultNameTakenError, createVault, listVaultsForOwner } from '../vaults.js';

export function registerVaultRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, writer } = dependencies;

	scope.get('/v1/me', async (request): Promise<MeResponse> => {
		return {
			user: request.username,
			vaults: listVaultsForOwner(db, request.username),
			protocolVersion,
		};
	});

	scope.post('/v1/vaults', async (request, reply) => {
		if (!isCreateVaultRequest(request.body)) {
			return reply.code(400).send({ error: 'invalid_body' });
		}

		const { name } = request.body;
		try {
			const vault = await writer.run(() => createVault(db, request.username, name));
			return reply.code(201).send(vault);
		} catch (error) {
			if (error instanceof VaultNameTakenError) {
				return reply.code(409).send({ error: 'vault_exists' });
			}
			throw error;
		}
	});
}
```

- [ ] **Step 5: Register the routes in the authenticated scope**

In `packages/server/src/app.ts`, add the import and extend the authenticated scope:

```typescript
import { registerVaultRoutes } from './routes/vaults.js';
```

```typescript
	app.register(async (scope) => {
		registerAuthentication(scope, dependencies.users);
		registerVaultRoutes(scope, dependencies);
	});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/server/src`
Expected: PASS — including all six `/v1/me` cases in `auth.test.ts` that failed in Task 9.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src
git commit -m "feat: add vault creation, listing and per-owner isolation"
```

---

## Task 11: Blob upload, presence check and download

**Files:**
- Create: `packages/server/src/routes/blobs.ts`
- Modify: `packages/server/src/app.ts` — register blob routes
- Test: `packages/server/src/routes/blobs.test.ts`

**Interfaces:**
- Consumes: `AppDependencies`; `findVaultForOwner` from `../vaults.js`; `isBlobCheckRequest`, `blobAddressPattern`, `BlobCheckResponse` from `@obsidian-sync/protocol`.
- Produces: `registerBlobRoutes(scope: FastifyInstance, dependencies: AppDependencies): void`.

Uploading records a `blob_ref` row at refcount 0. The count rises only when a version commits (Task 12), so a blob uploaded for a commit that never happens is reclaimable — see Task 15.

- [ ] **Step 1: Write the failing test**

`packages/server/src/routes/blobs.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type AppDependencies, buildApp } from '../app.js';
import { createBlobStore } from '../blobs.js';
import { ChangeNotifier } from '../changes.js';
import { loadConfig } from '../config.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { SerialWriter } from '../db/writer.js';
import { buildUserRegistry } from '../users.js';

const aliceToken = 'a'.repeat(40);
const bobToken = 'b'.repeat(40);
const addressOne = '1'.repeat(64);
const addressTwo = '2'.repeat(64);
const payload = Buffer.from([9, 8, 7, 6]);

let directory: string;
let dependencies: AppDependencies;
let app: FastifyInstance;
let vaultId: string;

function authorised(token: string): { authorization: string } {
	return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-blobroutes-'));
	dependencies = {
		config: loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent', MAX_BLOB_BYTES: '2048' }),
		users: buildUserRegistry({ SYNC_USER_ALICE: aliceToken, SYNC_USER_BOB: bobToken }),
		db: openDatabase(join(directory, 'sync.db')),
		writer: new SerialWriter(),
		blobs: createBlobStore(join(directory, 'blobs')),
		notifier: new ChangeNotifier(),
	};
	app = buildApp(dependencies);
	await app.ready();

	const created = await app.inject({
		method: 'POST',
		url: '/v1/vaults',
		headers: authorised(aliceToken),
		payload: { name: 'personal' },
	});
	vaultId = created.json().id;
});

afterEach(async () => {
	await app.close();
	closeDatabase(dependencies.db);
	await rm(directory, { recursive: true, force: true });
});

async function upload(address: string, body: Buffer = payload) {
	return app.inject({
		method: 'PUT',
		url: `/v1/vaults/${vaultId}/blobs/${address}`,
		headers: { ...authorised(aliceToken), 'content-type': 'application/octet-stream' },
		payload: body,
	});
}

describe('PUT blob', () => {
	test('stores a new blob', async () => {
		expect((await upload(addressOne)).statusCode).toBe(201);
		await expect(dependencies.blobs.has(vaultId, addressOne)).resolves.toBe(true);
	});

	test('records a blob_ref row at refcount zero', async () => {
		await upload(addressOne);
		const row = dependencies.db
			.prepare('SELECT refcount, bytes FROM blob_ref WHERE vault_id = ? AND addr = ?')
			.get(vaultId, addressOne) as { refcount: number; bytes: number };
		expect(row.refcount).toBe(0);
		expect(row.bytes).toBe(payload.length);
	});

	test('returns 204 when the blob already exists', async () => {
		await upload(addressOne);
		expect((await upload(addressOne)).statusCode).toBe(204);
	});

	test('rejects a malformed address', async () => {
		const response = await app.inject({
			method: 'PUT',
			url: `/v1/vaults/${vaultId}/blobs/not-hex`,
			headers: { ...authorised(aliceToken), 'content-type': 'application/octet-stream' },
			payload,
		});
		expect(response.statusCode).toBe(400);
	});

	test('rejects a body over the configured limit', async () => {
		const response = await upload(addressOne, Buffer.alloc(4096));
		expect(response.statusCode).toBe(413);
	});

	test('rejects an upload to another owner vault', async () => {
		const response = await app.inject({
			method: 'PUT',
			url: `/v1/vaults/${vaultId}/blobs/${addressOne}`,
			headers: { ...authorised(bobToken), 'content-type': 'application/octet-stream' },
			payload,
		});
		expect(response.statusCode).toBe(404);
	});
});

describe('POST blobs/check', () => {
	test('reports every address as missing when the store is empty', async () => {
		const response = await app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/blobs/check`,
			headers: authorised(aliceToken),
			payload: { addresses: [addressOne, addressTwo] },
		});
		expect(response.json().missing.sort()).toEqual([addressOne, addressTwo].sort());
	});

	test('omits addresses that are already stored', async () => {
		await upload(addressOne);
		const response = await app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/blobs/check`,
			headers: authorised(aliceToken),
			payload: { addresses: [addressOne, addressTwo] },
		});
		expect(response.json().missing).toEqual([addressTwo]);
	});

	test('rejects a malformed body', async () => {
		const response = await app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/blobs/check`,
			headers: authorised(aliceToken),
			payload: { addresses: ['bad'] },
		});
		expect(response.statusCode).toBe(400);
	});
});

describe('GET blob', () => {
	test('returns the stored bytes', async () => {
		await upload(addressOne);
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/blobs/${addressOne}`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers['content-type']).toBe('application/octet-stream');
		expect(Buffer.from(response.rawPayload)).toEqual(payload);
	});

	test('returns 404 for an absent blob', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/blobs/${addressTwo}`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(404);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/routes/blobs.test.ts`
Expected: FAIL — 404 on every blob route.

- [ ] **Step 3: Write the blob routes**

`packages/server/src/routes/blobs.ts`:
```typescript
import {
	type BlobCheckResponse,
	blobAddressPattern,
	isBlobCheckRequest,
} from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { findVaultForOwner } from '../vaults.js';

interface VaultParams {
	vaultId: string;
}

interface BlobParams extends VaultParams {
	address: string;
}

export function registerBlobRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, writer, blobs } = dependencies;

	scope.put<{ Params: BlobParams }>(
		'/v1/vaults/:vaultId/blobs/:address',
		async (request, reply) => {
			const { vaultId, address } = request.params;
			if (!blobAddressPattern.test(address)) {
				return reply.code(400).send({ error: 'invalid_address' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			if (await blobs.has(vaultId, address)) {
				return reply.code(204).send();
			}

			const body = request.body;
			if (!Buffer.isBuffer(body)) {
				return reply.code(400).send({ error: 'expected_octet_stream' });
			}

			// Blob first, row second — spec section 5.3. An orphan blob is collectable;
			// a row pointing at a missing blob is unrecoverable corruption.
			await blobs.put(vaultId, address, new Uint8Array(body));
			await writer.run(() => {
				db.prepare(
					'INSERT INTO blob_ref (vault_id, addr, bytes, refcount) VALUES (?, ?, ?, 0) ON CONFLICT (vault_id, addr) DO NOTHING',
				).run(vaultId, address, body.length);
			});

			return reply.code(201).send();
		},
	);

	scope.post<{ Params: VaultParams }>(
		'/v1/vaults/:vaultId/blobs/check',
		async (request, reply) => {
			const { vaultId } = request.params;
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}
			if (!isBlobCheckRequest(request.body)) {
				return reply.code(400).send({ error: 'invalid_body' });
			}

			const missing: string[] = [];
			for (const address of request.body.addresses) {
				if (!(await blobs.has(vaultId, address))) {
					missing.push(address);
				}
			}

			const response: BlobCheckResponse = { missing };
			return reply.send(response);
		},
	);

	scope.get<{ Params: BlobParams }>(
		'/v1/vaults/:vaultId/blobs/:address',
		async (request, reply) => {
			const { vaultId, address } = request.params;
			if (!blobAddressPattern.test(address)) {
				return reply.code(400).send({ error: 'invalid_address' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const data = await blobs.get(vaultId, address);
			if (data === undefined) {
				return reply.code(404).send({ error: 'blob_not_found' });
			}

			return reply.type('application/octet-stream').send(Buffer.from(data));
		},
	);
}
```

- [ ] **Step 4: Register the routes**

In `packages/server/src/app.ts`, add the import and the registration inside the authenticated scope:

```typescript
import { registerBlobRoutes } from './routes/blobs.js';
```

```typescript
		registerBlobRoutes(scope, dependencies);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/server/src`
Expected: PASS — 11 new blob cases, everything earlier still green.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src
git commit -m "feat: add blob upload, presence check and download routes"
```

---

## Task 12: Version commit, optimistic concurrency, delete and state

This is the correctness hinge of the whole system. The server cannot merge — it has no keys — so it must reject a stale commit rather than overwrite. Every guarantee the plugin's conflict handling relies on comes from the transaction below.

**Files:**
- Create: `packages/server/src/files.ts`
- Create: `packages/server/src/routes/files.ts`
- Modify: `packages/server/src/app.ts` — register file routes
- Test: `packages/server/src/files.test.ts`

**Interfaces:**
- Consumes: `appendChange` from `./changes.js`; `isCommitVersionRequest`, `fileIdPattern` from `@obsidian-sync/protocol`.
- Produces:
  - `type CommitOutcome = { status: 'committed'; versionId: string; seq: number } | { status: 'conflict'; headVersion: string | undefined } | { status: 'missingChunks'; missing: string[] }`
  - `interface CommitInput { vaultId: string; fileId: string; parentVersion: string | undefined; metaBlob: string; chunks: string[]; size: number; deviceId: string }`
  - `commitVersion(db: DatabaseSync, input: CommitInput): CommitOutcome`
  - `deleteFile(db: DatabaseSync, input: { vaultId: string; fileId: string; parentVersion: string | undefined }): CommitOutcome`
  - `readVaultState(db: DatabaseSync, vaultId: string): FileState[]`
  - `listVersions(db: DatabaseSync, vaultId: string, fileId: string): VersionSummary[]`
  - `registerFileRoutes(scope: FastifyInstance, dependencies: AppDependencies): void`

- [ ] **Step 1: Write the failing test**

`packages/server/src/files.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readChangesSince } from './changes.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { commitVersion, deleteFile, listVersions, readVaultState } from './files.js';

const fileId = 'f'.repeat(64);
const otherFileId = 'e'.repeat(64);
const chunkOne = '1'.repeat(64);
const chunkTwo = '2'.repeat(64);

let directory: string;
let db: DatabaseSync;

function knownChunk(address: string): void {
	db.prepare(
		'INSERT INTO blob_ref (vault_id, addr, bytes, refcount) VALUES (?, ?, ?, 0)',
	).run('v1', address, 100);
}

function commit(parentVersion: string | undefined, chunks: string[] = [chunkOne]) {
	return commitVersion(db, {
		vaultId: 'v1',
		fileId,
		parentVersion,
		metaBlob: 'bWV0YQ==',
		chunks,
		size: 100,
		deviceId: 'device-1',
	});
}

function refcountOf(address: string): number {
	const row = db
		.prepare('SELECT refcount FROM blob_ref WHERE vault_id = ? AND addr = ?')
		.get('v1', address) as { refcount: number } | undefined;
	return row?.refcount ?? -1;
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-files-'));
	db = openDatabase(join(directory, 'sync.db'));
	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run('v1', 'personal', 'alice', Buffer.alloc(16), Date.now());
	knownChunk(chunkOne);
	knownChunk(chunkTwo);
});

afterEach(async () => {
	closeDatabase(db);
	await rm(directory, { recursive: true, force: true });
});

describe('commitVersion', () => {
	test('creates a file when no parent is supplied', () => {
		const outcome = commit(undefined);
		expect(outcome.status).toBe('committed');
	});

	test('appends a change row for the commit', () => {
		commit(undefined);
		const { changes } = readChangesSince(db, 'v1', 0, 10);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ fileId, kind: 'upsert', size: 100 });
	});

	test('increments the refcount of each referenced chunk', () => {
		commit(undefined, [chunkOne, chunkTwo]);
		expect(refcountOf(chunkOne)).toBe(1);
		expect(refcountOf(chunkTwo)).toBe(1);
	});

	test('counts a repeated chunk once per version', () => {
		commit(undefined, [chunkOne, chunkOne]);
		expect(refcountOf(chunkOne)).toBe(1);
	});

	test('accepts a commit whose parent is the current head', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		expect(commit(first.versionId).status).toBe('committed');
	});

	test('rejects a commit whose parent is stale, reporting the real head', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		commit(first.versionId);

		const outcome = commit(first.versionId);
		expect(outcome).toEqual({ status: 'conflict', headVersion: expect.any(String) });
		if (outcome.status === 'conflict') {
			expect(outcome.headVersion).not.toBe(first.versionId);
		}
	});

	test('rejects a create when the file already exists', () => {
		commit(undefined);
		expect(commit(undefined).status).toBe('conflict');
	});

	test('writes nothing when a commit conflicts', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		const before = refcountOf(chunkOne);
		commit(undefined);
		expect(refcountOf(chunkOne)).toBe(before);
		expect(readChangesSince(db, 'v1', 0, 10).changes).toHaveLength(1);
	});

	test('reports unknown chunks instead of committing', () => {
		const outcome = commit(undefined, [chunkOne, '9'.repeat(64)]);
		expect(outcome).toEqual({ status: 'missingChunks', missing: ['9'.repeat(64)] });
		expect(readChangesSince(db, 'v1', 0, 10).changes).toHaveLength(0);
	});

	test('accepts a zero-byte file with no chunks', () => {
		const outcome = commitVersion(db, {
			vaultId: 'v1',
			fileId: otherFileId,
			parentVersion: undefined,
			metaBlob: 'bWV0YQ==',
			chunks: [],
			size: 0,
			deviceId: 'device-1',
		});
		expect(outcome.status).toBe('committed');
	});
});

describe('deleteFile', () => {
	test('tombstones a file and appends a delete change', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}

		const outcome = deleteFile(db, { vaultId: 'v1', fileId, parentVersion: first.versionId });
		expect(outcome.status).toBe('committed');

		const { changes } = readChangesSince(db, 'v1', first.seq, 10);
		expect(changes[0]).toMatchObject({ kind: 'delete', versionId: undefined });
	});

	test('rejects a delete with a stale parent', () => {
		commit(undefined);
		expect(
			deleteFile(db, {
				vaultId: 'v1',
				fileId,
				parentVersion: '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
			}).status,
		).toBe('conflict');
	});

	test('rejects a delete for a file that never existed', () => {
		expect(deleteFile(db, { vaultId: 'v1', fileId, parentVersion: undefined }).status).toBe(
			'conflict',
		);
	});

	test('allows recreating a deleted file with no parent', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		deleteFile(db, { vaultId: 'v1', fileId, parentVersion: first.versionId });
		expect(commit(undefined).status).toBe('committed');
	});
});

describe('readVaultState', () => {
	test('is empty for a new vault', () => {
		expect(readVaultState(db, 'v1')).toEqual([]);
	});

	test('lists a live file with its head metadata', () => {
		commit(undefined);
		const state = readVaultState(db, 'v1');
		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({ fileId, metaBlob: 'bWV0YQ==', size: 100 });
	});

	test('omits a deleted file', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		deleteFile(db, { vaultId: 'v1', fileId, parentVersion: first.versionId });
		expect(readVaultState(db, 'v1')).toEqual([]);
	});
});

describe('listVersions', () => {
	test('returns versions newest first with parent links', () => {
		const first = commit(undefined);
		if (first.status !== 'committed') {
			expect.unreachable('first commit should succeed');
		}
		commit(first.versionId);

		const versions = listVersions(db, 'v1', fileId);
		expect(versions).toHaveLength(2);
		expect(versions[0]?.parentVersion).toBe(first.versionId);
		expect(versions[1]?.parentVersion).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/files.test.ts`
Expected: FAIL — `Failed to resolve import "./files.js"`.

- [ ] **Step 3: Write the file data-access module**

`packages/server/src/files.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FileState, VersionSummary } from '@obsidian-sync/protocol';
import { appendChange } from './changes.js';

export type CommitOutcome =
	| { status: 'committed'; versionId: string; seq: number }
	| { status: 'conflict'; headVersion: string | undefined }
	| { status: 'missingChunks'; missing: string[] };

export interface CommitInput {
	vaultId: string;
	fileId: string;
	parentVersion: string | undefined;
	metaBlob: string;
	chunks: string[];
	size: number;
	deviceId: string;
}

/**
 * The version a client must name as its parent, or undefined when the file does
 * not exist or has been tombstoned. A tombstone reads as absent so that
 * recreating a deleted path is a plain create rather than a special case.
 */
function currentHead(db: DatabaseSync, vaultId: string, fileId: string): string | undefined {
	const row = db
		.prepare('SELECT head_version, deleted FROM file WHERE vault_id = ? AND file_id = ?')
		.get(vaultId, fileId) as { head_version: string | null; deleted: number } | undefined;

	if (row === undefined || row.deleted === 1) {
		return undefined;
	}
	return row.head_version ?? undefined;
}

function findUnknownChunks(db: DatabaseSync, vaultId: string, chunks: string[]): string[] {
	const lookup = db.prepare('SELECT 1 AS present FROM blob_ref WHERE vault_id = ? AND addr = ?');
	const missing: string[] = [];

	for (const address of new Set(chunks)) {
		if (lookup.get(vaultId, address) === undefined) {
			missing.push(address);
		}
	}
	return missing;
}

export function commitVersion(db: DatabaseSync, input: CommitInput): CommitOutcome {
	db.exec('BEGIN IMMEDIATE');
	try {
		const missing = findUnknownChunks(db, input.vaultId, input.chunks);
		if (missing.length > 0) {
			db.exec('ROLLBACK');
			return { status: 'missingChunks', missing };
		}

		const headVersion = currentHead(db, input.vaultId, input.fileId);
		if (headVersion !== input.parentVersion) {
			db.exec('ROLLBACK');
			return { status: 'conflict', headVersion };
		}

		const versionId = randomUUID();
		db.prepare(
			'INSERT INTO version (vault_id, file_id, version_id, parent_version, meta_blob, chunks, size, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		).run(
			input.vaultId,
			input.fileId,
			versionId,
			input.parentVersion ?? null,
			input.metaBlob,
			JSON.stringify(input.chunks),
			input.size,
			input.deviceId,
			Date.now(),
		);

		const seq = appendChange(db, {
			vaultId: input.vaultId,
			fileId: input.fileId,
			versionId,
			kind: 'upsert',
			size: input.size,
		});

		db.prepare(
			'INSERT INTO file (vault_id, file_id, head_version, deleted, updated_seq) VALUES (?, ?, ?, 0, ?) ON CONFLICT (vault_id, file_id) DO UPDATE SET head_version = excluded.head_version, deleted = 0, updated_seq = excluded.updated_seq',
		).run(input.vaultId, input.fileId, versionId, seq);

		// Distinct addresses only: a file repeating a chunk holds one reference to
		// it, so pruning that version releases the reference exactly once.
		const bump = db.prepare(
			'UPDATE blob_ref SET refcount = refcount + 1 WHERE vault_id = ? AND addr = ?',
		);
		for (const address of new Set(input.chunks)) {
			bump.run(input.vaultId, address);
		}

		db.exec('COMMIT');
		return { status: 'committed', versionId, seq };
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function deleteFile(
	db: DatabaseSync,
	input: { vaultId: string; fileId: string; parentVersion: string | undefined },
): CommitOutcome {
	db.exec('BEGIN IMMEDIATE');
	try {
		const headVersion = currentHead(db, input.vaultId, input.fileId);
		if (headVersion === undefined || headVersion !== input.parentVersion) {
			db.exec('ROLLBACK');
			return { status: 'conflict', headVersion };
		}

		const seq = appendChange(db, {
			vaultId: input.vaultId,
			fileId: input.fileId,
			versionId: undefined,
			kind: 'delete',
			size: 0,
		});

		// The version rows survive: history and restore outlive the tombstone, and
		// retention is what eventually releases the chunks.
		db.prepare(
			'UPDATE file SET deleted = 1, head_version = NULL, updated_seq = ? WHERE vault_id = ? AND file_id = ?',
		).run(seq, input.vaultId, input.fileId);

		db.exec('COMMIT');
		return { status: 'committed', versionId: '', seq };
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function readVaultState(db: DatabaseSync, vaultId: string): FileState[] {
	const rows = db
		.prepare(
			`SELECT f.file_id, f.head_version, f.updated_seq, v.meta_blob, v.size
			 FROM file f
			 JOIN version v ON v.vault_id = f.vault_id AND v.file_id = f.file_id AND v.version_id = f.head_version
			 WHERE f.vault_id = ? AND f.deleted = 0
			 ORDER BY f.updated_seq`,
		)
		.all(vaultId) as {
		file_id: string;
		head_version: string;
		updated_seq: number;
		meta_blob: string;
		size: number;
	}[];

	return rows.map((row) => ({
		fileId: row.file_id,
		headVersion: row.head_version,
		metaBlob: row.meta_blob,
		size: row.size,
		updatedSeq: row.updated_seq,
	}));
}

export function listVersions(
	db: DatabaseSync,
	vaultId: string,
	fileId: string,
): VersionSummary[] {
	const rows = db
		.prepare(
			'SELECT version_id, parent_version, size, device_id, created_at FROM version WHERE vault_id = ? AND file_id = ? ORDER BY created_at DESC, rowid DESC',
		)
		.all(vaultId, fileId) as {
		version_id: string;
		parent_version: string | null;
		size: number;
		device_id: string;
		created_at: number;
	}[];

	return rows.map((row) => ({
		versionId: row.version_id,
		parentVersion: row.parent_version ?? undefined,
		size: row.size,
		deviceId: row.device_id,
		createdAt: row.created_at,
	}));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/files.test.ts`
Expected: PASS — 18 tests.

- [ ] **Step 5: Write the file routes**

`packages/server/src/routes/files.ts`:
```typescript
import {
	type CommitVersionResponse,
	type VaultStateResponse,
	type VersionsResponse,
	fileIdPattern,
	isCommitVersionRequest,
} from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { latestSeq } from '../changes.js';
import { commitVersion, deleteFile, listVersions, readVaultState } from '../files.js';
import { findVaultForOwner } from '../vaults.js';

interface FileParams {
	vaultId: string;
	fileId: string;
}

interface VaultParams {
	vaultId: string;
}

export function registerFileRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, writer, notifier } = dependencies;

	scope.post<{ Params: FileParams }>(
		'/v1/vaults/:vaultId/files/:fileId',
		async (request, reply) => {
			const { vaultId, fileId } = request.params;
			if (!fileIdPattern.test(fileId)) {
				return reply.code(400).send({ error: 'invalid_file_id' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}
			if (!isCommitVersionRequest(request.body)) {
				return reply.code(400).send({ error: 'invalid_body' });
			}

			const body = request.body;
			const outcome = await writer.run(() =>
				commitVersion(db, {
					vaultId,
					fileId,
					parentVersion: body.parentVersion,
					metaBlob: body.metaBlob,
					chunks: body.chunks,
					size: body.size,
					deviceId: body.deviceId,
				}),
			);

			if (outcome.status === 'conflict') {
				return reply.code(409).send({ error: 'conflict', headVersion: outcome.headVersion });
			}
			if (outcome.status === 'missingChunks') {
				return reply.code(400).send({ error: 'missing_chunks', missing: outcome.missing });
			}

			notifier.notify(vaultId);
			const response: CommitVersionResponse = {
				versionId: outcome.versionId,
				seq: outcome.seq,
			};
			return reply.code(201).send(response);
		},
	);

	scope.delete<{ Params: FileParams; Querystring: { parentVersion?: string } }>(
		'/v1/vaults/:vaultId/files/:fileId',
		async (request, reply) => {
			const { vaultId, fileId } = request.params;
			if (!fileIdPattern.test(fileId)) {
				return reply.code(400).send({ error: 'invalid_file_id' });
			}
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const outcome = await writer.run(() =>
				deleteFile(db, { vaultId, fileId, parentVersion: request.query.parentVersion }),
			);

			if (outcome.status !== 'committed') {
				return reply.code(409).send({
					error: 'conflict',
					headVersion: outcome.status === 'conflict' ? outcome.headVersion : undefined,
				});
			}

			notifier.notify(vaultId);
			return reply.code(200).send({ seq: outcome.seq });
		},
	);

	scope.get<{ Params: FileParams }>(
		'/v1/vaults/:vaultId/files/:fileId/versions',
		async (request, reply) => {
			const { vaultId, fileId } = request.params;
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const response: VersionsResponse = { versions: listVersions(db, vaultId, fileId) };
			return reply.send(response);
		},
	);

	scope.get<{ Params: VaultParams }>('/v1/vaults/:vaultId/state', async (request, reply) => {
		const { vaultId } = request.params;
		if (findVaultForOwner(db, vaultId, request.username) === undefined) {
			return reply.code(404).send({ error: 'vault_not_found' });
		}

		// Sequence read before the file list, so a change landing mid-read is
		// re-delivered by the client's next incremental pull rather than skipped.
		const seq = latestSeq(db, vaultId);
		const response: VaultStateResponse = { files: readVaultState(db, vaultId), seq };
		return reply.send(response);
	});
}
```

- [ ] **Step 6: Register the routes**

In `packages/server/src/app.ts`, add the import and registration inside the authenticated scope:

```typescript
import { registerFileRoutes } from './routes/files.js';
```

```typescript
		registerFileRoutes(scope, dependencies);
```

- [ ] **Step 7: Run the full suite**

Run: `pnpm vitest run packages/server/src && pnpm lint && pnpm typecheck`
Expected: PASS, no lint or type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src
git commit -m "feat: add version commit with optimistic concurrency, delete and state"
```

---

## Task 13: Long-poll changes endpoint

**Files:**
- Create: `packages/server/src/routes/changes.ts`
- Modify: `packages/server/src/app.ts` — register changes routes
- Test: `packages/server/src/routes/changes.test.ts`

**Interfaces:**
- Consumes: `readChangesSince`, `latestSeq`, `ChangeNotifier`; `ChangesResponse` from `@obsidian-sync/protocol`.
- Produces: `registerChangeRoutes(scope: FastifyInstance, dependencies: AppDependencies): void`.

The endpoint returns immediately when changes already exist past the cursor. Only a caught-up client waits, and the wait is capped at `LONGPOLL_MAX_WAIT_MS`. A caller may request a shorter wait but never a longer one — see spec risk R1, where the plugin discovers the platform ceiling empirically and asks for less.

- [ ] **Step 1: Write the failing test**

`packages/server/src/routes/changes.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type AppDependencies, buildApp } from '../app.js';
import { createBlobStore } from '../blobs.js';
import { ChangeNotifier, appendChange } from '../changes.js';
import { loadConfig } from '../config.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { SerialWriter } from '../db/writer.js';
import { buildUserRegistry } from '../users.js';

const aliceToken = 'a'.repeat(40);
const bobToken = 'b'.repeat(40);

let directory: string;
let dependencies: AppDependencies;
let app: FastifyInstance;
let vaultId: string;

function authorised(token: string): { authorization: string } {
	return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-changeroutes-'));
	dependencies = {
		config: loadConfig({
			DATA_DIR: directory,
			LOG_LEVEL: 'silent',
			LONGPOLL_MAX_WAIT_MS: '1000',
		}),
		users: buildUserRegistry({ SYNC_USER_ALICE: aliceToken, SYNC_USER_BOB: bobToken }),
		db: openDatabase(join(directory, 'sync.db')),
		writer: new SerialWriter(),
		blobs: createBlobStore(join(directory, 'blobs')),
		notifier: new ChangeNotifier(),
	};
	app = buildApp(dependencies);
	await app.ready();

	const created = await app.inject({
		method: 'POST',
		url: '/v1/vaults',
		headers: authorised(aliceToken),
		payload: { name: 'personal' },
	});
	vaultId = created.json().id;
});

afterEach(async () => {
	await app.close();
	closeDatabase(dependencies.db);
	await rm(directory, { recursive: true, force: true });
});

function addChange(fileId: string): number {
	return appendChange(dependencies.db, {
		vaultId,
		fileId,
		versionId: undefined,
		kind: 'upsert',
		size: 1,
	});
}

describe('GET changes', () => {
	test('returns existing changes without waiting', async () => {
		addChange('f1');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().changes).toHaveLength(1);
	});

	test('reports the newest sequence number', async () => {
		const seq = addChange('f1');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.json().seq).toBe(seq);
	});

	test('returns an empty list for a caught-up client when wait is zero', async () => {
		addChange('f1');
		const seq = addChange('f2');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=${seq}&wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.json().changes).toEqual([]);
	});

	test('holds the request open and returns when a change arrives', async () => {
		const pending = app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=5`,
			headers: authorised(aliceToken),
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		addChange('late');
		dependencies.notifier.notify(vaultId);

		const response = await pending;
		expect(response.json().changes).toHaveLength(1);
		expect(response.json().changes[0].fileId).toBe('late');
	});

	test('returns empty after the wait ceiling with nothing to report', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=30`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().changes).toEqual([]);
	});

	test('defaults a missing since cursor to zero', async () => {
		addChange('f1');
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.json().changes).toHaveLength(1);
	});

	test('rejects a non-numeric cursor', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=abc&wait=0`,
			headers: authorised(aliceToken),
		});
		expect(response.statusCode).toBe(400);
	});

	test('refuses to serve another owner vault', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=0`,
			headers: authorised(bobToken),
		});
		expect(response.statusCode).toBe(404);
	});

	test('flags a truncated page', async () => {
		for (let index = 0; index < 5; index += 1) {
			addChange(`f${index}`);
		}
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=0&wait=0&limit=2`,
			headers: authorised(aliceToken),
		});
		expect(response.json().changes).toHaveLength(2);
		expect(response.json().hasMore).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/routes/changes.test.ts`
Expected: FAIL — 404 on the changes route.

- [ ] **Step 3: Write the route**

`packages/server/src/routes/changes.ts`:
```typescript
import type { ChangesResponse } from '@obsidian-sync/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { latestSeq, readChangesSince } from '../changes.js';
import { findVaultForOwner } from '../vaults.js';

interface ChangesQuery {
	since?: string;
	wait?: string;
	limit?: string;
}

const defaultLimit = 500;
const maximumLimit = 2000;

function parseNumber(raw: string | undefined, fallback: number): number | undefined {
	if (raw === undefined || raw === '') {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return undefined;
	}
	return parsed;
}

export function registerChangeRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, notifier, config } = dependencies;

	scope.get<{ Params: { vaultId: string }; Querystring: ChangesQuery }>(
		'/v1/vaults/:vaultId/changes',
		async (request, reply) => {
			const { vaultId } = request.params;
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}

			const since = parseNumber(request.query.since, 0);
			const requestedWaitSeconds = parseNumber(request.query.wait, 0);
			const limit = parseNumber(request.query.limit, defaultLimit);
			if (since === undefined || requestedWaitSeconds === undefined || limit === undefined) {
				return reply.code(400).send({ error: 'invalid_query' });
			}

			// The client may ask for less than the ceiling but never more: on mobile
			// it lowers this after measuring the platform requestUrl timeout (spec R1).
			const waitMs = Math.min(requestedWaitSeconds * 1000, config.longpollMaxWaitMs);
			const pageSize = Math.min(limit, maximumLimit);

			let page = readChangesSince(db, vaultId, since, pageSize);
			if (page.changes.length === 0 && waitMs > 0) {
				await notifier.waitForChange(vaultId, waitMs);
				page = readChangesSince(db, vaultId, since, pageSize);
			}

			const response: ChangesResponse = {
				changes: page.changes,
				hasMore: page.hasMore,
				seq: latestSeq(db, vaultId),
			};
			return reply.send(response);
		},
	);
}
```

- [ ] **Step 4: Register the route**

In `packages/server/src/app.ts`, add the import and registration inside the authenticated scope:

```typescript
import { registerChangeRoutes } from './routes/changes.js';
```

```typescript
		registerChangeRoutes(scope, dependencies);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/server/src`
Expected: PASS — 9 new cases, everything earlier still green.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src
git commit -m "feat: add long-poll changes endpoint with capped wait"
```

---

## Task 14: WebSocket nudge channel with ticket authentication

The browser `WebSocket` constructor cannot set request headers, so the `Authorization` scheme used everywhere else is unavailable at upgrade time. Putting the long-lived token in the query string would write a credential into every access log and proxy trace. Instead the client spends its bearer token once over ordinary HTTP for a single-use, 60-second ticket, and presents that at upgrade.

**Files:**
- Create: `packages/server/src/tickets.ts`
- Modify: `packages/server/src/routes/changes.ts` — add the ticket and stream routes
- Modify: `packages/server/src/app.ts` — register `@fastify/websocket`
- Test: `packages/server/src/tickets.test.ts`

**Interfaces:**
- Consumes: `ChangeNotifier`; `AppDependencies`.
- Produces: `class TicketStore { issue(username: string, vaultId: string): { ticket: string; expiresAt: number }; redeem(ticket: string): { username: string; vaultId: string } | undefined; size(): number }`, `registerStreamRoutes(scope: FastifyInstance, dependencies: AppDependencies): void`.

- [ ] **Step 1: Add the WebSocket dependency**

Run: `pnpm --filter @obsidian-sync/server add @fastify/websocket`

- [ ] **Step 2: Write the failing test**

`packages/server/src/tickets.test.ts`:
```typescript
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/tickets.test.ts`
Expected: FAIL — `Failed to resolve import "./tickets.js"`.

- [ ] **Step 4: Write the ticket store**

`packages/server/src/tickets.ts`:
```typescript
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/tickets.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Add the ticket and stream routes**

Append to `packages/server/src/routes/changes.ts`:

```typescript
export function registerStreamRoutes(scope: FastifyInstance, dependencies: AppDependencies): void {
	const { db, notifier, tickets } = dependencies;

	scope.post<{ Params: { vaultId: string } }>(
		'/v1/vaults/:vaultId/stream-ticket',
		async (request, reply) => {
			const { vaultId } = request.params;
			if (findVaultForOwner(db, vaultId, request.username) === undefined) {
				return reply.code(404).send({ error: 'vault_not_found' });
			}
			return reply.send(tickets.issue(request.username, vaultId));
		},
	);
}
```

Add to the imports at the top of that file:

```typescript
import { latestSeq, readChangesSince } from '../changes.js';
```

is already present; no change needed there. Add nothing else.

Register the unauthenticated upgrade route in `packages/server/src/app.ts`, outside the authenticated scope because the ticket is the credential:

```typescript
import websocket from '@fastify/websocket';
import { registerStreamRoutes } from './routes/changes.js';
```

```typescript
	app.register(websocket);

	app.register(async (scope) => {
		scope.get<{ Params: { vaultId: string }; Querystring: { ticket?: string } }>(
			'/v1/vaults/:vaultId/stream',
			{ websocket: true },
			(socket, request) => {
				const redeemed =
					request.query.ticket === undefined
						? undefined
						: dependencies.tickets.redeem(request.query.ticket);

				if (redeemed === undefined || redeemed.vaultId !== request.params.vaultId) {
					socket.close(4401, 'unauthorized');
					return;
				}

				let open = true;
				const pump = async (): Promise<void> => {
					while (open) {
						await dependencies.notifier.waitForChange(
							request.params.vaultId,
							dependencies.config.longpollMaxWaitMs,
						);
						if (!open) {
							return;
						}
						// Sequence numbers only. The socket never carries file data, so a
						// dropped connection costs nothing beyond a delayed nudge.
						socket.send(
							JSON.stringify({ seq: latestSeq(dependencies.db, request.params.vaultId) }),
						);
					}
				};

				socket.on('close', () => {
					open = false;
				});

				pump().catch(() => {
					open = false;
					socket.close();
				});
			},
		);
	});
```

Extend `AppDependencies` in the same file with `tickets: TicketStore;` and add `import { TicketStore } from './tickets.js';`. Add `registerStreamRoutes(scope, dependencies);` to the authenticated scope. Every existing test's dependency object must gain `tickets: new TicketStore(60_000)`.

- [ ] **Step 7: Run the full suite**

Run: `pnpm vitest run packages/server/src && pnpm typecheck`
Expected: PASS after adding `tickets` to each test fixture.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src pnpm-lock.yaml
git commit -m "feat: add websocket nudge channel with single-use ticket auth"
```

---

## Task 15: Version retention and orphan blob sweep

**Files:**
- Create: `packages/server/src/retention.ts`
- Test: `packages/server/src/retention.test.ts`

**Interfaces:**
- Consumes: `BlobStore`; `ServerConfig`.
- Produces: `pruneVersions(db: DatabaseSync, vaultId: string, options: { retentionDays: number; retentionMin: number }): number`, `sweepOrphanBlobs(db: DatabaseSync, blobs: BlobStore, vaultId: string, graceMs: number): Promise<number>`.

Pruning never touches a file's head version, regardless of age. The sweep skips blobs younger than the grace period, because an uploaded chunk sits at refcount 0 until its commit lands, and reclaiming one mid-upload would corrupt the version being written.

- [ ] **Step 1: Write the failing test**

`packages/server/src/retention.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type BlobStore, createBlobStore } from './blobs.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { commitVersion } from './files.js';
import { pruneVersions, sweepOrphanBlobs } from './retention.js';

const fileId = 'f'.repeat(64);
const dayMs = 24 * 60 * 60 * 1000;

let directory: string;
let db: DatabaseSync;
let blobs: BlobStore;

function chunkAddress(index: number): string {
	return index.toString(16).padStart(64, '0');
}

async function knownChunk(address: string): Promise<void> {
	await blobs.put('v1', address, new Uint8Array([1]));
	db.prepare('INSERT INTO blob_ref (vault_id, addr, bytes, refcount) VALUES (?, ?, 1, 0)').run(
		'v1',
		address,
	);
}

function ageVersion(versionId: string, days: number): void {
	db.prepare('UPDATE version SET created_at = ? WHERE version_id = ?').run(
		Date.now() - days * dayMs,
		versionId,
	);
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-retention-'));
	db = openDatabase(join(directory, 'sync.db'));
	blobs = createBlobStore(join(directory, 'blobs'));
	db.prepare(
		'INSERT INTO vault (id, name, owner, kdf_salt, created_at) VALUES (?, ?, ?, ?, ?)',
	).run('v1', 'personal', 'alice', Buffer.alloc(16), Date.now());
});

afterEach(async () => {
	closeDatabase(db);
	await rm(directory, { recursive: true, force: true });
});

async function buildChain(length: number): Promise<string[]> {
	const versionIds: string[] = [];
	let parent: string | undefined;

	for (let index = 0; index < length; index += 1) {
		const address = chunkAddress(index);
		await knownChunk(address);
		const outcome = commitVersion(db, {
			vaultId: 'v1',
			fileId,
			parentVersion: parent,
			metaBlob: 'bWV0YQ==',
			chunks: [address],
			size: 1,
			deviceId: 'device-1',
		});
		if (outcome.status !== 'committed') {
			throw new Error(`commit ${index} failed with ${outcome.status}`);
		}
		versionIds.push(outcome.versionId);
		parent = outcome.versionId;
	}
	return versionIds;
}

describe('pruneVersions', () => {
	test('keeps everything when nothing is old enough', async () => {
		await buildChain(5);
		expect(pruneVersions(db, 'v1', { retentionDays: 90, retentionMin: 2 })).toBe(0);
	});

	test('removes versions older than the retention window', async () => {
		const versions = await buildChain(5);
		for (const versionId of versions.slice(0, 3)) {
			ageVersion(versionId, 200);
		}
		expect(pruneVersions(db, 'v1', { retentionDays: 90, retentionMin: 1 })).toBe(3);
	});

	test('always keeps the configured minimum, however old they are', async () => {
		const versions = await buildChain(5);
		for (const versionId of versions) {
			ageVersion(versionId, 200);
		}
		pruneVersions(db, 'v1', { retentionDays: 90, retentionMin: 3 });
		const remaining = db
			.prepare('SELECT COUNT(*) AS total FROM version WHERE vault_id = ?')
			.get('v1') as { total: number };
		expect(remaining.total).toBe(3);
	});

	test('never removes the head version', async () => {
		const versions = await buildChain(3);
		for (const versionId of versions) {
			ageVersion(versionId, 500);
		}
		pruneVersions(db, 'v1', { retentionDays: 1, retentionMin: 1 });

		const head = db
			.prepare('SELECT head_version FROM file WHERE vault_id = ? AND file_id = ?')
			.get('v1', fileId) as { head_version: string };
		const survivor = db
			.prepare('SELECT version_id FROM version WHERE vault_id = ? AND file_id = ?')
			.all('v1', fileId) as { version_id: string }[];

		expect(survivor.map((row) => row.version_id)).toContain(head.head_version);
	});

	test('releases the chunk references of pruned versions', async () => {
		const versions = await buildChain(3);
		ageVersion(versions[0] as string, 200);
		pruneVersions(db, 'v1', { retentionDays: 90, retentionMin: 1 });

		const released = db
			.prepare('SELECT refcount FROM blob_ref WHERE vault_id = ? AND addr = ?')
			.get('v1', chunkAddress(0)) as { refcount: number };
		expect(released.refcount).toBe(0);
	});
});

describe('sweepOrphanBlobs', () => {
	test('leaves referenced blobs alone', async () => {
		await buildChain(1);
		expect(await sweepOrphanBlobs(db, blobs, 'v1', 0)).toBe(0);
		await expect(blobs.has('v1', chunkAddress(0))).resolves.toBe(true);
	});

	test('reclaims an unreferenced blob past the grace period', async () => {
		await knownChunk(chunkAddress(9));
		expect(await sweepOrphanBlobs(db, blobs, 'v1', 0)).toBe(1);
		await expect(blobs.has('v1', chunkAddress(9))).resolves.toBe(false);
	});

	test('removes the blob_ref row alongside the blob', async () => {
		await knownChunk(chunkAddress(9));
		await sweepOrphanBlobs(db, blobs, 'v1', 0);
		expect(
			db
				.prepare('SELECT 1 FROM blob_ref WHERE vault_id = ? AND addr = ?')
				.get('v1', chunkAddress(9)),
		).toBeUndefined();
	});

	// An upload sits at refcount 0 until its commit lands; reclaiming it mid-flight
	// would corrupt the version being written.
	test('spares a freshly uploaded blob still inside the grace period', async () => {
		await knownChunk(chunkAddress(9));
		expect(await sweepOrphanBlobs(db, blobs, 'v1', 60_000)).toBe(0);
		await expect(blobs.has('v1', chunkAddress(9))).resolves.toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/retention.test.ts`
Expected: FAIL — `Failed to resolve import "./retention.js"`.

- [ ] **Step 3: Write the implementation**

`packages/server/src/retention.ts`:
```typescript
import type { DatabaseSync } from 'node:sqlite';
import type { BlobStore } from './blobs.js';

const dayMs = 24 * 60 * 60 * 1000;

export function pruneVersions(
	db: DatabaseSync,
	vaultId: string,
	options: { retentionDays: number; retentionMin: number },
): number {
	const cutoff = Date.now() - options.retentionDays * dayMs;

	db.exec('BEGIN IMMEDIATE');
	try {
		// Rank newest-first per file, then drop only rows that are both beyond the
		// keep-count and older than the cutoff, and never the current head.
		const candidates = db
			.prepare(
				`SELECT v.file_id, v.version_id, v.chunks
				 FROM (
				   SELECT file_id, version_id, chunks, created_at,
				          ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, rowid DESC) AS rank
				   FROM version WHERE vault_id = ?
				 ) v
				 LEFT JOIN file f ON f.vault_id = ? AND f.file_id = v.file_id
				 WHERE v.rank > ? AND v.created_at < ?
				   AND (f.head_version IS NULL OR f.head_version <> v.version_id)`,
			)
			.all(vaultId, vaultId, options.retentionMin, cutoff) as {
			file_id: string;
			version_id: string;
			chunks: string;
		}[];

		const removeVersion = db.prepare(
			'DELETE FROM version WHERE vault_id = ? AND file_id = ? AND version_id = ?',
		);
		const release = db.prepare(
			'UPDATE blob_ref SET refcount = MAX(refcount - 1, 0) WHERE vault_id = ? AND addr = ?',
		);

		for (const candidate of candidates) {
			removeVersion.run(vaultId, candidate.file_id, candidate.version_id);
			for (const address of new Set(JSON.parse(candidate.chunks) as string[])) {
				release.run(vaultId, address);
			}
		}

		db.exec('COMMIT');
		return candidates.length;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export async function sweepOrphanBlobs(
	db: DatabaseSync,
	blobs: BlobStore,
	vaultId: string,
	graceMs: number,
): Promise<number> {
	const orphans = db
		.prepare('SELECT addr FROM blob_ref WHERE vault_id = ? AND refcount <= 0')
		.all(vaultId) as { addr: string }[];

	const youngerThan = Date.now() - graceMs;
	const forget = db.prepare('DELETE FROM blob_ref WHERE vault_id = ? AND addr = ?');
	let reclaimed = 0;

	for (const { addr } of orphans) {
		const writtenAt = await blobs.writtenAt(vaultId, addr);
		if (writtenAt !== undefined && writtenAt > youngerThan) {
			continue;
		}

		// Blob first, row second — the same ordering as an upload, for the same
		// reason: a row without a blob is corruption, a blob without a row is litter.
		await blobs.remove(vaultId, addr);
		forget.run(vaultId, addr);
		reclaimed += 1;
	}

	return reclaimed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/retention.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/retention.ts packages/server/src/retention.test.ts
git commit -m "feat: add version retention pruning and orphan blob sweep"
```

---

## Task 16: Entry point, graceful shutdown and two-client integration test

The integration test is the highest-value suite in the plan. Sync defects live in races between devices, not in units — this is the test that would have caught them.

**Files:**
- Create: `packages/server/src/index.ts`
- Test: `packages/server/src/integration.test.ts`

**Interfaces:**
- Consumes: everything built so far.
- Produces: `startServer(env: Record<string, string | undefined>): Promise<{ app: FastifyInstance; dependencies: AppDependencies; stop(): Promise<void> }>`.

- [ ] **Step 1: Add the shutdown dependency**

Run: `pnpm --filter @obsidian-sync/server add close-with-grace`

- [ ] **Step 2: Write the failing integration test**

`packages/server/src/integration.test.ts`:
```typescript
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppDependencies } from './app.js';
import { startServer } from './index.js';

const aliceToken = 'a'.repeat(40);

let directory: string;
let app: FastifyInstance;
let dependencies: AppDependencies;
let stop: () => Promise<void>;
let vaultId: string;

const headers = { authorization: `Bearer ${aliceToken}` };

/** Stands in for a device: derives addresses the way the plugin will. */
class VirtualClient {
	readonly #contentKey = Buffer.from('k'.repeat(32));
	cursor = 0;

	address(content: string): string {
		return createHmac('sha256', this.#contentKey).update(content).digest('hex');
	}

	async upload(content: string): Promise<string> {
		const address = this.address(content);
		await app.inject({
			method: 'PUT',
			url: `/v1/vaults/${vaultId}/blobs/${address}`,
			headers: { ...headers, 'content-type': 'application/octet-stream' },
			payload: Buffer.from(content),
		});
		return address;
	}

	async commit(fileId: string, content: string, parentVersion: string | undefined) {
		const address = await this.upload(content);
		return app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/files/${fileId}`,
			headers,
			payload: {
				parentVersion,
				metaBlob: Buffer.from(content).toString('base64'),
				chunks: [address],
				size: content.length,
				deviceId: 'device',
			},
		});
	}

	async pull(): Promise<{ fileId: string; kind: string }[]> {
		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/changes?since=${this.cursor}&wait=0`,
			headers,
		});
		const body = response.json() as {
			changes: { seq: number; fileId: string; kind: string }[];
			seq: number;
		};
		this.cursor = body.seq;
		return body.changes.map((change) => ({ fileId: change.fileId, kind: change.kind }));
	}
}

const fileId = 'a1'.padEnd(64, '0');

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'sync-integration-'));
	const started = await startServer({
		DATA_DIR: directory,
		LOG_LEVEL: 'silent',
		SYNC_USER_ALICE: aliceToken,
		PORT: '0',
	});
	app = started.app;
	dependencies = started.dependencies;
	stop = started.stop;

	const created = await app.inject({
		method: 'POST',
		url: '/v1/vaults',
		headers,
		payload: { name: 'personal' },
	});
	vaultId = created.json().id;
});

afterEach(async () => {
	await stop();
	await rm(directory, { recursive: true, force: true });
});

describe('two devices sharing one vault', () => {
	test('a commit from one device reaches the other', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		await laptop.commit(fileId, 'hello from the laptop', undefined);
		const seen = await phone.pull();

		expect(seen).toEqual([{ fileId, kind: 'upsert' }]);
	});

	test('the second concurrent writer is rejected, not silently overwritten', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		const created = await laptop.commit(fileId, 'base', undefined);
		const baseVersion = created.json().versionId;

		const laptopEdit = await laptop.commit(fileId, 'laptop edit', baseVersion);
		expect(laptopEdit.statusCode).toBe(201);

		// The phone still believes baseVersion is current. This is the case the
		// entire client-side merge design depends on being detected.
		const phoneEdit = await phone.commit(fileId, 'phone edit', baseVersion);
		expect(phoneEdit.statusCode).toBe(409);
		expect(phoneEdit.json().headVersion).toBe(laptopEdit.json().versionId);
	});

	test('the loser converges after pulling and retrying', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		const created = await laptop.commit(fileId, 'base', undefined);
		const baseVersion = created.json().versionId;
		const winner = await laptop.commit(fileId, 'laptop edit', baseVersion);

		const rejected = await phone.commit(fileId, 'phone edit', baseVersion);
		const retry = await phone.commit(fileId, 'merged', rejected.json().headVersion);

		expect(retry.statusCode).toBe(201);
		expect(winner.json().versionId).not.toBe(retry.json().versionId);
	});

	test('an identical chunk from a second device is not re-uploaded', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		await laptop.upload('shared content');
		const response = await app.inject({
			method: 'POST',
			url: `/v1/vaults/${vaultId}/blobs/check`,
			headers,
			payload: { addresses: [phone.address('shared content')] },
		});

		expect(response.json().missing).toEqual([]);
	});

	test('a delete propagates as a delete change', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();

		const created = await laptop.commit(fileId, 'doomed', undefined);
		await phone.pull();

		await app.inject({
			method: 'DELETE',
			url: `/v1/vaults/${vaultId}/files/${fileId}?parentVersion=${created.json().versionId}`,
			headers,
		});

		expect(await phone.pull()).toEqual([{ fileId, kind: 'delete' }]);
	});

	test('a device that was offline catches up from its stored cursor', async () => {
		const laptop = new VirtualClient();
		const phone = new VirtualClient();
		await phone.pull();

		let parent: string | undefined;
		for (let index = 0; index < 3; index += 1) {
			const response = await laptop.commit(fileId, `revision ${index}`, parent);
			parent = response.json().versionId;
		}

		expect(await phone.pull()).toHaveLength(3);
		expect(await phone.pull()).toEqual([]);
	});

	test('vault state lists live files with the current sequence', async () => {
		const laptop = new VirtualClient();
		await laptop.commit(fileId, 'content', undefined);

		const response = await app.inject({
			method: 'GET',
			url: `/v1/vaults/${vaultId}/state`,
			headers,
		});
		const body = response.json() as { files: { fileId: string }[]; seq: number };

		expect(body.files.map((file) => file.fileId)).toEqual([fileId]);
		expect(body.seq).toBeGreaterThan(0);
	});
});

describe('startServer', () => {
	test('creates the data directory and opens the database', () => {
		expect(dependencies.db).toBeDefined();
	});

	test('refuses to start with no users configured', async () => {
		await expect(startServer({ DATA_DIR: directory, LOG_LEVEL: 'silent' })).rejects.toThrow(
			/no users configured/,
		);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/integration.test.ts`
Expected: FAIL — `Failed to resolve import "./index.js"`.

- [ ] **Step 4: Write the entry point**

`packages/server/src/index.ts`:
```typescript
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import closeWithGrace from 'close-with-grace';
import type { FastifyInstance } from 'fastify';
import { type AppDependencies, buildApp } from './app.js';
import { createBlobStore } from './blobs.js';
import { ChangeNotifier } from './changes.js';
import { loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { SerialWriter } from './db/writer.js';
import { TicketStore } from './tickets.js';
import { buildUserRegistry } from './users.js';

const streamTicketLifetimeMs = 60_000;

export async function startServer(env: Record<string, string | undefined>): Promise<{
	app: FastifyInstance;
	dependencies: AppDependencies;
	stop(): Promise<void>;
}> {
	const config = loadConfig(env);
	const users = buildUserRegistry(env);

	await mkdir(config.dataDir, { recursive: true });

	const dependencies: AppDependencies = {
		config,
		users,
		db: openDatabase(join(config.dataDir, 'sync.db')),
		writer: new SerialWriter(),
		blobs: createBlobStore(join(config.dataDir, 'blobs')),
		notifier: new ChangeNotifier(),
		tickets: new TicketStore(streamTicketLifetimeMs),
	};

	const app = buildApp(dependencies);
	await app.ready();

	return {
		app,
		dependencies,
		async stop() {
			await app.close();
			closeDatabase(dependencies.db);
		},
	};
}

// Import-time side effects would break the tests, which call startServer directly.
if (process.argv[1]?.endsWith('index.js') === true) {
	const started = await startServer(process.env);
	await started.app.listen({ port: started.dependencies.config.port, host: started.dependencies.config.host });

	closeWithGrace({ delay: 10_000 }, async ({ err }) => {
		if (err !== undefined) {
			started.app.log.error({ err }, 'shutting down after an unhandled error');
		}
		await started.stop();
	});
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/src/integration.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 6: Run everything and verify the server boots for real**

Run: `pnpm test && pnpm lint && pnpm typecheck && pnpm build`
Then: `DATA_DIR=./data SYNC_USER_ALICE=$(openssl rand -hex 24) node packages/server/dist/index.js`
Expected: listens on 3000; `curl localhost:3000/v1/health` returns `{"status":"ok","protocolVersion":1}`; Ctrl-C exits cleanly with no dangling handles.

- [ ] **Step 7: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat: add server entry point, graceful shutdown and two-device integration tests"
```

---

## Task 17: Container image and GitHub Actions

**Files:**
- Create: `packages/server/Dockerfile`
- Create: `.dockerignore`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the built server package.
- Produces: `ghcr.io/<owner>/obsidian-sync-server` images tagged `main`, `sha-<short>`, and semver on tags.

- [ ] **Step 1: Write the Dockerfile**

`packages/server/Dockerfile` (build context is the repository root):
```dockerfile
FROM node:26-trixie-slim AS build
RUN corepack enable
WORKDIR /src

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/server packages/server
RUN pnpm --filter @obsidian-sync/protocol build \
 && pnpm --filter @obsidian-sync/server build \
 && pnpm deploy --filter @obsidian-sync/server --prod /out

# No shell, no package manager, non-root by default. Entrypoint is already node,
# so CMD is just the script path. Storage is node:sqlite, built into the Node
# binary, so there are no native modules to compile on either architecture.
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["/app/dist/index.js"]
```

`.dockerignore`:
```
node_modules
**/node_modules
**/dist
.git
data
docs
```

- [ ] **Step 2: Build and run the image locally**

Run:
```bash
docker build -f packages/server/Dockerfile -t obsidian-sync-server:dev .
docker run --rm -p 3000:3000 -e SYNC_USER_ALICE=$(openssl rand -hex 24) \
  -v obsidian-sync-data:/data obsidian-sync-server:dev
```
Expected: `curl localhost:3000/v1/health` returns `{"status":"ok","protocolVersion":1}`.

Confirm the volume is writable by the non-root user. If the container reports `EACCES` on `/data`, add `--user` mapping or pre-create the volume with the right ownership, and record the resolution in the README.

- [ ] **Step 3: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 4: Write the release workflow**

`.github/workflows/release.yml`:
```yaml
name: Release

on:
  push:
    branches: [main]
    tags: ['v*']

jobs:
  image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v5

      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/obsidian-sync-server
          tags: |
            type=ref,event=branch
            type=sha,prefix=sha-
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          file: packages/server/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 5: Verify the first publish links the package to the repository**

Push to `main`, then confirm the workflow succeeded and the package appears under the repository's Packages tab.

If the push fails with `denied: permission_denied: write_package`, the package exists but is not linked to this repository — that happens when a package is first created by a manual push using a personal access token, and `GITHUB_TOKEN` cannot then write to it. Fix by deleting the orphaned package in the organisation's package settings and re-running the workflow, so the workflow itself creates and auto-links it. Never work around this by switching the workflow to a personal access token.

- [ ] **Step 6: Commit**

```bash
git add packages/server/Dockerfile .dockerignore .github
git commit -m "chore: add distroless container image and CI/release workflows"
```

---

## Verification Checklist

Run before declaring Plan 1 complete:

- [ ] `pnpm lint && pnpm build && pnpm typecheck && pnpm test` all pass from a clean clone.
- [ ] `docker build` succeeds and the container serves `/v1/health`.
- [ ] Two `SYNC_USER_*` entries cannot read each other's vaults (covered by `vaults.test.ts`).
- [ ] A stale `parentVersion` returns `409` with the real head, and writes nothing (covered by `files.test.ts`).
- [ ] Killing the process mid-upload leaves an orphan blob, never a `version` row referencing a missing blob.
- [ ] A long-poll with no traffic returns empty at the ceiling and leaves `notifier.waiterCount()` at zero.
- [ ] The server source contains no code path that decodes `meta_blob` or a chunk body.

---

## Plan Self-Review

**Spec coverage.** Walked spec sections 3 through 10 against the tasks:

| Spec section | Task |
|---|---|
| §3 protocol package, HTTP not gRPC | 1–3 |
| §4.2 path-derived identity, NFC | 1 |
| §4.4 envelope format, chunk binding | 3 |
| §5.1–5.2 storage layout, schema | 5, 7 |
| §5.3 durability ordering | 7, 11, 15 |
| §5.4 single writer | 6 |
| §5.5 API surface | 10–14 |
| §5.6 optimistic concurrency | 12 |
| §5.7 bearer auth from env | 4, 9 |
| §5.8 configuration | 4 |
| §10.1 container | 17 |
| §10.2 workflows | 17 |
| §11 two-client integration | 16 |

Two corrections applied during review:

1. **`src/vaults.ts`, `src/files.ts`, and `src/tickets.ts` were missing from the File Structure section** — they exist as data-access modules separate from their `routes/` counterparts, so that SQL is testable without HTTP. Treat the File Structure block as including them.
2. **WebSocket authentication was unspecified in the spec's API table.** The browser `WebSocket` constructor cannot set an `Authorization` header, which the spec did not account for. Task 14 introduces `POST /v1/vaults/:vaultId/stream-ticket` and a single-use ticket rather than putting a long-lived token in a query string. **Update spec §5.5 to add this endpoint** when Task 14 lands.

**Type consistency.** `CommitOutcome.status` is `'missingChunks'` (camelCase) in TypeScript throughout, while the HTTP error body uses `missing_chunks` (snake_case) to match the other wire-level error codes — this is deliberate and consistent in both directions. `ChangeEntry.versionId` is `string | undefined` in TypeScript and SQL `NULL` in storage, converted in exactly one place, `readChangesSince`.

**Deferred to Plan 2, deliberately not covered here:** all cryptographic key derivation (server holds no keys), three-way merge, selective sync, and every UI surface in spec §6.3.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-09-10-server-and-protocol.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

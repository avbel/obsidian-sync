# Payload Compression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut mobile data usage by compressing file contents *inside* the encrypted envelope, using the platform's own `CompressionStream` — no new dependency, no change to what the server can see.

---

## Background

**Why HTTP compression alone is nearly useless here.** The server stores and serves ciphertext. Encrypted bytes are indistinguishable from random, so `Content-Encoding: gzip` over a blob body saves nothing. Compression has to happen client-side, before encryption, or not at all.

**Where the traffic actually goes.** `#pushFile` re-reads the whole file, splits it at fixed 4 MB offsets, and uploads every chunk whose address the server does not already hold (`sync.ts`). `defaultChunkBytes` is 4 MB, so any note smaller than that is exactly one chunk — and **one changed character re-uploads the entire note**. Every sync of every edited note pays full size in both directions. That is the bill compression reduces.

**Measured on the maintainer's vault, 2026-09-12** (33 files, `.trash` and the never-synced plugin dir excluded):

| size bucket | files | raw | gzip | deflate-raw | gzip ratio | deflate-raw ratio |
|---|---|---|---|---|---|---|
| <512 B | 14 | 3,208 | 2,303 | 2,051 | 0.72 | **0.64** |
| 512 B – 4 K | 5 | 6,524 | 2,392 | 2,302 | 0.37 | **0.35** |
| 4 K – 64 K | 8 | 78,057 | 16,550 | 16,406 | 0.21 | 0.21 |
| >64 K | 6 | 2,618,636 | 680,477 | 680,369 | 0.26 | 0.26 |

Three conclusions drive the design:

1. **`deflate-raw`, not `gzip`.** Identical ratio once files are large, but gzip's header, trailer and CRC cost ~18 bytes per file, which is material when a note is a few hundred bytes and is re-uploaded whole on every edit. Both are values of the same `CompressionStream` API, so this costs nothing. *(If gzip is preferred for inspectability, it is a one-word change in `compress.ts` plus the `Compression` union.)*
2. **Keep the result only when it is smaller.** 3 of 33 files did not shrink. Already-compressed attachments — images, PDFs, zips — will grow. The decision is per file and is recorded, not inferred from the extension.
3. **That vault is a test vault** (3 markdown files, 588 B). The config directory dominates it and compresses to 0.26. Real note-heavy vaults should land near the 4 K–64 K row, ~0.21. Re-measure before quoting a number to users.

**What stays the same.** `FileState.size` remains the *plaintext* byte length: it feeds `maxFileBytes` in both `#pushPath` and `planReconcile`, and a size limit the user set must not silently change meaning because a file compressed well. Only the bytes on the wire shrink.

### The compatibility hazard — read before writing any code

`decryptFileMeta` parses the meta envelope as JSON and ignores unknown fields. A client that predates this feature will therefore read a compressed version, **ignore the `compression` field, and write the compressed bytes into the note as if they were plaintext.** That is silent data corruption, not a clean failure, and nothing in the current format can make an old client fail safely instead.

So this ships in two phases, and phase 2 is gated on a setting the user turns on deliberately:

- **Phase 1 (Tasks 1–4):** every client learns to *decompress*. Nothing ever produces compressed output. Safe to roll out one device at a time.
- **Phase 2 (Task 5):** a setting, default off, lets a client start *producing* compressed versions. The user enables it only once every device is on a phase-1 build or newer.

Out of scope: content-defined chunking. Fixed-offset chunks mean an insert near the start of a large file re-uploads every chunk; rolling-hash boundaries would fix that and are a bigger win for large files than compression is. Separate plan.

---

## Task 1: The compression primitive

- [x] **Step 1: Write the failing tests**

Create `packages/plugin/src/crypto/compress.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { textToBytes } from './encoding.js';
import { compress, decompress, isCompressionSupported } from './compress.js';

describe('compress', () => {
	test('round-trips text through deflate-raw', async () => {
		const original = textToBytes('# Note\n'.repeat(200));
		const packed = await compress(original);
		expect(packed).not.toBeUndefined();
		expect(packed?.byteLength).toBeLessThan(original.byteLength);
		expect(await decompress(packed as Uint8Array)).toEqual(original);
	});

	// 3 of 33 files in the reference vault did not shrink; attachments never will.
	test('declines when the result is not smaller', async () => {
		const incompressible = crypto.getRandomValues(new Uint8Array(4096));
		expect(await compress(incompressible)).toBeUndefined();
	});

	test('declines an empty input rather than emitting a frame for nothing', async () => {
		expect(await compress(new Uint8Array(0))).toBeUndefined();
	});

	test('round-trips bytes that are not valid UTF-8', async () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x01]);
		const packed = await compress(new Uint8Array([...bytes, ...new Uint8Array(2048)]));
		expect(await decompress(packed as Uint8Array)).toHaveLength(2056);
	});

	test('reports support so an old WebView degrades instead of throwing', () => {
		expect(typeof isCompressionSupported()).toBe('boolean');
	});
});
```

- [x] **Step 2: Run them and watch them fail**

- [x] **Step 3: Implement `packages/plugin/src/crypto/compress.ts`**

```ts
/**
 * `deflate-raw` rather than gzip: identical ratio at size, but gzip's header, trailer
 * and CRC cost ~18 bytes per file, and a note is usually a few hundred bytes that is
 * re-uploaded whole on every edit. Both are values of the same platform API.
 */
const format = 'deflate-raw';

/** iOS below 16.4 has no CompressionStream; such a device must still sync, uncompressed. */
export function isCompressionSupported(): boolean {
	return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function run(data: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
	const blob = new Blob([data as BlobPart]);
	return new Uint8Array(await new Response(blob.stream().pipeThrough(stream)).arrayBuffer());
}

/** The compressed bytes, or undefined when compression does not pay for itself. */
export async function compress(data: Uint8Array): Promise<Uint8Array | undefined> {
	if (data.byteLength === 0 || !isCompressionSupported()) {
		return undefined;
	}
	const packed = await run(data, new CompressionStream(format));
	return packed.byteLength < data.byteLength ? packed : undefined;
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
	return run(data, new DecompressionStream(format));
}
```

- [x] **Step 4: Run the tests, then `pnpm lint && pnpm typecheck && pnpm test`, and commit**

---

## Task 2: Record the choice in the encrypted meta

- [x] **Step 1: Extend `FileMeta` in `packages/plugin/src/crypto/meta.ts`**

```ts
/** Absent on every version written before compression existed, which means stored as-is. */
compression?: 'deflate-raw' | undefined;
```

It lives inside the meta envelope, so the server learns nothing new: it cannot tell a compressed version from an uncompressed one. `aadForFile` is unchanged, so the file↔meta binding is untouched.

- [x] **Step 2: Add a test to `packages/plugin/src/crypto/crypto.test.ts`**

Assert a meta sealed **without** `compression` decrypts to `compression === undefined` — that is the backward-compatibility contract every existing version in the vault depends on.

- [x] **Step 3: Typecheck and commit**

---

## Task 3: Decompress on the read path

Phase 1 begins here: after this task a client understands compressed versions but still never writes one.

- [x] **Step 1: Write the failing test in `packages/plugin/src/engine/codec.test.ts`**

Seal a file whose meta says `compression: 'deflate-raw'` and whose chunks hold deflated bytes, then assert `decodeFile` returns the original plaintext. Add a second case with no `compression` field asserting the bytes come back untouched.

- [x] **Step 2: Implement in `packages/plugin/src/engine/codec.ts`**

In `decodeFile`, after the chunks are reassembled and before the bytes are returned:

```ts
const data = meta.compression === 'deflate-raw' ? await decompress(joined) : joined;
```

Leave `encodeFile` alone in this task.

- [x] **Step 3: Run the tests and commit**

---

## Task 4: Ship phase 1

- [x] **Step 1: Release a version whose only compression change is the ability to read it**

- [x] **Step 2: Update every device, and verify**

Every device must report the phase-1 version or newer in *Settings → Community plugins*. Do not continue to Task 5 until that is true of all of them. A device left behind will write compressed bytes into notes as plaintext once phase 2 is enabled anywhere.

---

## Task 5: Compress on the write path, behind a setting

- [x] **Step 1: Add the setting**

`PluginSettings.compressUploads: boolean`, default **false**, in `packages/plugin/src/settings.ts`. In the settings tab, under **Sync**:

> **Compress uploads** — Compress note contents before encrypting them. Saves mobile data. Every device must be updated first: an older device will read compressed notes as gibberish.

- [x] **Step 2: Write the failing engine test**

In `packages/plugin/src/engine/queue-engine.test.ts` or a new `compression-engine.test.ts`: a device with compression on pushes a compressible note; a second device with compression **off** pulls it and sees the original text. That asserts the read path is independent of the writer's setting, which is the whole compatibility story.

Add a second test: a device with compression on pushes incompressible bytes, and the committed meta has no `compression` field — the store-if-smaller rule holds end to end.

- [x] **Step 3: Thread the flag through**

`EncodeFileOptions` grows `compress: boolean`. In `encodeFile`, before `splitChunks`:

```ts
const packed = options.compress ? await compress(options.data) : undefined;
const body = packed ?? options.data;
```

Chunk and encrypt `body`; set `compression: packed === undefined ? undefined : 'deflate-raw'` in the meta. **`size` stays `options.data.length`** — the plaintext length — because `maxFileBytes` is a user-facing limit in both `#pushPath` and `planReconcile` and must not change meaning.

`SyncEngineDeps` grows the flag alongside `selective`, and `updateSelective` (or a sibling) carries a settings change into a running engine the way the other live settings do.

- [x] **Step 4: Run the whole suite, `pnpm build`, and commit**

- [x] **Step 5: Verify by hand across two real devices**

1. Enable *Compress uploads* on device A only.
2. Edit a note of a few KB. Confirm on device B that the text arrives intact.
3. Check the server: `sqlite3 -readonly ~/apps/obsidian-sync/data/sync.db "SELECT size FROM version ORDER BY created_at DESC LIMIT 1;"` — `size` is still the plaintext length, while the blob on disk is smaller.
4. Add an image. Confirm it still opens on B and that its version carries no `compression` field.

---

## Task 6 (optional): HTTP compression for the JSON endpoints

Separate from the above and worth far less, but nearly free. `/state` returns every file's `metaBlob` as base64, and base64 carries ~33% expansion that deflate recovers almost entirely.

- [ ] **Step 1: Add `@fastify/compress` to `packages/server`, registered with `global: true` and a threshold around 1 KB**

- [ ] **Step 2: Confirm `requestUrl` handles `Content-Encoding` transparently on desktop *and* mobile**

If it does not decode automatically, stop — do not hand-roll decoding in the transport. Revert and close the task.

- [ ] **Step 3: Assert a large `/state` response carries `content-encoding` in `packages/server/src/routes/files.test.ts`, then commit**

---

## Done when

- [x] A compressible note round-trips between a compressing device and a non-compressing one with byte-identical content.
- [x] An incompressible file is stored as-is, with no `compression` field in its meta.
- [x] Versions written before this feature still open, on a build that has it and on one that does not.
- [x] `size` on the wire is still the plaintext length, so `maxFileBytes` means what the user set.
- [x] A device without `CompressionStream` syncs normally, uncompressed.
- [x] The server has gained no new ability to distinguish or inspect anything.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.
- [x] Measured saving recorded in the README against a real note-heavy vault, not the test vault above.

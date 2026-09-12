import { kdfSaltBytes } from '@obsidian-sync/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { derivePurposeKeys, type PurposeKeys } from '../crypto/keys.js';
import { type Device, makeDevice } from '../testing/devices.js';
import { FakeServer } from '../testing/fake-server.js';
import {
	ApiClient,
	OfflineError,
	type Requester,
	type SyncRequest,
	type SyncResponse,
} from '../transport/client.js';

const salt16 = Buffer.alloc(kdfSaltBytes, 7).toString('base64');

/** An HTTP status to answer every call with, or a transport-level rejection. */
type Fault = number | 'offline';

/** Wraps the fake server so a test can fail calls exactly as the real transport does. */
class FaultyTransport implements Requester {
	fault: Fault | undefined;
	readonly #inner: FakeServer;

	constructor(inner: FakeServer) {
		this.#inner = inner;
	}

	async request(request: SyncRequest): Promise<SyncResponse> {
		if (this.fault === 'offline') {
			throw new OfflineError(new Error('getaddrinfo ENOTFOUND sync.example'));
		}
		if (this.fault !== undefined) {
			return {
				status: this.fault,
				arrayBuffer: new ArrayBuffer(0),
				json: () => ({ error: 'injected' }),
			};
		}
		return this.#inner.request(request);
	}
}

let server: FakeServer;
let transport: FaultyTransport;
let keys: PurposeKeys;
let client: ApiClient;

async function device(deviceId: string): Promise<Device> {
	return makeDevice({ server, keys, client }, deviceId);
}

function queueThree(owner: Device): void {
	for (const name of ['a.md', 'b.md', 'c.md']) {
		owner.vault.putText(name, `${name} body\n`);
		owner.queue.enqueue(name, 'upsert');
	}
}

function attemptedCount(owner: Device): number {
	return owner.queue.all().filter((item) => item.attempts > 0).length;
}

function commitCount(): number {
	return server.requests.filter((entry) => /^POST \/v1\/vaults\/[^/]+\/files\/[^/]+$/.test(entry))
		.length;
}

beforeEach(async () => {
	server = new FakeServer();
	transport = new FaultyTransport(server);
	keys = await derivePurposeKeys('passphrase', salt16);
	client = new ApiClient(transport);
});

describe('drain failure handling', () => {
	test('a server fault backs the whole queue off after one attempt', async () => {
		const laptop = await device('laptop');
		queueThree(laptop);

		transport.fault = 503;
		await laptop.engine.pushAll({ fullScan: false });

		expect(attemptedCount(laptop)).toBe(1);
		expect(laptop.queue.depth()).toEqual({ upserts: 3, deletes: 0, blocked: 0 });
	});

	test('being offline backs the whole queue off instead of re-encrypting every file', async () => {
		const laptop = await device('laptop');
		queueThree(laptop);

		transport.fault = 'offline';
		await laptop.engine.pushAll({ fullScan: false });

		expect(attemptedCount(laptop)).toBe(1);
		expect(laptop.queue.pausedUntil()).toBeGreaterThan(0);
	});

	test('a 4xx defers only its own file and leaves the rest of the queue live', async () => {
		const laptop = await device('laptop');
		queueThree(laptop);

		transport.fault = 400;
		await laptop.engine.pushAll({ fullScan: false });

		expect(attemptedCount(laptop)).toBe(3);
		expect(laptop.queue.pausedUntil()).toBe(0);
	});
});

describe('a rejected token', () => {
	test('halts the drain and stays halted until the queue is resumed', async () => {
		const laptop = await device('laptop');
		queueThree(laptop);

		transport.fault = 401;
		await expect(laptop.engine.pushAll({ fullScan: false })).rejects.toThrow(
			'the sync server rejected the credentials',
		);
		expect(laptop.queue.pausedUntil()).toBe(Number.MAX_SAFE_INTEGER);

		// Correcting the token is not enough on its own: the pause outlives the failure.
		transport.fault = undefined;
		await laptop.engine.pushAll({ fullScan: false });
		expect(server.liveFileCount()).toBe(0);

		// `reloadEngine` resumes the queue on every rebuild — that is the recovery path.
		laptop.queue.resume();
		await laptop.engine.pushAll({ fullScan: false });
		expect(server.liveFileCount()).toBe(3);
	});

	test('charges no attempt, so a corrected token resumes at full speed', async () => {
		const laptop = await device('laptop');
		queueThree(laptop);

		transport.fault = 401;
		await expect(laptop.engine.pushAll({ fullScan: false })).rejects.toThrow();

		expect(laptop.queue.all().every((item) => item.attempts === 0)).toBe(true);
	});

	test('persists the halt and the queue even though the drain threw', async () => {
		const laptop = await device('laptop');
		queueThree(laptop);

		transport.fault = 401;
		await expect(laptop.engine.pushAll({ fullScan: false })).rejects.toThrow();

		const restarted = await makeDevice({ server, keys, client }, 'laptop', {
			vault: laptop.vault,
			storage: laptop.storage,
		});
		expect(restarted.queue.pausedUntil()).toBe(Number.MAX_SAFE_INTEGER);
		expect(restarted.queue.depth()).toEqual({ upserts: 3, deletes: 0, blocked: 0 });
	});
});

describe('the config directory', () => {
	test('an ordinary sync ships a config change no vault event can report', async () => {
		const laptop = await device('laptop');
		// Deliberately not queued: config paths never reach the watcher, so if the
		// incremental push does not scan for them this file never leaves the device.
		laptop.vault.putText('.obsidian/snippets/tweaks.css', '.cm-line { color: red; }\n');

		await laptop.engine.pushAll({ fullScan: false });

		const phone = await device('phone');
		await phone.engine.pullAll();
		expect(phone.vault.getText('.obsidian/snippets/tweaks.css')).toBe('.cm-line { color: red; }\n');
	});

	test('an unchanged config file is not recommitted on the next sync', async () => {
		const laptop = await device('laptop');
		laptop.vault.putText('.obsidian/app.json', '{"readableLineLength":true}\n');
		await laptop.engine.pushAll({ fullScan: false });
		expect(commitCount()).toBe(1);

		await laptop.engine.pushAll({ fullScan: false });
		expect(commitCount()).toBe(1);
	});
});

describe('a path from another device is never trusted', () => {
	test('a traversal path is refused instead of written outside the vault', async () => {
		const attacker = await device('attacker');
		attacker.vault.putText('../../escaped.md', 'pwned\n');
		attacker.vault.putText('legit.md', 'fine\n');
		await attacker.engine.pushAll();
		expect(server.liveFileCount()).toBe(2);

		const victim = await device('victim');
		await victim.engine.pullAll();

		expect(await victim.vault.exists('../../escaped.md')).toBe(false);
		expect(victim.vault.getText('legit.md')).toBe('fine\n');
	});

	test('a dot segment that sidesteps the never-synced prefix is refused', async () => {
		const attacker = await device('attacker');
		// `.obsidian/plugins/obsidian-sync/` is excluded by a raw prefix test, which a
		// `./` segment slips past while still resolving to this plugin's own state dir.
		attacker.vault.putText('.obsidian/plugins/./obsidian-sync/state/index.json', 'clobbered\n');
		await attacker.engine.pushAll();
		expect(server.liveFileCount()).toBe(1);

		const victim = await device('victim');
		await victim.engine.pullAll();

		expect(await victim.vault.exists('.obsidian/plugins/./obsidian-sync/state/index.json')).toBe(
			false,
		);
	});
});

describe('an engine the plugin has replaced', () => {
	test('does not erase work its replacement queued', async () => {
		const first = await device('laptop');
		first.vault.putText('a.md', 'one\n');
		first.queue.enqueue('a.md', 'upsert');
		await first.queue.save();

		// The plugin rebuilt the engine — a settings save, say — over the same state files.
		const second = await makeDevice({ server, keys, client }, 'laptop', {
			vault: first.vault,
			storage: first.storage,
		});
		await second.engine.pushAll({ fullScan: false });
		second.vault.putText('b.md', 'two\n');
		second.queue.enqueue('b.md', 'upsert');
		await second.queue.save();

		// Only now does the abandoned run unwind, still holding its pre-rebuild view.
		first.engine.retire();
		await first.engine.pushAll({ fullScan: false });

		const reloaded = await makeDevice({ server, keys, client }, 'laptop', {
			vault: first.vault,
			storage: first.storage,
		});
		expect(reloaded.queue.all().map((item) => item.path)).toEqual(['b.md']);
	});

	test('stops draining instead of finishing the pass', async () => {
		const laptop = await device('laptop');
		queueThree(laptop);

		laptop.engine.retire();
		const before = server.requests.length;
		await laptop.engine.pushAll({ fullScan: false });

		expect(server.requests.length).toBe(before);
		expect(laptop.queue.depth()).toEqual({ upserts: 3, deletes: 0, blocked: 0 });
	});

	test('stops pulling rather than applying changes its replacement will handle', async () => {
		const seed = await device('seed');
		seed.vault.putText('shared.md', 'from seed\n');
		await seed.engine.pushAll();

		const laptop = await device('laptop');
		laptop.engine.retire();
		await laptop.engine.pullAll();

		expect(await laptop.vault.exists('shared.md')).toBe(false);
		expect(laptop.index.entries()).toEqual([]);
	});
});

import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import SyncPlugin from './main.js';
import { defaultSettings, secretKeys } from './settings.js';
import { FakeApp } from './testing/fake-app.js';
import { FakeServer } from './testing/fake-server.js';
import { setRequestUrlHandler } from './testing/obsidian-stub.js';

/**
 * The engine lifecycle — build, retry, and the sync lock — used to be unreachable by
 * any test, and four bugs shipped through it during v0.0.11 testing: a rebuild that
 * awaited its own run, a failed build that never retried, connection settings that
 * needed a sync toggle, and a notice that did nothing on iOS. The first two are pinned
 * here; the third is settings-tab wiring and the fourth is a WebKit input quirk.
 *
 * `onload` is deliberately not called. It wants a status bar, a ribbon icon and a
 * workspace, none of which these paths touch — the status bar item stays null and
 * `#renderStatusBar` returns early.
 */

let app: FakeApp;
let server: FakeServer;
let plugin: SyncPlugin;
let offline = false;

/** Bridges Obsidian's requestUrl shape onto the fake server, with a switch for the wire. */
function wireTransport(): void {
	setRequestUrlHandler(async (params) => {
		if (offline) {
			throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
		}
		const path = params.url.replace('http://sync.test', '');
		let body: unknown;
		if (typeof params.body === 'string') {
			body = JSON.parse(params.body) as unknown;
		} else if (params.body !== undefined) {
			body = new Uint8Array(params.body);
		}
		const response = await server.request({
			path,
			method: params.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
			...(body === undefined ? {} : { body: body as object }),
		});
		const json = response.json();
		return {
			status: response.status,
			arrayBuffer: response.arrayBuffer,
			json: () => json,
			text: JSON.stringify(json ?? null),
		};
	});
}

/**
 * Only the retry timers are faked. Key derivation is real PBKDF2 on the libuv
 * threadpool, which no amount of advancing fake time will complete, so progress is
 * awaited in real time against a condition instead.
 */
async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate() && Date.now() < deadline) {
		await delay(2);
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	offline = false;
	app = new FakeApp();
	app.secrets.set(secretKeys.token, 'a-token');
	app.secrets.set(secretKeys.passphrase, 'a-passphrase');
	server = new FakeServer();
	wireTransport();
	plugin = new SyncPlugin(app.asApp(), {} as never);
	plugin.settings = {
		...defaultSettings,
		enabled: true,
		serverUrl: 'http://sync.test',
		syncOnStartup: true,
	};
});

afterEach(() => {
	vi.useRealTimers();
	setRequestUrlHandler(undefined);
});

describe('engine lifecycle', () => {
	test('a build that fails leaves no engine and reports the failure', async () => {
		offline = true;

		await plugin.reloadEngine();

		expect(plugin.lastStatus).toBe('error');
		expect(plugin.vaultIdForNudge).toBe('');
	});

	// Before this retry existed, a server that happened to be down when Obsidian started
	// left sync dead for the whole session: no queue to schedule from, no watcher, no
	// nudge, and #runSync returns before the finally that would reschedule.
	test('a failed build retries itself and recovers once the server answers', async () => {
		offline = true;
		await plugin.reloadEngine();
		expect(plugin.vaultIdForNudge).toBe('');

		offline = false;
		// The first backoff step is 5s; nothing else in the plugin is left to trigger this.
		await vi.advanceTimersByTimeAsync(6_000);
		await until(() => plugin.vaultIdForNudge !== '');

		expect(plugin.vaultIdForNudge).toBe(server.vaultId);
	});

	test('the retry stops once sync is switched off', async () => {
		offline = true;
		await plugin.reloadEngine();

		plugin.settings = { ...plugin.settings, enabled: false };
		offline = false;
		await vi.advanceTimersByTimeAsync(60_000);
		await until(() => plugin.vaultIdForNudge !== '', 200);

		expect(plugin.vaultIdForNudge).toBe('');
	});

	// reloadEngine used to await reconcile() -> requestSync(), which hands back the
	// in-flight run's own promise. Reached from inside #runSync that awaited itself, and
	// only the five-minute watchdog broke it: reads kept flowing while nothing pushed.
	test('a rebuild from inside a sync run does not wedge the run', async () => {
		offline = true;
		await plugin.reloadEngine();
		offline = false;

		let settled = false;
		const run = plugin.requestSync().then(() => {
			settled = true;
		});

		// Far below the watchdog, which is what used to release this.
		await until(() => settled);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(settled).toBe(true);
		expect(plugin.vaultIdForNudge).toBe(server.vaultId);
		await run;
	});

	test('a successful build clears the backoff, so the next failure starts at the first step', async () => {
		offline = true;
		await plugin.reloadEngine();
		offline = false;
		await vi.advanceTimersByTimeAsync(6_000);
		await until(() => plugin.vaultIdForNudge !== '');
		expect(plugin.vaultIdForNudge).toBe(server.vaultId);

		// A later outage must not inherit the previous attempt count and wait minutes.
		offline = true;
		await plugin.reloadEngine();
		plugin.vaultIdForNudge = '';
		offline = false;
		await vi.advanceTimersByTimeAsync(6_000);
		await until(() => plugin.vaultIdForNudge !== '');

		expect(plugin.vaultIdForNudge).toBe(server.vaultId);
	});
});

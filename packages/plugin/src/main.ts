import {
	type EventRef,
	Notice,
	Platform,
	Plugin,
	requestUrl,
	requireApiVersion,
	type SecretStorage,
} from 'obsidian';
import { derivePurposeKeys, type PurposeKeys } from './crypto/keys.js';
import { pluginId } from './engine/selective.js';
import { type ConflictRecord, type EngineStatus, SyncEngine } from './engine/sync.js';
import { SyncSettingTab } from './obsidian/settings-tab.js';
import { createLocalStateStore, createStateStorage } from './obsidian/state-store.js';
import { SyncStatusView, syncStatusViewType } from './obsidian/status-view.js';
import { createVaultAdapter } from './obsidian/vault-adapter.js';
import { DebouncedWatcher } from './obsidian/watcher.js';
import {
	defaultSettings,
	type PluginSettings,
	type SecretsPort,
	secretKeys,
	toSelectiveSyncOptions,
} from './settings.js';
import { BaseCache } from './state/base-cache.js';
import { FileIndex } from './state/file-index.js';
import { LocalState } from './state/local-state.js';
import { ApiClient } from './transport/client.js';
import { createObsidianRequester } from './transport/http.js';
import {
	createIntervalSource,
	createLongPollSource,
	createWebSocketSource,
	type NudgeSource,
	selectNudgeSource,
} from './transport/nudge.js';

const minimumApiVersion = '1.13.2';

export default class SyncPlugin extends Plugin {
	settings: PluginSettings = { ...defaultSettings };
	lastStatus: EngineStatus = 'idle';
	lastSyncAt = 0;
	pendingConflicts: ConflictRecord[] = [];

	#engine: SyncEngine | null = null;
	#keys: PurposeKeys | null = null;
	#nudge: NudgeSource | null = null;
	#watcher: DebouncedWatcher | null = null;
	#statusBarItem: HTMLElement | null = null;
	#eventRefs: EventRef[] = [];
	#pendingDeletes = new Set<string>();
	#syncing: Promise<void> | null = null;
	#resyncRequested = false;

	override async onload(): Promise<void> {
		if (!requireApiVersion(minimumApiVersion)) {
			new Notice(`Obsidian Sync needs API ${minimumApiVersion} or newer; sync disabled.`);
			return;
		}

		await this.loadSettings();

		this.addSettingTab(new SyncSettingTab(this));
		this.addRibbonIcon('refresh-cw', 'Open sync status', () => void this.openStatusView());
		this.#registerCommands();
		this.registerView(syncStatusViewType, (leaf) => new SyncStatusView(this, leaf));

		if (!Platform.isPhone) {
			this.#statusBarItem = this.addStatusBarItem();
			this.#renderStatusBar();
		}

		this.registerDomElements();
		if (this.settings.enabled) {
			// Obsidian populates its file cache after layout. Starting the engine before
			// that makes every tracked note look absent, which the push path reads as a
			// delete and propagates to every other device.
			this.app.workspace.onLayoutReady(() => {
				void this.reloadEngine();
			});
		}
	}

	override async onunload(): Promise<void> {
		this.#stopEngine();
		for (const ref of this.#eventRefs) {
			this.app.vault.offref(ref);
		}
		this.#eventRefs = [];
	}

	secretOrEmpty(id: string): string {
		return this.#secrets()?.getSecret(id) ?? '';
	}

	setSecret(id: string, value: string): void {
		this.#secrets()?.setSecret(id, value);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = { ...defaultSettings, ...(stored ?? {}) };

		if (this.settings.deviceLabel === '') {
			this.settings.deviceLabel = detectDeviceName();
			await this.saveSettings();
		}
	}

	#secrets(): SecretsPort | null {
		const storage = this.app.secretStorage as SecretStorage | undefined;
		return storage ?? null;
	}

	#registerCommands(): void {
		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.requestSync() });
		this.addCommand({
			id: 'open-status',
			name: 'Open sync status',
			callback: () => void this.openStatusView(),
		});
		this.addCommand({
			id: 'reconcile',
			name: 'Full reconcile',
			callback: () => void this.reconcile(),
		});
	}

	registerDomElements(): void {
		// Foregrounding on mobile is a reconcile trigger (§2.3): a dead live channel
		// is reconstructed from the durable cursor, not trusted to have delivered.
		if (Platform.isMobileApp) {
			this.#eventRefs.push(
				this.app.workspace.on('active-leaf-change', () => {
					if (this.settings.enabled) {
						void this.reconcile();
					}
				}),
			);
		}
	}

	async reloadEngine(): Promise<void> {
		this.#stopEngine();
		if (!this.settings.enabled) {
			return;
		}
		const token = this.secretOrEmpty(secretKeys.token);
		const passphrase = this.secretOrEmpty(secretKeys.passphrase);
		if (token === '' || passphrase === '' || this.settings.serverUrl === '') {
			new Notice('Obsidian Sync: set the server URL, token, and passphrase first.');
			return;
		}
		try {
			await this.#buildEngine(token, passphrase);
			this.#startNudge();
			this.#startWatcher();
			if (this.settings.syncOnStartup) {
				await this.requestSync();
			}
		} catch (error) {
			this.#setStatus('error');
			new Notice(`Obsidian Sync failed to start: ${(error as Error).message}`);
		}
	}

	async #buildEngine(token: string, passphrase: string): Promise<void> {
		const requester = createObsidianRequester({
			serverUrl: this.settings.serverUrl,
			token,
			requestUrl,
		});
		const client = new ApiClient(requester);

		const me = await client.me();
		let vault = me.vaults.find((candidate) => candidate.name === this.settings.vaultName);
		if (vault === undefined) {
			vault = await client.createVault(this.settings.vaultName || defaultSettings.vaultName);
		}

		this.#keys = await derivePurposeKeys(passphrase, vault.kdfSalt);

		const stateDir = `.obsidian/plugins/${pluginId}/state`;
		const index = new FileIndex(createStateStorage(this.app.vault, stateDir));
		const bases = new BaseCache(createStateStorage(this.app.vault, stateDir));
		await index.load();
		await bases.load();
		const local = new LocalState(createLocalStateStore(this.app));
		const deviceId = local.ensureDeviceId(() => crypto.randomUUID());

		this.#engine = new SyncEngine({
			vaultId: vault.id,
			client,
			keys: this.#keys,
			vault: createVaultAdapter(this.app),
			index,
			bases,
			local,
			selective: toSelectiveSyncOptions(this.settings),
			deviceId,
			onStatus: (status) => this.#setStatus(status),
			onConflict: (conflict) => {
				this.pendingConflicts.push(conflict);
				new Notice(`Conflict on ${conflict.path}; local copy saved alongside it.`);
			},
		});
		this.vaultIdForNudge = vault.id;
		this.clientForNudge = client;
	}

	vaultIdForNudge = '';
	clientForNudge: ApiClient | null = null;

	#startNudge(): void {
		if (this.clientForNudge === null || this.vaultIdForNudge === '') {
			return;
		}
		const client = this.clientForNudge;
		const vaultId = this.vaultIdForNudge;
		const local = new LocalState(createLocalStateStore(this.app));
		const onUnauthorized = (): void => {
			this.#setStatus('error');
			new Notice('Obsidian Sync: the server rejected the token. Sync stopped.');
		};
		this.#nudge = selectNudgeSource({
			serverUrl: this.settings.serverUrl,
			preference: this.settings.transport,
			longPoll: () =>
				createLongPollSource({
					client,
					vaultId,
					waitSeconds: this.settings.longPollWaitSeconds,
					getCursor: () => local.getCursor(),
					onUnauthorized,
				}),
			interval: () =>
				createIntervalSource({ intervalMs: this.settings.pollIntervalSeconds * 1000 }),
			websocket: () =>
				createWebSocketSource({
					serverUrl: this.settings.serverUrl,
					vaultId,
					getTicket: async () => (await client.streamTicket(vaultId)).ticket,
					factory: (url) => new WebSocket(url),
					onUnavailable: () => {
						this.#nudge?.stop();
						this.#nudge = createLongPollSource({
							client,
							vaultId,
							waitSeconds: this.settings.longPollWaitSeconds,
							getCursor: () => local.getCursor(),
							onUnauthorized,
						});
						this.#nudge.start(() => this.requestSync());
					},
				}),
		});
		this.#nudge.start(() => this.requestSync());
	}

	#startWatcher(): void {
		this.#watcher = new DebouncedWatcher(this.app.vault, this.settings.debounceMs, (batch) => {
			for (const path of batch.deleted) {
				this.#pendingDeletes.add(path);
			}
			return this.requestSync();
		});
		this.#watcher.start();
	}

	/**
	 * Coalesces overlapping triggers: nudges arriving during a run set a flag instead
	 * of starting a second engine pass over the same vault.
	 */
	async requestSync(): Promise<void> {
		if (this.#syncing !== null) {
			this.#resyncRequested = true;
			return this.#syncing;
		}
		this.#syncing = (async () => {
			do {
				this.#resyncRequested = false;
				await this.#runSync();
			} while (this.#resyncRequested);
		})();
		try {
			await this.#syncing;
		} finally {
			this.#syncing = null;
		}
	}

	async #runSync(): Promise<void> {
		if (this.#engine === null) {
			await this.reloadEngine();
			return;
		}
		// Drained rather than read, so a failure can put them back: a delete has no
		// on-disk trace to rediscover beyond the index, which pushAll also reconciles.
		const deletes = [...this.#pendingDeletes];
		this.#pendingDeletes.clear();
		try {
			this.#setStatus('syncing');
			await this.#engine.pullAll();
			await this.#engine.pushAll(deletes);
			this.lastSyncAt = Date.now();
			this.#setStatus('idle');
		} catch (error) {
			for (const path of deletes) {
				this.#pendingDeletes.add(path);
			}
			this.#setStatus('error');
			this.#logError(error);
		}
	}

	/** Pushes changed settings into a running engine so they apply without a restart. */
	applyLiveSettings(): void {
		this.#engine?.updateSelective(toSelectiveSyncOptions(this.settings));
		this.#watcher?.setDebounce(this.settings.debounceMs);
	}

	async reconcile(): Promise<void> {
		await this.requestSync();
	}

	async testConnection(): Promise<void> {
		const token = this.secretOrEmpty(secretKeys.token);
		if (this.settings.serverUrl === '' || token === '') {
			new Notice('Enter a server URL and token first.');
			return;
		}
		const client = new ApiClient(
			createObsidianRequester({ serverUrl: this.settings.serverUrl, token, requestUrl }),
		);
		try {
			const me = await client.me();
			new Notice(`Connected as ${me.user}; ${me.vaults.length} vault(s).`);
		} catch (error) {
			new Notice(`Connection failed: ${(error as Error).message}`);
		}
	}

	#setStatus(status: EngineStatus): void {
		this.lastStatus = status;
		this.#renderStatusBar();
		this.#refreshStatusView();
	}

	#renderStatusBar(): void {
		if (this.#statusBarItem === null) {
			return;
		}
		this.#statusBarItem.setText(`Sync: ${this.lastStatus}`);
	}

	#refreshStatusView(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(syncStatusViewType)) {
			const view = leaf.view;
			if (view instanceof SyncStatusView) {
				view.refresh();
			}
		}
	}

	async openStatusView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(syncStatusViewType)[0];
		if (existing !== undefined) {
			this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf === null) {
			return;
		}
		await leaf.setViewState({ type: syncStatusViewType, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	#logError(error: unknown): void {
		// Never log a token or passphrase; message only.
		console.error('[obsidian-sync]', (error as Error)?.message ?? error);
	}

	#stopEngine(): void {
		this.#nudge?.stop();
		this.#syncing = null;
		this.#resyncRequested = false;
		this.#watcher?.stop();
		this.#nudge = null;
		this.#watcher = null;
		this.#engine = null;
	}
}

/**
 * The machine's own name, so two devices are distinguishable in version history
 * without the user naming them. `os` is reachable in Obsidian's desktop renderer
 * but absent in the mobile WebView, hence the platform fallback.
 */
function detectDeviceName(): string {
	try {
		const hostname = (require('node:os') as typeof import('node:os')).hostname();
		const trimmed = hostname.replace(/\.(local|lan|home|localdomain|internal)$/i, '').trim();
		if (trimmed !== '') {
			return trimmed;
		}
	} catch {
		// Mobile: no node builtins.
	}
	if (Platform.isIosApp) {
		return 'iOS device';
	}
	if (Platform.isAndroidApp) {
		return 'Android device';
	}
	return 'This device';
}

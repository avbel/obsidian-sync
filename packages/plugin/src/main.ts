import {
	Notice,
	Platform,
	Plugin,
	requestUrl,
	requireApiVersion,
	type SecretStorage,
	setIcon,
	setTooltip,
} from 'obsidian';
import { derivePurposeKeys, type PurposeKeys } from './crypto/keys.js';
import { describeReconcile } from './engine/reconcile.js';
import { pluginId } from './engine/selective.js';
import {
	type ConflictChoice,
	type ConflictRecord,
	type EngineStatus,
	type ReconcileSummary,
	SyncEngine,
} from './engine/sync.js';
import { ConflictModal } from './obsidian/conflict-modal.js';
import { SyncSettingTab } from './obsidian/settings-tab.js';
import { createLocalStateStore, createStateStorage } from './obsidian/state-store.js';
import { statusIcon, statusIconClass, statusTooltip } from './obsidian/status-display.js';
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
import { ConflictList } from './state/conflict-list.js';
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
const hideCoreSyncClass = 'obsidian-sync-hide-core-sync';
const syncWatchdogMs = 5 * 60 * 1000;
const foregroundThrottleMs = 1000;

export default class SyncPlugin extends Plugin {
	settings: PluginSettings = { ...defaultSettings };
	lastStatus: EngineStatus = 'idle';
	lastSyncAt = 0;
	lastReconcile: ReconcileSummary | undefined;

	#conflicts: ConflictList | null = null;

	get pendingConflicts(): ConflictRecord[] {
		return this.#conflicts?.all() ?? [];
	}

	#engine: SyncEngine | null = null;
	#keys: PurposeKeys | null = null;
	#nudge: NudgeSource | null = null;
	#watcher: DebouncedWatcher | null = null;
	#statusBarItem: HTMLElement | null = null;
	#lastForegroundAt = 0;
	#pendingDeletes = new Set<string>();
	#syncing: Promise<void> | null = null;
	#resyncRequested = false;
	#reconcileRequested: 'silent' | 'announce' | undefined;

	override async onload(): Promise<void> {
		if (!requireApiVersion(minimumApiVersion)) {
			new Notice(`Obsidian Sync needs API ${minimumApiVersion} or newer; sync disabled.`);
			return;
		}

		await this.loadSettings();
		this.#conflicts = new ConflictList(createLocalStateStore(this.app));

		this.addSettingTab(new SyncSettingTab(this));
		this.addRibbonIcon('refresh-cw', 'Open sync status', () => void this.openStatusView());
		this.#registerCommands();
		this.registerView(syncStatusViewType, (leaf) => new SyncStatusView(this, leaf));

		if (!Platform.isPhone) {
			this.#statusBarItem = this.addStatusBarItem();
			this.registerDomEvent(this.#statusBarItem, 'mouseenter', () => this.#updateStatusTooltip());
			this.#renderStatusBar();
		}

		this.#applyCoreSyncVisibility();
		this.#registerForegroundTriggers();
		this.app.workspace.onLayoutReady(() => {
			void this.#afterLayoutReady();
		});
	}

	async #afterLayoutReady(): Promise<void> {
		// Obsidian populates its file cache after layout. Pruning any earlier sees an
		// empty vault and drops every live conflict.
		const vault = createVaultAdapter(this.app);
		await this.#conflicts?.prune((path) => vault.exists(path));
		this.#renderStatusBar();
		this.#refreshStatusView();
		if (this.settings.enabled) {
			// Same reason the engine starts here rather than in onload(): starting it
			// before the cache is populated makes every tracked note look absent, which
			// the push path reads as a delete and propagates to every other device.
			await this.reloadEngine();
		}
	}

	override async onunload(): Promise<void> {
		document.body.classList.remove(hideCoreSyncClass);
		this.#stopEngine();
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
		this.addCommand({
			id: 'reconcile',
			name: 'Full reconcile',
			callback: () => void this.reconcile(),
		});
	}

	/**
	 * iOS freezes a backgrounded app mid-request, so returning to the foreground is
	 * the moment sync has to be rebuilt (§2.3). visibilitychange is the event that
	 * actually reports it; window focus is a fallback for WebViews that skip it.
	 */
	#registerForegroundTriggers(): void {
		if (!Platform.isMobileApp) {
			return;
		}
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (!document.hidden) {
				this.#onForeground();
			}
		});
		this.registerDomEvent(window, 'focus', () => {
			this.#onForeground();
		});
	}

	#onForeground(): void {
		if (!this.settings.enabled) {
			return;
		}
		const now = Date.now();
		if (now - this.#lastForegroundAt < foregroundThrottleMs) {
			return;
		}
		this.#lastForegroundAt = now;

		// A suspended app's long-poll is frozen rather than closed, so the channel is
		// rebuilt instead of waiting out its timeout before the next nudge can arrive.
		if (this.#nudge !== null) {
			this.#nudge.stop();
			this.#startNudge();
		}
		// Incremental, not a full reconcile: /state carries every metaBlob in the vault,
		// and a foreground can fire often on mobile. Load and the command cover recovery.
		void this.requestSync();
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
				// A restart is exactly when the cursor may be stale or the state directory
				// gone, so the first run of a session is the full comparison, not a nudge.
				await this.reconcile({ announce: false });
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
			deviceLabel: this.settings.deviceLabel,
			onStatus: (status) => this.#setStatus(status),
			onConflict: (conflict) => {
				this.#conflicts?.add(conflict);
				this.#renderStatusBar();
				this.#refreshStatusView();
				const notice = new Notice(`Conflict on ${conflict.path} — click to resolve.`, 15000);
				notice.noticeEl.addEventListener('click', () => {
					this.openConflict(conflict);
				});
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
		// Raced against a watchdog: a run that somehow never settles must not leave every
		// later requestSync() awaiting a dead promise, which silently disables sync until
		// the plugin is reloaded. Runs are idempotent, so abandoning one is safe.
		this.#syncing = Promise.race([
			(async () => {
				do {
					this.#resyncRequested = false;
					await this.#runSync();
				} while (this.#resyncRequested);
			})(),
			new Promise<void>((resolve) => {
				setTimeout(resolve, syncWatchdogMs);
			}),
		]);
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

	#applyCoreSyncVisibility(): void {
		document.body.classList.toggle(hideCoreSyncClass, this.settings.hideCoreSyncIndicator);
	}

	/** Pushes changed settings into a running engine so they apply without a restart. */
	applyLiveSettings(): void {
		this.#applyCoreSyncVisibility();
		this.#engine?.updateSelective(toSelectiveSyncOptions(this.settings));
		this.#engine?.updateDeviceLabel(this.settings.deviceLabel);
		this.#watcher?.setDebounce(this.settings.debounceMs);
	}

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
		const item = this.#statusBarItem;
		if (item === null) {
			return;
		}
		item.empty();
		item.addClass(statusIconClass);
		item.dataset.syncStatus = this.lastStatus;
		setIcon(item, statusIcon(this.lastStatus));
		this.#updateStatusTooltip();
	}

	#updateStatusTooltip(): void {
		const item = this.#statusBarItem;
		if (item === null) {
			return;
		}
		// "last synced 2m ago" ages between renders, so recompute it as the pointer arrives.
		setTooltip(item, statusTooltip(this.lastStatus, this.lastSyncAt, this.pendingConflicts.length));
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
		this.#reconcileRequested = undefined;
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

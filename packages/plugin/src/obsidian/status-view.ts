import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { EngineStatus } from '../engine/sync.js';
import type SyncPlugin from '../main.js';

export const syncStatusViewType = 'obsidian-sync-status';

export function statusLabel(status: EngineStatus): string {
	switch (status) {
		case 'idle':
			return 'Idle';
		case 'syncing':
			return 'Syncing…';
		case 'conflict':
			return 'Conflict';
		case 'error':
			return 'Error';
	}
}

/**
 * Right-sidebar sync status. On mobile this is the primary indicator because there
 * is no status bar (§6.3.2): state, last sync time, conflicts, and the actions.
 */
export class SyncStatusView extends ItemView {
	readonly #plugin: SyncPlugin;

	constructor(plugin: SyncPlugin, leaf: WorkspaceLeaf) {
		super(leaf);
		this.#plugin = plugin;
	}

	getViewType(): string {
		return syncStatusViewType;
	}

	getDisplayText(): string {
		return 'Sync status';
	}

	getIcon(): string {
		return 'refresh-cw';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('obsidian-sync-status');

		const header = root.createDiv({ cls: 'obsidian-sync-status__header' });
		const icon = header.createSpan({ cls: 'obsidian-sync-status__icon' });
		setIcon(icon, 'refresh-cw');
		header.createSpan({ text: statusLabel(this.#plugin.lastStatus) });

		const lastSync = root.createDiv({ cls: 'obsidian-sync-status__last' });
		const at = this.#plugin.lastSyncAt;
		lastSync.setText(at === 0 ? 'Never synced' : `Last synced ${relativeTime(at)}`);

		const conflicts = this.#plugin.pendingConflicts;
		if (conflicts.length > 0) {
			const list = root.createDiv({ cls: 'obsidian-sync-status__conflicts' });
			list.createDiv({ text: `${conflicts.length} conflict(s):` });
			for (const conflict of conflicts) {
				list.createDiv({ cls: 'obsidian-sync-status__conflict', text: conflict.path });
			}
		}

		const actions = root.createDiv({ cls: 'obsidian-sync-status__actions' });
		actions
			.createEl('button', { text: 'Sync now' })
			.addEventListener('click', () => void this.#plugin.requestSync());
		actions
			.createEl('button', { text: 'Full reconcile' })
			.addEventListener('click', () => void this.#plugin.reconcile());
	}

	refresh(): void {
		void this.onOpen();
	}
}

function relativeTime(at: number): string {
	const seconds = Math.round((Date.now() - at) / 1000);
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	if (seconds < 3600) {
		return `${Math.round(seconds / 60)}m ago`;
	}
	return `${Math.round(seconds / 3600)}h ago`;
}

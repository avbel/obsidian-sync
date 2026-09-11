import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type SyncPlugin from '../main.js';
import { relativeTime, statusIcon, statusIconClass, statusLabel } from './status-display.js';

export const syncStatusViewType = 'obsidian-sync-status';

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

		const status = this.#plugin.lastStatus;
		const header = root.createDiv({ cls: 'obsidian-sync-status__header' });
		const icon = header.createSpan({ cls: statusIconClass });
		icon.dataset.syncStatus = status;
		setIcon(icon, statusIcon(status));
		header.createSpan({ text: statusLabel(status) });

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

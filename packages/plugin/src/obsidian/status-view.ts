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

		const pending = this.#plugin.pendingPushes;
		if (pending.upserts + pending.deletes + pending.blocked > 0) {
			root.createDiv({
				cls: 'obsidian-sync-status__queue',
				text: `Pending changes: ${pending.upserts} upload(s), ${pending.deletes} deletion(s), ${pending.blocked} blocked`,
			});
		}

		const reconcile = this.#plugin.lastReconcile;
		if (reconcile !== undefined) {
			root.createDiv({
				cls: 'obsidian-sync-status__reconcile',
				text: `Last reconcile: ${reconcile.remoteFiles} remote file(s), ${reconcile.pulled} pulled, ${reconcile.removed} removed`,
			});
		}

		const conflicts = this.#plugin.pendingConflicts;
		if (conflicts.length > 0) {
			const list = root.createDiv({ cls: 'obsidian-sync-status__conflicts' });
			list.createDiv({ text: `${conflicts.length} unresolved conflict(s):` });
			for (const conflict of conflicts) {
				const row = list.createDiv({ cls: 'obsidian-sync-status__conflict' });
				row.createSpan({ text: conflict.path });
				row
					.createEl('button', { text: 'Resolve' })
					.addEventListener('click', () => this.#plugin.openConflict(conflict));
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

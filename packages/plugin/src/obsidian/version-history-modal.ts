import { type App, Modal, Notice, Platform } from 'obsidian';
import type { HistoryEntry, HistoryPage, VersionHistoryService } from '../engine/history.js';
import { VersionContentUnavailableError, VersionUnreadableError } from '../engine/history.js';
import { buildPreview, type VersionPreview } from '../engine/preview.js';
import { StaleWriteError } from '../engine/vault.js';
import { relativeTime } from './status-display.js';

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeDevice(entry: HistoryEntry): string {
	if (entry.deviceLabel !== undefined && entry.deviceLabel !== '') {
		return entry.deviceLabel;
	}
	return entry.isLocalDevice ? 'This device' : `Device ${entry.deviceId.slice(0, 6)}`;
}

/** Per-note version history (§6.3.5): preview and restore always create a new version. */
export class VersionHistoryModal extends Modal {
	readonly #history: VersionHistoryService;
	readonly #path: string;
	#page: HistoryPage | undefined;
	#selected: HistoryEntry | undefined;
	#selectedBytes: Uint8Array | undefined;
	#listEl: HTMLElement | undefined;
	#detailEl: HTMLElement | undefined;

	constructor(app: App, history: VersionHistoryService, path: string) {
		super(app);
		this.#history = history;
		this.#path = path;
	}

	override async onOpen(): Promise<void> {
		this.modalEl.addClass('obsidian-sync-history');
		this.modalEl.toggleClass('obsidian-sync-history--stacked', Platform.isPhone);
		this.setTitle(`Version history — ${this.#path}`);

		const body = this.contentEl.createDiv({ cls: 'obsidian-sync-history__body' });
		this.#listEl = body.createDiv({ cls: 'obsidian-sync-history__list' });
		this.#detailEl = body.createDiv({ cls: 'obsidian-sync-history__detail' });
		this.#listEl.createDiv({ text: 'Loading…' });
		this.contentEl.createDiv({
			cls: 'obsidian-sync-history__footnote',
			text: 'History follows the path. Renaming a note starts a new history.',
		});

		await this.#reload(0);
	}

	async #reload(offset: number): Promise<void> {
		const list = this.#listEl;
		if (list === undefined) {
			return;
		}
		try {
			const page = await this.#history.list(this.#path, { offset });
			this.#page =
				this.#page === undefined || offset === 0
					? page
					: { ...page, entries: [...this.#page.entries, ...page.entries] };
		} catch (error) {
			list.empty();
			list.createDiv({ text: `Could not load history: ${(error as Error).message}` });
			return;
		}
		this.#renderList();
	}

	#renderList(): void {
		const list = this.#listEl;
		const page = this.#page;
		if (list === undefined || page === undefined) {
			return;
		}
		list.empty();

		if (page.entries.length === 0) {
			list.createDiv({ text: 'This note has no synced versions yet.' });
			return;
		}

		for (const entry of page.entries) {
			const row = list.createEl('button', { cls: 'obsidian-sync-history__row' });
			row.toggleClass('is-active', entry.versionId === this.#selected?.versionId);
			row.createDiv({
				cls: 'obsidian-sync-history__when',
				text: `${new Date(entry.createdAt).toLocaleString()} · ${relativeTime(entry.createdAt)}`,
			});
			row.createDiv({
				cls: 'obsidian-sync-history__meta',
				text: `${describeDevice(entry)} · ${formatBytes(entry.size)}`,
			});
			if (entry.isCurrent) {
				row.createSpan({ cls: 'obsidian-sync-history__badge', text: 'Current' });
			}
			if (!entry.readable) {
				row.createSpan({ cls: 'obsidian-sync-history__badge is-error', text: 'Unreadable' });
			}
			row.addEventListener('click', () => void this.#select(entry));
		}

		if (page.hasMore) {
			list
				.createEl('button', { cls: 'obsidian-sync-history__more', text: 'Load older versions' })
				.addEventListener('click', () => void this.#reload(page.entries.length));
		}
	}

	async #select(entry: HistoryEntry): Promise<void> {
		const detail = this.#detailEl;
		const page = this.#page;
		if (detail === undefined || page === undefined) {
			return;
		}
		this.#selected = entry;
		this.#selectedBytes = undefined;
		this.#renderList();
		detail.empty();
		detail.createDiv({ text: 'Loading version…' });

		try {
			this.#selectedBytes = await this.#history.read(page.fileId, entry);
		} catch (error) {
			detail.empty();
			detail.createDiv({ cls: 'obsidian-sync-history__error', text: this.#explain(error) });
			return;
		}

		const current = (await this.app.vault.adapter.exists(this.#path))
			? new Uint8Array(await this.app.vault.adapter.readBinary(this.#path))
			: undefined;
		this.#renderDetail(buildPreview(this.#path, current, this.#selectedBytes));
	}

	#renderDetail(preview: VersionPreview): void {
		const detail = this.#detailEl;
		const entry = this.#selected;
		if (detail === undefined || entry === undefined) {
			return;
		}
		detail.empty();

		const summary = detail.createDiv({ cls: 'obsidian-sync-history__summary' });
		switch (preview.kind) {
			case 'identical':
				summary.setText('This version is identical to the note on disk.');
				break;
			case 'binary':
				summary.setText(
					`Binary file — no preview. ${formatBytes(preview.versionBytes)} in this version.`,
				);
				break;
			case 'tooLarge':
				summary.setText(
					preview.reason === 'lines'
						? 'Too many lines to diff. Restore to a copy and compare in the editor.'
						: 'Too large to diff. Restore to a copy and compare in the editor.',
				);
				break;
			case 'diff': {
				summary.setText(
					`Restoring would add ${preview.added} and remove ${preview.removed} line(s).`,
				);
				const rows = detail.createDiv({ cls: 'obsidian-sync-history__diff' });
				for (const row of preview.rows) {
					const marker = row.op === 'insert' ? '+' : row.op === 'delete' ? '-' : ' ';
					rows.createDiv({
						cls: `obsidian-sync-history__line is-${row.op}`,
						text: `${marker} ${row.text}`,
					});
				}
				break;
			}
		}

		const actions = detail.createDiv({ cls: 'obsidian-sync-history__actions' });
		const restore = actions.createEl('button', { cls: 'mod-cta', text: 'Restore this version' });
		restore.disabled = !entry.readable || preview.kind === 'identical';
		restore.addEventListener('click', () => void this.#restore(false));
		const copy = actions.createEl('button', { text: 'Restore to a copy' });
		copy.disabled = !entry.readable;
		copy.addEventListener('click', () => void this.#restore(true));
	}

	async #restore(asCopy: boolean): Promise<void> {
		const page = this.#page;
		const entry = this.#selected;
		if (page === undefined || entry === undefined) {
			return;
		}
		const request = { path: this.#path, fileId: page.fileId, entry };
		try {
			if (asCopy) {
				const { copyPath } = await this.#history.restoreAsCopy(request);
				new Notice(`Restored to ${copyPath}.`);
			} else {
				const outcome = await this.#history.restore(request);
				new Notice(
					outcome.status === 'unchanged'
						? 'That version is already what is on disk.'
						: `Restored ${this.#path} as a new version.`,
				);
			}
			this.close();
		} catch (error) {
			new Notice(this.#explain(error));
		}
	}

	#explain(error: unknown): string {
		if (error instanceof VersionContentUnavailableError) {
			return 'That version’s content is no longer stored on the server.';
		}
		if (error instanceof VersionUnreadableError) {
			return 'That version cannot be decrypted with the current passphrase.';
		}
		if (error instanceof StaleWriteError) {
			return 'The note changed while restoring. Try again.';
		}
		return `Restore failed: ${(error as Error).message}`;
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

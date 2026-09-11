import { type App, Modal, Setting } from 'obsidian';
import type { ConflictChoice, ConflictRecord } from '../engine/sync.js';

function describeSide(app: App, path: string): string {
	const file = app.vault.getFileByPath(path);
	if (file === null) {
		return 'missing';
	}
	const when = new Date(file.stat.mtime).toLocaleString();
	return `${when} · ${Math.max(1, Math.round(file.stat.size / 1024))} KB`;
}

/**
 * One conflict, one choice. Both sides are already files in the vault by the time this
 * opens (§8), so the modal reads them for metadata only and never holds their bytes.
 */
export class ConflictModal extends Modal {
	readonly #record: ConflictRecord;
	readonly #onChoose: (choice: ConflictChoice) => Promise<void>;

	constructor(
		app: App,
		record: ConflictRecord,
		onChoose: (choice: ConflictChoice) => Promise<void>,
	) {
		super(app);
		this.#record = record;
		this.#onChoose = onChoose;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Resolve conflict');

		contentEl.createEl('p', {
			text: `${this.#record.path} was edited on two devices and the changes could not be merged.`,
		});

		const sides = contentEl.createDiv({ cls: 'obsidian-sync-conflict__sides' });
		const mine = sides.createDiv({ cls: 'obsidian-sync-conflict__side' });
		mine.createEl('strong', { text: 'Yours' });
		mine.createDiv({ text: this.#record.conflictCopyPath });
		mine.createDiv({
			cls: 'obsidian-sync-conflict__meta',
			text: describeSide(this.app, this.#record.conflictCopyPath),
		});

		const remote = sides.createDiv({ cls: 'obsidian-sync-conflict__side' });
		remote.createEl('strong', { text: 'From another device' });
		remote.createDiv({ text: this.#record.path });
		remote.createDiv({
			cls: 'obsidian-sync-conflict__meta',
			text: describeSide(this.app, this.#record.path),
		});

		new Setting(contentEl).addButton((button) =>
			button.setButtonText('Open both side by side').onClick(() => {
				void this.#openBoth();
			}),
		);

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText('Keep mine')
					.setCta()
					.onClick(() => {
						void this.#choose('mine');
					}),
			)
			.addButton((button) =>
				button.setButtonText('Keep theirs').onClick(() => {
					void this.#choose('remote');
				}),
			)
			.addButton((button) =>
				button.setButtonText('Keep both').onClick(() => {
					void this.#choose('both');
				}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	async #choose(choice: ConflictChoice): Promise<void> {
		this.close();
		await this.#onChoose(choice);
	}

	async #openBoth(): Promise<void> {
		const theirs = this.app.vault.getFileByPath(this.#record.path);
		const mine = this.app.vault.getFileByPath(this.#record.conflictCopyPath);
		this.close();
		if (theirs !== null) {
			await this.app.workspace.getLeaf(false).openFile(theirs);
		}
		if (mine !== null) {
			await this.app.workspace.getLeaf('split', 'vertical').openFile(mine);
		}
	}
}

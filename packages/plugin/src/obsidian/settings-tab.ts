import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { SyncCategory } from '../engine/selective.js';
import type SyncPlugin from '../main.js';
import { type PluginSettings, secretKeys } from '../settings.js';

const categoryLabels: Record<SyncCategory, string> = {
	markdown: 'Markdown notes',
	attachments: 'Attachments',
	config: 'Vault configuration',
	themes: 'Themes',
	snippets: 'Snippets',
	pluginSettings: 'Community plugin settings',
};

/**
 * Classic settings tab. The declarative API (getSettingDefinitions) is available in
 * 1.13 but its per-control shapes are still stabilising; wiring the same model through
 * the battle-tested Setting builder keeps the build reliable and can be swapped for a
 * declarative tree without touching the model or engine. Secrets are entered here but
 * persisted via secretStorage, never data.json (§6.4).
 */
export class SyncSettingTab extends PluginSettingTab {
	readonly #plugin: SyncPlugin;

	constructor(plugin: SyncPlugin) {
		super(plugin.app, plugin);
		this.#plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.#plugin.settings;
		const update = async (patch: Partial<PluginSettings>): Promise<void> => {
			Object.assign(settings, patch);
			await this.#plugin.saveSettings();
			this.#plugin.applyLiveSettings();
		};

		new Setting(containerEl).setName('Connection').setHeading();
		new Setting(containerEl)
			.setName('Server URL')
			.setDesc('For example http://100.x.y.z:3000 (a Tailscale address).')
			.addText((text) =>
				text
					.setPlaceholder('http://…')
					.setValue(settings.serverUrl)
					.onChange((value) => {
						void update({ serverUrl: value.trim() });
					}),
			);
		new Setting(containerEl)
			.setName('Auth token')
			.setDesc('Pre-shared bearer token. Stored in Obsidian secret storage.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setValue(this.#plugin.secretOrEmpty(secretKeys.token)).onChange((value) => {
					this.#plugin.setSecret(secretKeys.token, value.trim());
				});
			});
		new Setting(containerEl).setName('Test connection').addButton((button) =>
			button.setButtonText('Test').onClick(() => {
				void this.#plugin.testConnection();
			}),
		);
		new Setting(containerEl)
			.setName('Device label')
			.setDesc('Names this device in version history. Prefilled from the machine name.')
			.addText((text) =>
				text.setValue(settings.deviceLabel).onChange((value) => {
					void update({ deviceLabel: value });
				}),
			);

		new Setting(containerEl).setName('Encryption').setHeading();
		new Setting(containerEl)
			.setName('Vault name')
			.setDesc('The remote vault to sync. Created on first sync if absent.')
			.addText((text) =>
				text
					.setPlaceholder('default')
					.setValue(settings.vaultName)
					.onChange((value) => {
						void update({ vaultName: value.trim() });
					}),
			);
		new Setting(containerEl)
			.setName('Passphrase')
			.setDesc('End-to-end encryption key. A lost passphrase means unrecoverable data.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setValue(this.#plugin.secretOrEmpty(secretKeys.passphrase)).onChange((value) => {
					this.#plugin.setSecret(secretKeys.passphrase, value);
				});
			});

		new Setting(containerEl).setName('Sync').setHeading();
		new Setting(containerEl).setName('Enable sync').addToggle((toggle) =>
			toggle.setValue(settings.enabled).onChange((value) => {
				void update({ enabled: value }).then(() => this.#plugin.reloadEngine());
			}),
		);
		new Setting(containerEl).setName('Transport').addDropdown((dropdown) =>
			dropdown
				.addOption('automatic', 'Automatic')
				.addOption('longpoll', 'Long-poll only')
				.addOption('websocket', 'WebSocket only')
				.addOption('interval', 'Interval polling')
				.setValue(settings.transport)
				.onChange((value) => {
					void update({ transport: value as PluginSettings['transport'] });
				}),
		);
		new Setting(containerEl)
			.setName('Poll interval')
			.setDesc('Only used with the Interval transport.')
			.addText((text) =>
				text.setValue(String(settings.pollIntervalSeconds)).onChange((value) => {
					void update({ pollIntervalSeconds: Number(value) || 60 });
				}),
			);
		new Setting(containerEl)
			.setName('Debounce delay')
			.setDesc('Milliseconds an edit settles before it is pushed.')
			.addSlider((slider) =>
				slider
					.setLimits(500, 30000, 500)
					.setValue(settings.debounceMs)
					.onChange((value: number) => {
						void update({ debounceMs: value });
					}),
			);
		new Setting(containerEl).setName('Sync on startup').addToggle((toggle) =>
			toggle.setValue(settings.syncOnStartup).onChange((value) => {
				void update({ syncOnStartup: value });
			}),
		);

		new Setting(containerEl).setName('Selective sync').setHeading();
		for (const [category, label] of Object.entries(categoryLabels)) {
			new Setting(containerEl).setName(label).addToggle((toggle) =>
				toggle.setValue(settings.categories[category as SyncCategory]).onChange((value) => {
					const categories = { ...settings.categories, [category]: value };
					void update({ categories });
				}),
			);
		}
		new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc('Comma-separated normalised folder paths.')
			.addText((text) =>
				text.setValue(settings.excludedFolders.join(', ')).onChange((value) => {
					void update({
						excludedFolders: value
							.split(',')
							.map((s) => s.trim())
							.filter(Boolean),
					});
				}),
			);
		new Setting(containerEl).setName('Maximum file size (MiB)').addText((text) =>
			text.setValue(String(Math.round(settings.maxFileBytes / (1024 * 1024)))).onChange((value) => {
				const mib = Number(value) || 100;
				void update({ maxFileBytes: mib * 1024 * 1024 });
			}),
		);

		new Setting(containerEl).setName('Actions').setHeading();
		new Setting(containerEl).setName('Sync now').addButton((button) =>
			button
				.setCta()
				.setButtonText('Sync now')
				.onClick(() => {
					new Notice('Syncing…');
					void this.#plugin.requestSync();
				}),
		);
	}
}

import { defaultChunkBytes } from '@obsidian-sync/protocol';
import type { SelectiveSyncOptions, SyncCategory } from './engine/selective.js';
import type { TransportPreference } from './transport/nudge.js';

/** Non-secret settings persisted in data.json. Secrets never live here (§6.4). */
export interface PluginSettings {
	serverUrl: string;
	deviceLabel: string;
	vaultName: string;
	transport: TransportPreference;
	pollIntervalSeconds: number;
	longPollWaitSeconds: number;
	debounceMs: number;
	syncOnStartup: boolean;
	enabled: boolean;
	chunkBytes: number;
	categories: Record<SyncCategory, boolean>;
	excludedFolders: string[];
	maxFileBytes: number;
	retentionDays: number;
}

export const defaultSettings: PluginSettings = {
	serverUrl: '',
	deviceLabel: '',
	vaultName: '',
	transport: 'automatic',
	pollIntervalSeconds: 60,
	longPollWaitSeconds: 25,
	debounceMs: 2000,
	syncOnStartup: true,
	enabled: false,
	chunkBytes: defaultChunkBytes,
	categories: {
		markdown: true,
		attachments: true,
		config: true,
		themes: true,
		snippets: true,
		pluginSettings: true,
	},
	excludedFolders: [],
	maxFileBytes: 100 * 1024 * 1024,
	retentionDays: 90,
};

// secretStorage ids must be lowercase alphanumeric with dashes; a slash throws.
export const secretKeys = {
	token: 'obsidian-sync-token',
	passphrase: 'obsidian-sync-passphrase',
} as const;

/** The two secrets, read from Obsidian's secret storage, never from data.json. */
export interface SecretsPort {
	getSecret(id: string): string | null;
	setSecret(id: string, value: string): void;
}

export function toSelectiveSyncOptions(settings: PluginSettings): SelectiveSyncOptions {
	return {
		categories: settings.categories,
		excludedFolders: settings.excludedFolders,
		maxFileBytes: settings.maxFileBytes,
	};
}

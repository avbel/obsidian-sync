import { normalisePath } from '@obsidian-sync/protocol';

export type SyncCategory =
	| 'markdown'
	| 'attachments'
	| 'config'
	| 'themes'
	| 'snippets'
	| 'pluginSettings';

export interface SelectiveSyncOptions {
	categories: Record<SyncCategory, boolean>;
	/** Normalised folder prefixes (no trailing slash); a file under any is skipped. */
	excludedFolders: string[];
	/** Skip files larger than this many bytes (§6.3 selective sync). */
	maxFileBytes: number;
}

const configDir = '.obsidian';

/** This plugin's manifest id; its own directory is never synced (§6.5). */
export const pluginId = 'obsidian-sync';
const pluginDir = `${configDir}/plugins/${pluginId}`;

/**
 * The guardrails that must never be synced (§6.5): device-local workspace layout
 * would make a phone reopen a desktop's panes, and this plugin's own state directory
 * would feed the index back through itself.
 */
export const neverSyncedPaths = new Set([
	`${configDir}/workspace.json`,
	`${configDir}/workspace-mobile.json`,
]);

export function isNeverSynced(normalisedPath: string): boolean {
	return (
		neverSyncedPaths.has(normalisedPath) ||
		normalisedPath === pluginDir ||
		normalisedPath.startsWith(`${pluginDir}/`)
	);
}

export function categorizePath(path: string): SyncCategory {
	const normalised = normalisePath(path);
	if (normalised.startsWith(`${configDir}/`)) {
		if (normalised.startsWith(`${configDir}/themes/`)) {
			return 'themes';
		}
		if (normalised.startsWith(`${configDir}/snippets/`)) {
			return 'snippets';
		}
		if (normalised.startsWith(`${configDir}/plugins/`) && normalised.endsWith('data.json')) {
			return 'pluginSettings';
		}
		return 'config';
	}
	return path.endsWith('.md') ? 'markdown' : 'attachments';
}

export function isPathIncluded(normalisedPath: string, options: SelectiveSyncOptions): boolean {
	if (isNeverSynced(normalisedPath)) {
		return false;
	}
	if (options.categories[categorizePath(normalisedPath)] === false) {
		return false;
	}
	return !options.excludedFolders.some(
		(folder) => normalisedPath === folder || normalisedPath.startsWith(`${folder}/`),
	);
}

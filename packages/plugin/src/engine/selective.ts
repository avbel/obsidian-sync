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

/**
 * Operating-system and editor debris, matched on the file name. Syncing these is
 * worse than useless: `.DS_Store` carries per-device Finder state, and the rest are
 * half-written files whose contents are meaningless on another machine.
 */
const ignoredFileNames = new Set([
	'.ds_store',
	'.localized',
	'desktop.ini',
	'ehthumbs.db',
	'ehthumbs_vista.db',
	'.directory',
	'.apdisk',
	'.volumeicon.icns',
	'.com.apple.timemachine.donotpresent',
]);

const ignoredFilePatterns = [
	/^\._/,
	/^\.#/,
	/^~\$/,
	/^\.nfs[0-9a-f]/,
	/^thumbs\.db/,
	/\.~/,
	/~$/,
	/\.(tmp|temp|swp|swo|log|bak|old|crdownload|part|partial)$/,
];

/**
 * Directories whose whole subtree is debris. `.trash` is the load-bearing one:
 * Obsidian's local trash lives there, so syncing it would resurrect every deleted
 * note as a file on every other device.
 */
const ignoredDirectories = new Set([
	'.trash',
	'.git',
	'.svn',
	'.hg',
	'.spotlight-v100',
	'.trashes',
	'.fseventsd',
	'.temporaryitems',
	'.appledouble',
	'.documentrevisions-v100',
	'$recycle.bin',
	'system volume information',
]);

export function isNeverSynced(normalisedPath: string): boolean {
	if (
		neverSyncedPaths.has(normalisedPath) ||
		normalisedPath === pluginDir ||
		normalisedPath.startsWith(`${pluginDir}/`)
	) {
		return true;
	}

	const segments = normalisedPath.split('/');
	// Lowercased throughout: macOS and Windows are case-insensitive, so THUMBS.DB
	// and thumbs.db are the same file and both must be caught.
	const name = (segments[segments.length - 1] ?? '').toLowerCase();
	if (segments.slice(0, -1).some((segment) => ignoredDirectories.has(segment.toLowerCase()))) {
		return true;
	}
	if (ignoredDirectories.has(name) || ignoredFileNames.has(name)) {
		return true;
	}
	return ignoredFilePatterns.some((pattern) => pattern.test(name));
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

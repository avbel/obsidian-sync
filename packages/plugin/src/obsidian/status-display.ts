import type { EngineStatus } from '../engine/sync.js';

export const statusIconClass = 'obsidian-sync-icon';

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
 * `idle` and `syncing` deliberately share a glyph: during a normal sync only the
 * spin and the colour change, so the status bar never shifts shape underneath the
 * pointer. The alert glyphs are reserved for states that need attention.
 */
export function statusIcon(status: EngineStatus): string {
	switch (status) {
		case 'idle':
		case 'syncing':
			return 'refresh-cw';
		case 'conflict':
			return 'alert-triangle';
		case 'error':
			return 'alert-circle';
	}
}

export function statusTooltip(status: EngineStatus, lastSyncAt: number, conflicts: number): string {
	const parts = [statusLabel(status)];
	parts.push(lastSyncAt === 0 ? 'never synced' : `last synced ${relativeTime(lastSyncAt)}`);
	if (conflicts > 0) {
		parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
	}
	return parts.join(' · ');
}

export function relativeTime(at: number): string {
	const seconds = Math.round((Date.now() - at) / 1000);
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	if (seconds < 3600) {
		return `${Math.round(seconds / 60)}m ago`;
	}
	return `${Math.round(seconds / 3600)}h ago`;
}

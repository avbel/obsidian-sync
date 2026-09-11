import type { App } from 'obsidian';
import { normalizePath, type Vault } from 'obsidian';
import type { LocalStateStore } from '../state/local-state.js';
import type { StateStorage } from '../state/storage.js';

/**
 * StateStorage backed by files under this plugin's own config directory, which is
 * never synced (§6.5). Each key is one JSON file under the plugin dir.
 */
export function createStateStorage(vault: Vault, dir: string): StateStorage {
	const pathFor = (key: string): string => normalizePath(`${dir}/${key}`);
	return {
		async read(key) {
			return (await vault.adapter.read(pathFor(key)).catch(() => null)) ?? undefined;
		},
		async write(key, value) {
			await vault.adapter.mkdir(dir).catch(() => undefined);
			await vault.adapter.write(pathFor(key), value);
		},
		async remove(key) {
			await vault.adapter.remove(pathFor(key)).catch(() => undefined);
		},
	};
}

/**
 * LocalStateStore over Obsidian's per-vault, per-device local storage, which is the
 * right home for device identity and the sync cursor (§6.4): it survives restarts but
 * never travels inside the vault, so it is not itself synced.
 */
export function createLocalStateStore(app: App): LocalStateStore {
	return {
		get: (key) => {
			const stored = app.loadLocalStorage(key);
			return typeof stored === 'string' ? stored : null;
		},
		set: (key, value) => {
			app.saveLocalStorage(key, value);
		},
	};
}

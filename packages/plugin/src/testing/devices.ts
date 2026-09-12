import type { PurposeKeys } from '../crypto/keys.js';
import type { SelectiveSyncOptions } from '../engine/selective.js';
import { type ConflictRecord, SyncEngine, type SyncEngineDeps } from '../engine/sync.js';
import { BaseCache } from '../state/base-cache.js';
import { FileIndex } from '../state/file-index.js';
import { LocalState, type LocalStateStore } from '../state/local-state.js';
import { PendingQueue } from '../state/pending-queue.js';
import type { ApiClient } from '../transport/client.js';
import type { FakeServer } from './fake-server.js';
import { MemoryStorage, MemoryVault } from './memory-fixtures.js';

export const fullSelective: SelectiveSyncOptions = {
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
};

export function memoryLocalState(): { local: LocalState; store: Map<string, string> } {
	const data = new Map<string, string>();
	const store: LocalStateStore = {
		get: (key) => data.get(key) ?? null,
		set: (key, value) => {
			data.set(key, value);
		},
	};
	return { local: new LocalState(store), store: data };
}

export interface DeviceContext {
	server: FakeServer;
	keys: PurposeKeys;
	client: ApiClient;
}

export interface DeviceOverrides {
	/** Reuse an existing vault, so a device can be rebuilt with its files but no index. */
	vault?: MemoryVault;
	/** Reuse durable state, so a rebuilt device retains index, bases, and queue. */
	storage?: MemoryStorage;
	selective?: SelectiveSyncOptions;
}

export interface Device {
	engine: SyncEngine;
	vault: MemoryVault;
	storage: MemoryStorage;
	index: FileIndex;
	bases: BaseCache;
	queue: PendingQueue;
	local: LocalState;
	conflicts: ConflictRecord[];
	deps: SyncEngineDeps;
}

export async function makeDevice(
	context: DeviceContext,
	deviceId: string,
	overrides: DeviceOverrides = {},
): Promise<Device> {
	const vault = overrides.vault ?? new MemoryVault();
	const storage = overrides.storage ?? new MemoryStorage();
	const index = new FileIndex(storage);
	const bases = new BaseCache(storage);
	const queue = new PendingQueue(storage);
	const { local } = memoryLocalState();
	await index.load();
	await bases.load();
	await queue.load();
	const conflicts: ConflictRecord[] = [];
	const deps: SyncEngineDeps = {
		vaultId: context.server.vaultId,
		client: context.client,
		keys: context.keys,
		vault,
		index,
		bases,
		local,
		queue,
		selective: overrides.selective ?? fullSelective,
		deviceId,
		deviceLabel: deviceId,
		onConflict: (conflict) => conflicts.push(conflict),
	};
	return {
		engine: new SyncEngine(deps),
		vault,
		storage,
		index,
		bases,
		queue,
		local,
		conflicts,
		deps,
	};
}

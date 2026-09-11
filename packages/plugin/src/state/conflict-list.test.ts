import { describe, expect, test } from 'vitest';
import { ConflictList } from './conflict-list.js';
import type { LocalStateStore } from './local-state.js';

function memoryStore(): { store: LocalStateStore; data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		store: {
			get: (key) => data.get(key) ?? null,
			set: (key, value) => {
				data.set(key, value);
			},
		},
	};
}

describe('ConflictList', () => {
	test('survives a reconstruction against the same store', () => {
		const { store } = memoryStore();
		new ConflictList(store).add({ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' });

		expect(new ConflictList(store).all()).toEqual([
			{ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' },
		]);
	});

	test('a second conflict on one path replaces the first rather than stacking', () => {
		const { store } = memoryStore();
		const list = new ConflictList(store);
		list.add({ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' });
		list.add({ path: 'a.md', conflictCopyPath: 'a (conflict 2).md' });

		expect(list.all()).toEqual([{ path: 'a.md', conflictCopyPath: 'a (conflict 2).md' }]);
	});

	test('removing by path clears the entry', () => {
		const { store } = memoryStore();
		const list = new ConflictList(store);
		list.add({ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' });
		list.add({ path: 'b.md', conflictCopyPath: 'b (conflict 1).md' });
		list.remove('a.md');

		expect(list.all().map((record) => record.path)).toEqual(['b.md']);
	});

	test('pruning drops records whose copy no longer exists', async () => {
		const { store } = memoryStore();
		const list = new ConflictList(store);
		list.add({ path: 'a.md', conflictCopyPath: 'a (conflict 1).md' });
		list.add({ path: 'b.md', conflictCopyPath: 'b (conflict 1).md' });

		await list.prune(async (path) => path === 'b (conflict 1).md');

		expect(list.all().map((record) => record.path)).toEqual(['b.md']);
	});

	test('a corrupt stored value reads as an empty list instead of throwing', () => {
		const { store, data } = memoryStore();
		data.set('obsidian-sync/conflicts', '{not json');

		expect(new ConflictList(store).all()).toEqual([]);
	});
});

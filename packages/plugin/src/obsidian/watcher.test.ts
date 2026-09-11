import { TFile, type Vault } from 'obsidian';
import { describe, expect, test, vi } from 'vitest';
import { DebouncedWatcher, type DirtyBatch } from './watcher.js';

type Handler = (file: TFile, oldPath?: string) => void;

class FakeVault {
	readonly handlers = new Map<string, Handler[]>();

	on(name: string, handler: Handler): { name: string; handler: Handler } {
		const existing = this.handlers.get(name) ?? [];
		existing.push(handler);
		this.handlers.set(name, existing);
		return { name, handler };
	}

	offref(): void {}

	emit(name: string, path: string): void {
		const file = new TFile();
		file.path = path;
		for (const handler of this.handlers.get(name) ?? []) {
			handler(file);
		}
	}

	asVault(): Vault {
		return this as unknown as Vault;
	}
}

function flush(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

describe('DebouncedWatcher', () => {
	test('collapses a burst of edits into one batch', async () => {
		vi.useFakeTimers();
		const vault = new FakeVault();
		const batches: DirtyBatch[] = [];
		const watcher = new DebouncedWatcher(vault.asVault(), 10, (batch) => {
			batches.push(batch);
		});
		watcher.start();

		vault.emit('modify', 'a.md');
		vault.emit('modify', 'a.md');
		vault.emit('create', 'b.md');
		await vi.advanceTimersByTimeAsync(20);

		expect(batches).toEqual([{ changed: ['a.md', 'b.md'], deleted: [] }]);
		watcher.stop();
		vi.useRealTimers();
	});

	test('a debounce change keeps the batch already collecting', async () => {
		vi.useFakeTimers();
		const vault = new FakeVault();
		const batches: DirtyBatch[] = [];
		const watcher = new DebouncedWatcher(vault.asVault(), 1000, (batch) => {
			batches.push(batch);
		});
		watcher.start();

		vault.emit('delete', 'gone.md');
		watcher.setDebounce(10);
		vault.emit('modify', 'a.md');
		await vi.advanceTimersByTimeAsync(20);

		expect(batches).toEqual([{ changed: ['a.md'], deleted: ['gone.md'] }]);
		watcher.stop();
		vi.useRealTimers();
	});

	test('re-queues a batch whose flush failed instead of forgetting the delete', async () => {
		const vault = new FakeVault();
		const seen: DirtyBatch[] = [];
		let shouldFail = true;
		const watcher = new DebouncedWatcher(vault.asVault(), 5, async (batch) => {
			seen.push(batch);
			if (shouldFail) {
				shouldFail = false;
				throw new Error('offline');
			}
		});
		watcher.start();

		vault.emit('delete', 'gone.md');
		await new Promise((resolve) => setTimeout(resolve, 20));
		await flush();
		expect(seen).toEqual([{ changed: [], deleted: ['gone.md'] }]);

		vault.emit('modify', 'other.md');
		await new Promise((resolve) => setTimeout(resolve, 20));
		await flush();

		expect(seen[1]).toEqual({ changed: ['other.md'], deleted: ['gone.md'] });
		watcher.stop();
	});
});

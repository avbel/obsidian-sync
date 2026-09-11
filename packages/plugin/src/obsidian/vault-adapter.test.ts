import { beforeEach, describe, expect, test } from 'vitest';
import { StaleWriteError } from '../engine/vault.js';
import { FakeApp } from '../testing/fake-app.js';
import { createVaultAdapter } from './vault-adapter.js';

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

let app: FakeApp;
let adapter: ReturnType<typeof createVaultAdapter>;

beforeEach(() => {
	app = new FakeApp();
	adapter = createVaultAdapter(app.asApp());
});

describe('creating files', () => {
	test('creates missing parent folders when pulling into an empty vault', async () => {
		await adapter.write('notes/deep/idea.md', encode('hello\n'));
		expect(app.text('notes/deep/idea.md')).toBe('hello\n');
	});

	test('creates missing parent folders for a config file', async () => {
		await adapter.write('.obsidian/plugins/other/data.json', encode('{}\n'));
		expect(app.text('.obsidian/plugins/other/data.json')).toBe('{}\n');
	});
});

describe('config directory coverage', () => {
	test('lists config files alongside ordinary notes', async () => {
		app.put('notes/idea.md', 'note\n');
		app.put('.obsidian/appearance.json', '{}\n');
		app.put('.obsidian/snippets/custom.css', 'body{}\n');

		const listed = (await adapter.list()).map((file) => file.path).sort();
		expect(listed).toEqual([
			'.obsidian/appearance.json',
			'.obsidian/snippets/custom.css',
			'notes/idea.md',
		]);
	});

	test('reads, writes and reports existence for a config file', async () => {
		app.put('.obsidian/appearance.json', '{"theme":"dark"}\n');
		await expect(adapter.exists('.obsidian/appearance.json')).resolves.toBe(true);
		expect(new TextDecoder().decode(await adapter.read('.obsidian/appearance.json'))).toBe(
			'{"theme":"dark"}\n',
		);

		await adapter.write('.obsidian/appearance.json', encode('{"theme":"light"}\n'));
		expect(app.text('.obsidian/appearance.json')).toBe('{"theme":"light"}\n');
	});

	test('trashes a config file through the adapter', async () => {
		app.put('.obsidian/snippets/custom.css', 'body{}\n');
		await adapter.trash('.obsidian/snippets/custom.css');
		expect(app.trashed).toEqual(['.obsidian/snippets/custom.css']);
	});
});

describe('guarded writes', () => {
	test('refuses a text write whose expected bytes are stale', async () => {
		app.put('note.md', 'original\n');
		const expected = encode('original\n');
		app.put('note.md', 'the user kept typing\n');

		await expect(adapter.write('note.md', encode('remote\n'), { expected })).rejects.toThrow(
			StaleWriteError,
		);
		expect(app.text('note.md')).toBe('the user kept typing\n');
	});

	test('writes through when the expected bytes still match', async () => {
		app.put('note.md', 'original\n');
		await adapter.write('note.md', encode('remote\n'), { expected: encode('original\n') });
		expect(app.text('note.md')).toBe('remote\n');
	});

	test('refuses a binary write whose expected bytes are stale', async () => {
		app.put('image.bin', 'aaa');
		const expected = encode('aaa');
		app.put('image.bin', 'bbb');

		await expect(adapter.write('image.bin', encode('ccc'), { expected })).rejects.toThrow(
			StaleWriteError,
		);
		expect(app.text('image.bin')).toBe('bbb');
	});
});

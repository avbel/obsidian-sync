import { describe, expect, test } from 'vitest';
import { categorizePath, isPathIncluded, type SelectiveSyncOptions } from './selective.js';

const allOn: SelectiveSyncOptions = {
	categories: {
		markdown: true,
		attachments: true,
		config: true,
		themes: true,
		snippets: true,
		pluginSettings: true,
	},
	excludedFolders: [],
	maxFileBytes: 1000,
};

describe('categorizePath', () => {
	test('markdown files', () => {
		expect(categorizePath('notes/a.md')).toBe('markdown');
	});
	test('config files', () => {
		expect(categorizePath('.obsidian/app.json')).toBe('config');
	});
	test('themes and snippets split out of config', () => {
		expect(categorizePath('.obsidian/themes/x/theme.css')).toBe('themes');
		expect(categorizePath('.obsidian/snippets/a.css')).toBe('snippets');
	});
	test('plugin data.json is pluginSettings', () => {
		expect(categorizePath('.obsidian/plugins/foo/data.json')).toBe('pluginSettings');
	});
	test('other config stays config', () => {
		expect(categorizePath('.obsidian/plugins/foo/main.js')).toBe('config');
	});
	test('non-markdown non-config is an attachment', () => {
		expect(categorizePath('img/photo.png')).toBe('attachments');
	});
});

describe('isPathIncluded', () => {
	test('never syncs workspace files (§6.5)', () => {
		expect(isPathIncluded('.obsidian/workspace.json', allOn)).toBe(false);
		expect(isPathIncluded('.obsidian/workspace-mobile.json', allOn)).toBe(false);
	});

	test('excludes a category when toggled off', () => {
		const noAttachments: SelectiveSyncOptions = {
			...allOn,
			categories: { ...allOn.categories, attachments: false },
		};
		expect(isPathIncluded('img/photo.png', noAttachments)).toBe(false);
		expect(isPathIncluded('notes/a.md', noAttachments)).toBe(true);
	});

	test('excluded folders hide their subtree', () => {
		const opts: SelectiveSyncOptions = { ...allOn, excludedFolders: ['secret'] };
		expect(isPathIncluded('secret/private.md', opts)).toBe(false);
		expect(isPathIncluded('secret/deep/x.md', opts)).toBe(false);
		expect(isPathIncluded('secretsafe/x.md', opts)).toBe(true);
	});
});

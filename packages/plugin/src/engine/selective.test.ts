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

describe('system and editor debris', () => {
	test('macOS metadata never syncs, at any depth', () => {
		expect(isPathIncluded('.DS_Store', allOn)).toBe(false);
		expect(isPathIncluded('.obsidian/.DS_Store', allOn)).toBe(false);
		expect(isPathIncluded('notes/deep/.DS_Store', allOn)).toBe(false);
		expect(isPathIncluded('notes/._resource', allOn)).toBe(false);
		expect(isPathIncluded('.Spotlight-V100/store.db', allOn)).toBe(false);
	});

	test('Windows and Linux debris never syncs', () => {
		expect(isPathIncluded('Thumbs.db', allOn)).toBe(false);
		expect(isPathIncluded('notes/desktop.ini', allOn)).toBe(false);
		expect(isPathIncluded('$RECYCLE.BIN/x', allOn)).toBe(false);
		expect(isPathIncluded('notes/.directory', allOn)).toBe(false);
	});

	test('editor temporaries and lock files never sync', () => {
		expect(isPathIncluded('notes/.a.md.swp', allOn)).toBe(false);
		expect(isPathIncluded('notes/a.md~', allOn)).toBe(false);
		expect(isPathIncluded('notes/.#a.md', allOn)).toBe(false);
		expect(isPathIncluded('notes/~$report.docx', allOn)).toBe(false);
		expect(isPathIncluded('notes/photo.png.part', allOn)).toBe(false);
	});

	// Obsidian's local trash lives here; syncing it would resurrect every deleted
	// note as a file on every other device.
	test('the local trash and version-control metadata never sync', () => {
		expect(isPathIncluded('.trash/deleted.md', allOn)).toBe(false);
		expect(isPathIncluded('.git/config', allOn)).toBe(false);
	});

	test('tilde variants, logs and thumbnail databases never sync', () => {
		expect(isPathIncluded('notes/report.~doc', allOn)).toBe(false);
		expect(isPathIncluded('notes/draft.~1~', allOn)).toBe(false);
		expect(isPathIncluded('notes/.~lock.sheet.ods#', allOn)).toBe(false);
		expect(isPathIncluded('logs/app.log', allOn)).toBe(false);
		expect(isPathIncluded('notes/a.md.bak', allOn)).toBe(false);
		expect(isPathIncluded('Thumbs.db:encryptable', allOn)).toBe(false);
		expect(isPathIncluded('THUMBS.DB', allOn)).toBe(false);
		expect(isPathIncluded('notes/ehthumbs_vista.db', allOn)).toBe(false);
	});

	test('ordinary notes that merely resemble debris still sync', () => {
		expect(isPathIncluded('notes/a~b.md', allOn)).toBe(true);
		expect(isPathIncluded('notes/desktop-setup.md', allOn)).toBe(true);
		expect(isPathIncluded('trash-talk/a.md', allOn)).toBe(true);
		expect(isPathIncluded('notes/template.md', allOn)).toBe(true);
		expect(isPathIncluded('notes/changelog.md', allOn)).toBe(true);
		expect(isPathIncluded('notes/~tilde-start.md', allOn)).toBe(true);
	});
});

import { describe, expect, test } from 'vitest';
import { defaultSettings, secretKeys, toSelectiveSyncOptions } from './settings.js';

describe('secretKeys', () => {
	// secretStorage.setSecret throws on any id outside lowercase alphanumerics and dashes.
	test('every id is accepted by Obsidian secret storage', () => {
		for (const id of Object.values(secretKeys)) {
			expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
		}
	});
});

describe('toSelectiveSyncOptions', () => {
	test('carries the category, exclusion and size settings through', () => {
		const options = toSelectiveSyncOptions({
			...defaultSettings,
			excludedFolders: ['archive'],
			maxFileBytes: 1024,
			categories: { ...defaultSettings.categories, attachments: false },
		});
		expect(options.excludedFolders).toEqual(['archive']);
		expect(options.maxFileBytes).toBe(1024);
		expect(options.categories.attachments).toBe(false);
	});
});

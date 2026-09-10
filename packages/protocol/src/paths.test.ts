import { describe, expect, test } from 'vitest';
import { isValidVaultPath, normalisePath } from './paths.js';

describe('normalisePath', () => {
	test('strips leading slashes', () => {
		expect(normalisePath('/notes/today.md')).toBe('notes/today.md');
	});

	test('converts backslashes to forward slashes', () => {
		expect(normalisePath('notes\\sub\\today.md')).toBe('notes/sub/today.md');
	});

	test('collapses repeated slashes', () => {
		expect(normalisePath('notes//sub///today.md')).toBe('notes/sub/today.md');
	});

	test('strips trailing slashes', () => {
		expect(normalisePath('notes/sub/')).toBe('notes/sub');
	});

	// macOS and iOS return NFD filenames; Linux and Android return NFC.
	// Without normalising, the same note yields two different fileIds.
	test('normalises decomposed unicode to NFC', () => {
		const decomposed = 'notes/cafe\u0301.md';
		const composed = 'notes/caf\u00e9.md';
		expect(decomposed).not.toBe(composed);
		expect(normalisePath(decomposed)).toBe(composed);
		expect(normalisePath(decomposed)).toBe(normalisePath(composed));
	});

	test('is idempotent', () => {
		const once = normalisePath('/notes//Café/a.md');
		expect(normalisePath(once)).toBe(once);
	});
});

describe('isValidVaultPath', () => {
	test('accepts an ordinary note path', () => {
		expect(isValidVaultPath('notes/today.md')).toBe(true);
	});

	test('rejects an empty path', () => {
		expect(isValidVaultPath('')).toBe(false);
	});

	test('rejects parent-directory traversal', () => {
		expect(isValidVaultPath('../outside.md')).toBe(false);
		expect(isValidVaultPath('notes/../../outside.md')).toBe(false);
	});

	test('rejects a null byte', () => {
		expect(isValidVaultPath('notes/bad\u0000.md')).toBe(false);
	});

	test('rejects a path that normalises to nothing', () => {
		expect(isValidVaultPath('/')).toBe(false);
	});
});

import { describe, expect, test } from 'vitest';
import { textToBytes } from '../crypto/encoding.js';
import { buildPreview, previewMaxLines } from './preview.js';

describe('buildPreview', () => {
	test('reports identical content without diffing', () => {
		const bytes = textToBytes('one\ntwo\n');
		expect(buildPreview('note.md', bytes, bytes).kind).toBe('identical');
	});

	test('diffs a text file and counts the change', () => {
		const preview = buildPreview(
			'note.md',
			textToBytes('one\ntwo\n'),
			textToBytes('one\ntwo\nthree\n'),
		);
		expect(preview.kind).toBe('diff');
		if (preview.kind === 'diff') {
			expect(preview.added).toBe(1);
			expect(preview.removed).toBe(0);
		}
	});

	test('refuses to diff a binary path', () => {
		const preview = buildPreview('image.png', new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]));
		expect(preview.kind).toBe('binary');
	});

	test('refuses to diff beyond the line cap', () => {
		const big = textToBytes(`${'line\n'.repeat(previewMaxLines + 1)}`);
		const preview = buildPreview('note.md', big, textToBytes('line\n'));
		expect(preview.kind).toBe('tooLarge');
	});

	test('treats a missing local file as an all-insert diff', () => {
		const preview = buildPreview('note.md', undefined, textToBytes('one\ntwo\n'));
		expect(preview.kind).toBe('diff');
		if (preview.kind === 'diff') {
			expect(preview.removed).toBe(0);
			expect(preview.added).toBeGreaterThan(0);
		}
	});
});

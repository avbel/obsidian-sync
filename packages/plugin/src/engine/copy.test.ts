import { describe, expect, test } from 'vitest';
import { copyStamp, uniqueCopyPath } from './copy.js';

describe('copy helpers', () => {
	test('formats a filename-safe chronological timestamp', () => {
		expect(copyStamp(Date.UTC(2026, 8, 12, 14, 31, 7))).toBe('2026-09-12-14-31-07');
	});

	test('preserves the extension', async () => {
		expect(await uniqueCopyPath(async () => false, 'note.md', 'restored 2026-09-12')).toBe(
			'note (restored 2026-09-12).md',
		);
	});

	test('handles extensionless paths', async () => {
		expect(await uniqueCopyPath(async () => false, 'README', 'restored 2026-09-12')).toBe(
			'README (restored 2026-09-12)',
		);
	});

	test('uses a suffix ladder without overwriting earlier copies', async () => {
		const existing = new Set(['note (restored 2026-09-12).md', 'note (restored 2026-09-12) 2.md']);
		expect(
			await uniqueCopyPath(
				async (candidate) => existing.has(candidate),
				'note.md',
				'restored 2026-09-12',
			),
		).toBe('note (restored 2026-09-12) 3.md');
	});

	test('does not mistake a dotted directory for an extension', async () => {
		expect(await uniqueCopyPath(async () => false, 'docs.v2/note.md', 'restored 2026-09-12')).toBe(
			'docs.v2/note (restored 2026-09-12).md',
		);
	});
});

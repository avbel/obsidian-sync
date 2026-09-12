import { bytesToText, sameBytes } from '../crypto/encoding.js';
import { type DiffRow, diffLines } from './merge.js';
import { isTextPath } from './text.js';

/**
 * The LCS table in merge.ts is `(lines + 1)^2` numbers: at 2000 lines a side that is
 * ~4M cells, roughly 16–32 MB in V8, which a phone survives once, on demand. An
 * order of magnitude more lines is 400M cells and kills the renderer, so the preview
 * declines rather than trying. Restore itself is unaffected — only the diff is capped.
 */
export const previewMaxLines = 2000;
export const previewMaxBytes = 1024 * 1024;

export type VersionPreview =
	| { kind: 'identical' }
	| { kind: 'diff'; rows: DiffRow[]; added: number; removed: number }
	| { kind: 'binary'; currentBytes: number | undefined; versionBytes: number }
	| {
			kind: 'tooLarge';
			reason: 'bytes' | 'lines';
			currentBytes: number | undefined;
			versionBytes: number;
	  };

function countLines(text: string): number {
	let lines = 1;
	for (const character of text) {
		if (character === '\n') {
			lines += 1;
		}
	}
	return lines;
}

/**
 * What to show for one historical version against what is on disk now.
 * `current` is undefined when the file no longer exists locally.
 */
export function buildPreview(
	path: string,
	current: Uint8Array | undefined,
	version: Uint8Array,
): VersionPreview {
	const currentBytes = current?.byteLength;

	if (current !== undefined && sameBytes(current, version)) {
		return { kind: 'identical' };
	}
	if (!isTextPath(path)) {
		return { kind: 'binary', currentBytes, versionBytes: version.byteLength };
	}
	if ((currentBytes ?? 0) > previewMaxBytes || version.byteLength > previewMaxBytes) {
		return { kind: 'tooLarge', reason: 'bytes', currentBytes, versionBytes: version.byteLength };
	}

	const currentText = current === undefined ? '' : bytesToText(current);
	const versionText = bytesToText(version);
	if (countLines(currentText) > previewMaxLines || countLines(versionText) > previewMaxLines) {
		return { kind: 'tooLarge', reason: 'lines', currentBytes, versionBytes: version.byteLength };
	}

	const rows = diffLines(currentText, versionText);
	return {
		kind: 'diff',
		rows,
		added: rows.filter((row) => row.op === 'insert').length,
		removed: rows.filter((row) => row.op === 'delete').length,
	};
}

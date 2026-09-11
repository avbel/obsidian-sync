import { describe, expect, test } from 'vitest';
import { diffLines, merge3 } from './merge.js';

describe('merge3', () => {
	test('both sides unchanged returns base', () => {
		const base = 'a\nb\nc\n';
		expect(merge3(base, base, base)).toEqual({ ok: true, text: base });
	});

	test('only remote changed: take remote', () => {
		const result = merge3('a\nb\nc\n', 'a\nb\nc\n', 'a\nB\nc\n');
		expect(result).toEqual({ ok: true, text: 'a\nB\nc\n' });
	});

	test('only local changed: take local (no remote hunk applies)', () => {
		const result = merge3('a\nb\nc\n', 'a\nX\nc\n', 'a\nb\nc\n');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.text).toBe('a\nX\nc\n');
		}
	});

	test('disjoint edits merge cleanly', () => {
		const base = 'line1\nline2\nline3\nline4\nline5\n';
		const local = 'line1\nLOCAL\nline3\nline4\nline5\n';
		const remote = 'line1\nline2\nline3\nREMOTE\nline5\n';
		const result = merge3(base, local, remote);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.text).toBe('line1\nLOCAL\nline3\nREMOTE\nline5\n');
		}
	});

	test('identical edits to the same line do not conflict', () => {
		const base = 'a\nb\n';
		const both = 'a\nchanged\n';
		expect(merge3(base, both, both)).toEqual({ ok: true, text: 'a\nchanged\n' });
	});

	test('true conflict is reported, both sides preserved', () => {
		const base = 'a\nb\nc\n';
		const local = 'a\nLOCAL\nc\n';
		const remote = 'a\nREMOTE\nc\n';
		const result = merge3(base, local, remote);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// The conflict payload is the differing region, not the surrounding
			// context: the resolution modal shows both sides of the clashing lines.
			expect(result.conflictedLocal).toEqual(['LOCAL']);
			expect(result.conflictedRemote).toEqual(['REMOTE']);
		}
	});

	test('ancestor unknown is the caller to handle, not merge3', () => {
		// merge3 always receives a base; when the caller has no base it does not call
		// merge3 at all. This asserts the contract by showing base === local === remote.
		expect(merge3('x\n', 'x\n', 'x\n')).toEqual({ ok: true, text: 'x\n' });
	});
});

describe('diffLines', () => {
	test('returns equal rows for identical input', () => {
		expect(diffLines('one\ntwo\n', 'one\ntwo\n')).toEqual([
			{ op: 'equal', text: 'one' },
			{ op: 'equal', text: 'two' },
			{ op: 'equal', text: '' },
		]);
	});

	test('returns trailing inserts for an append', () => {
		expect(diffLines('one\n', 'one\ntwo\n')).toEqual([
			{ op: 'equal', text: 'one' },
			{ op: 'insert', text: 'two' },
			{ op: 'equal', text: '' },
		]);
	});

	test('returns deletes for removed lines', () => {
		expect(diffLines('one\ntwo\n', 'one\n')).toEqual([
			{ op: 'equal', text: 'one' },
			{ op: 'delete', text: 'two' },
			{ op: 'equal', text: '' },
		]);
	});

	test('represents a replacement as a delete followed by an insert', () => {
		expect(diffLines('one\ntwo\n', 'one\nthree\n')).toEqual([
			{ op: 'equal', text: 'one' },
			{ op: 'delete', text: 'two' },
			{ op: 'insert', text: 'three' },
			{ op: 'equal', text: '' },
		]);
	});

	test('terminates for empty input on either side', () => {
		expect(diffLines('', 'one\n')).toEqual([
			{ op: 'insert', text: 'one' },
			{ op: 'equal', text: '' },
		]);
		expect(diffLines('one\n', '')).toEqual([
			{ op: 'delete', text: 'one' },
			{ op: 'equal', text: '' },
		]);
	});
});

import { describe, expect, test } from 'vitest';
import { describeReconcile, planReconcile, type ReconcileSummary } from './reconcile.js';

const bigEnough = 1024 * 1024;

describe('planReconcile', () => {
	test('a remote file the index has never seen is pulled', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 10 }],
			indexed: [],
			maxFileBytes: bigEnough,
		});

		expect(plan.pull).toEqual(['f1']);
		expect(plan.remoteDeletes).toEqual([]);
	});

	test('a remote file still at the indexed head is left alone', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 10 }],
			indexed: [{ fileId: 'f1', versionId: 'v1' }],
			maxFileBytes: bigEnough,
		});

		expect(plan.pull).toEqual([]);
		expect(plan.remoteDeletes).toEqual([]);
	});

	test('a remote file whose head has moved is pulled', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v2', size: 10 }],
			indexed: [{ fileId: 'f1', versionId: 'v1' }],
			maxFileBytes: bigEnough,
		});

		expect(plan.pull).toEqual(['f1']);
	});

	test('an indexed file the server no longer lists is a remote delete', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 10 }],
			indexed: [
				{ fileId: 'f1', versionId: 'v1' },
				{ fileId: 'f2', versionId: 'v9' },
			],
			maxFileBytes: bigEnough,
		});

		expect(plan.remoteDeletes).toEqual(['f2']);
		expect(plan.pull).toEqual([]);
	});

	test('a remote file past the size limit is reported, not pulled', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 2048 }],
			indexed: [],
			maxFileBytes: 1024,
		});

		expect(plan.oversized).toEqual(['f1']);
		expect(plan.pull).toEqual([]);
	});

	// A server that lists nothing while the index tracks files is far more often a
	// wrong vault id or a restored blank database than a genuine mass delete.
	test('an empty server listing withholds every delete and says so', () => {
		const plan = planReconcile({
			remote: [],
			indexed: [
				{ fileId: 'f1', versionId: 'v1' },
				{ fileId: 'f2', versionId: 'v2' },
			],
			maxFileBytes: bigEnough,
		});

		expect(plan.massDeleteGuarded).toBe(true);
		expect(plan.remoteDeletes).toEqual([]);
	});

	test('an empty server listing against an empty index guards nothing', () => {
		const plan = planReconcile({ remote: [], indexed: [], maxFileBytes: bigEnough });

		expect(plan.massDeleteGuarded).toBe(false);
		expect(plan.remoteDeletes).toEqual([]);
		expect(plan.pull).toEqual([]);
	});

	test('deleting the last file of many is not treated as a mass delete', () => {
		const plan = planReconcile({
			remote: [{ fileId: 'f1', headVersion: 'v1', size: 10 }],
			indexed: [
				{ fileId: 'f1', versionId: 'v1' },
				{ fileId: 'f2', versionId: 'v2' },
			],
			maxFileBytes: bigEnough,
		});

		expect(plan.massDeleteGuarded).toBe(false);
		expect(plan.remoteDeletes).toEqual(['f2']);
	});
});

describe('describeReconcile', () => {
	const quiet: ReconcileSummary = {
		remoteFiles: 12,
		pulled: 0,
		mergedLocally: 0,
		removed: 0,
		skippedOversize: 0,
		massDeleteGuarded: false,
	};

	test('a reconcile that changed nothing still reports the vault size', () => {
		expect(describeReconcile(quiet)).toBe('Reconcile complete: 12 file(s) on the server.');
	});

	test('every non-zero count is named', () => {
		expect(
			describeReconcile({
				...quiet,
				pulled: 3,
				mergedLocally: 1,
				removed: 2,
				skippedOversize: 4,
			}),
		).toBe(
			'Reconcile complete: 12 file(s) on the server, 3 pulled, 1 merged, 2 removed, 4 skipped as too large.',
		);
	});
});

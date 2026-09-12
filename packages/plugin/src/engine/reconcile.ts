/** One live file as the server reports it in `GET /state`. */
export interface RemoteFileSummary {
	fileId: string;
	headVersion: string;
	/** Plaintext byte length, for the size limit only. */
	size: number;
}

/** One entry of the local index, reduced to what the comparison needs. */
export interface IndexedFileSummary {
	fileId: string;
	versionId: string;
}

/** Share of the tracked index that may vanish from one `GET /state` before deletes are withheld. */
export const massDeleteShare = 0.5;

export interface ReconcileInput {
	remote: RemoteFileSummary[];
	indexed: IndexedFileSummary[];
	maxFileBytes: number;
}

export interface ReconcilePlan {
	/** fileIds whose server head differs from the index, or that the index never saw. */
	pull: string[];
	/** fileIds the index tracks that the server no longer lists as live. */
	remoteDeletes: string[];
	/** fileIds skipped because the remote plaintext exceeds the size limit. */
	oversized: string[];
	/** True when the delete pass was withheld because too much of the index vanished at once. */
	massDeleteGuarded: boolean;
}

export interface ReconcileSummary {
	remoteFiles: number;
	pulled: number;
	mergedLocally: number;
	removed: number;
	skippedOversize: number;
	massDeleteGuarded: boolean;
}

/**
 * Compare the server's live file list against the local index (§7.4).
 *
 * Comparison is on `fileId` alone, which is sound because `fileId` is a MAC of the
 * path: a file's path cannot drift under a stable id, so a rename arrives as one
 * delete and one create rather than as a moved file. That is also what lets the
 * caller skip decrypting `metaBlob` for everything outside `pull` — the expensive
 * work happens only where the two sides genuinely disagree.
 *
 * Local-only divergence (a file edited or removed on disk while the head did not
 * move) is deliberately absent: `SyncEngine.pushAll` already re-derives both from
 * the vault, and duplicating that here would race it.
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
	const indexedVersions = new Map(
		input.indexed.map((entry) => [entry.fileId, entry.versionId] as const),
	);
	const remoteIds = new Set<string>();
	const pull: string[] = [];
	const oversized: string[] = [];

	for (const file of input.remote) {
		remoteIds.add(file.fileId);
		if (file.size > input.maxFileBytes) {
			oversized.push(file.fileId);
			continue;
		}
		if (indexedVersions.get(file.fileId) !== file.headVersion) {
			pull.push(file.fileId);
		}
	}

	const candidates = input.indexed.filter((entry) => !remoteIds.has(entry.fileId));
	// A vault that reports most of itself missing is far more often a wrong vault id, a
	// restored or truncated database, or a server bug than a real bulk delete, and the cost
	// of being wrong is the whole vault. Checking the share rather than only the empty list
	// matters because one innocuous file in the response would otherwise disarm the guard
	// completely. Withhold and report instead — but only when several files would fall: a
	// lone tracked file is likelier one genuine remote delete, and withholding it would
	// wedge the republish of any local edit against the forgotten server version. A real
	// bulk delete still arrives unguarded as explicit records on the /changes path.
	const massDeleteGuarded =
		input.indexed.length > 1 && candidates.length > input.indexed.length * massDeleteShare;
	const remoteDeletes = massDeleteGuarded ? [] : candidates.map((entry) => entry.fileId);

	return { pull, remoteDeletes, oversized, massDeleteGuarded };
}

export function describeReconcile(summary: ReconcileSummary): string {
	const parts = [`${summary.remoteFiles} file(s) on the server`];
	if (summary.pulled > 0) {
		parts.push(`${summary.pulled} pulled`);
	}
	if (summary.mergedLocally > 0) {
		parts.push(`${summary.mergedLocally} merged`);
	}
	if (summary.removed > 0) {
		parts.push(`${summary.removed} removed`);
	}
	if (summary.skippedOversize > 0) {
		parts.push(`${summary.skippedOversize} skipped as too large`);
	}
	return `Reconcile complete: ${parts.join(', ')}.`;
}

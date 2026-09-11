export function splitLines(text: string): string[] {
	return text.split('\n');
}

export function joinLines(lines: string[]): string {
	return lines.join('\n');
}

/** 'equal' advances both, 'delete' advances a only, 'insert' advances b only. */
type DiffOp = 'equal' | 'delete' | 'insert';

function lcsOps(a: string[], b: string[]): DiffOp[] {
	const rows = a.length + 1;
	const columns = b.length + 1;
	const table: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));

	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			const cell = table[i];
			if (cell === undefined) {
				continue;
			}
			cell[j] =
				a[i] === b[j]
					? (table[i + 1]?.[j + 1] ?? 0) + 1
					: Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			ops.push('equal');
			i += 1;
			j += 1;
		} else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
			ops.push('delete');
			i += 1;
		} else {
			ops.push('insert');
			j += 1;
		}
	}
	while (i < a.length) {
		ops.push('delete');
		i += 1;
	}
	while (j < b.length) {
		ops.push('insert');
		j += 1;
	}
	return ops;
}

/** A replacement of base[baseStart,baseEnd) with `lines`. */
interface Hunk {
	baseStart: number;
	baseEnd: number;
	lines: string[];
}

function hunks(a: string[], b: string[], ops: DiffOp[]): Hunk[] {
	const result: Hunk[] = [];
	let ai = 0;
	let bi = 0;
	let current: Hunk | undefined;
	const flush = (): void => {
		if (current !== undefined) {
			result.push(current);
			current = undefined;
		}
	};
	for (const op of ops) {
		if (op === 'equal') {
			flush();
			ai += 1;
			bi += 1;
		} else if (op === 'delete') {
			current ??= { baseStart: ai, baseEnd: ai, lines: [] };
			current.baseEnd = ai + 1;
			ai += 1;
		} else {
			current ??= { baseStart: ai, baseEnd: ai, lines: [] };
			current.lines.push(b[bi] as string);
			bi += 1;
		}
	}
	flush();
	return result;
}

function sameLines(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((line, index) => line === b[index]);
}

export type MergeResult =
	| { ok: true; text: string }
	| { ok: false; reason: 'conflict'; conflictedLocal: string[]; conflictedRemote: string[] };

/**
 * Three-way merge of a text file against a shared ancestor (§8).
 *
 * Each side is reduced to hunks over the base. Hunks that do not touch the same base
 * lines merge independently; hunks on both sides over the same lines are a clean match
 * if they carry identical text and a conflict otherwise. On conflict the caller writes
 * a conflict copy and shows the resolution modal — this function never mutates state.
 */
export function merge3(baseText: string, localText: string, remoteText: string): MergeResult {
	const base = splitLines(baseText);
	const localHunks = hunks(base, splitLines(localText), lcsOps(base, splitLines(localText)));
	const remoteHunks = hunks(base, splitLines(remoteText), lcsOps(base, splitLines(remoteText)));

	// Group hunks that share base lines; independent hunks never conflict.
	type Cluster = { local: Hunk[]; remote: Hunk[] };
	const clusters: Cluster[] = [];
	const all = [
		...localHunks.map((hunk) => ({ hunk, side: 'local' as const })),
		...remoteHunks.map((hunk) => ({ hunk, side: 'remote' as const })),
	].sort((left, right) => left.hunk.baseStart - right.hunk.baseStart);

	let current: Cluster | undefined;
	let reach = -1;
	for (const { hunk, side } of all) {
		if (current !== undefined && hunk.baseStart <= reach) {
			current[side].push(hunk);
			reach = Math.max(reach, hunk.baseEnd);
		} else {
			if (current !== undefined) {
				clusters.push(current);
			}
			current = { local: [], remote: [] };
			current[side].push(hunk);
			reach = hunk.baseEnd;
		}
	}
	if (current !== undefined) {
		clusters.push(current);
	}

	const out: string[] = [];
	let cursor = 0;

	for (const cluster of clusters) {
		const start = Math.min(...[...cluster.local, ...cluster.remote].map((hunk) => hunk.baseStart));
		const end = Math.max(...[...cluster.local, ...cluster.remote].map((hunk) => hunk.baseEnd));

		// Copy untouched base context up to this cluster.
		for (let index = cursor; index < start; index += 1) {
			out.push(base[index] as string);
		}

		const localTextForCluster = cluster.local.flatMap((hunk) => hunk.lines);
		const remoteTextForCluster = cluster.remote.flatMap((hunk) => hunk.lines);
		const localChanged = cluster.local.length > 0;
		const remoteChanged = cluster.remote.length > 0;

		if (localChanged && remoteChanged) {
			if (sameLines(localTextForCluster, remoteTextForCluster)) {
				out.push(...localTextForCluster);
			} else {
				return {
					ok: false,
					reason: 'conflict',
					conflictedLocal: localTextForCluster,
					conflictedRemote: remoteTextForCluster,
				};
			}
		} else if (localChanged) {
			out.push(...localTextForCluster);
		} else {
			out.push(...remoteTextForCluster);
		}

		cursor = end;
	}

	for (let index = cursor; index < base.length; index += 1) {
		out.push(base[index] as string);
	}

	return { ok: true, text: joinLines(out) };
}

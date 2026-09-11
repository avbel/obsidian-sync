/** `2026-09-12-14-31-07` — filename-safe, sorts chronologically, no colons for Windows. */
export function copyStamp(at: number): string {
	return new Date(at).toISOString().slice(0, 19).replace(/[T:]/g, '-');
}

/**
 * A sidecar path next to `path`, marked and timestamped, that no existing file
 * holds. Two restores in the same second, or a restore onto an earlier conflict
 * copy, must not silently overwrite the earlier sidecar.
 */
export async function uniqueCopyPath(
	exists: (candidate: string) => Promise<boolean>,
	path: string,
	marker: string,
): Promise<string> {
	const extension = /\.[^./]+$/.exec(path)?.[0] ?? '';
	const stem = `${path.slice(0, path.length - extension.length)} (${marker})`;
	let candidate = `${stem}${extension}`;
	for (let suffix = 2; await exists(candidate); suffix += 1) {
		candidate = `${stem} ${suffix}${extension}`;
	}
	return candidate;
}

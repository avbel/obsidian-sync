/**
 * Canonical vault path form: forward slashes, no leading or trailing slash,
 * no repeated slashes, NFC-normalised.
 *
 * NFC is load-bearing, not cosmetic. macOS and iOS return decomposed (NFD)
 * filenames from the filesystem while Linux and Android return composed ones,
 * so the same note on two platforms would otherwise hash to two different
 * fileIds and sync as two separate files.
 */
export function normalisePath(rawPath: string): string {
	return rawPath
		.replaceAll('\\', '/')
		.split('/')
		.filter((segment) => segment.length > 0)
		.join('/')
		.normalize('NFC');
}

export function isValidVaultPath(rawPath: string): boolean {
	if (rawPath.includes('\u0000')) {
		return false;
	}

	const normalised = normalisePath(rawPath);
	if (normalised.length === 0) {
		return false;
	}

	return !normalised.split('/').some((segment) => segment === '.' || segment === '..');
}

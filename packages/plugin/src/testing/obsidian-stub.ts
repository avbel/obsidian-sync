/**
 * Runtime stand-in for the `obsidian` package, which ships types only. Aliased in
 * vitest.config.ts so modules that touch the real API can be tested at all.
 */

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/{2,}/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.normalize('NFC');
}

export class TAbstractFile {
	path = '';
	name = '';
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	stat = { mtime: 0, ctime: 0, size: 0 };
	basename = '';
	extension = '';
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot(): boolean {
		return this.path === '/';
	}
}

export class Notice {
	constructor(readonly message: string) {}
}

export const Platform = {
	isPhone: false,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
};

export function requireApiVersion(): boolean {
	return true;
}

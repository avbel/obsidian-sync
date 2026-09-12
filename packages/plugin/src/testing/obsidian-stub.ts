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

/** Every notice raised during a test, so a failure reason can be asserted on. */
export const notices: string[] = [];

export class Notice {
	/** The plugin marks this tappable and listens on it; nothing here reads the result. */
	readonly noticeEl = {
		addClass(): void {},
		addEventListener(): void {},
	};

	constructor(readonly message: string) {
		notices.push(message);
	}

	hide(): void {}
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

export function setIcon(): void {
	// The real one mutates a DOM node; nothing under test reads the result.
}

export function setTooltip(): void {
	// Same.
}

type RequestUrlHandler = (params: {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
}) => Promise<{ status: number; arrayBuffer: ArrayBuffer; json(): unknown; text: string }>;

let requestUrlHandler: RequestUrlHandler | undefined;

/** Point `requestUrl` at a fake server for the duration of a test. */
export function setRequestUrlHandler(handler: RequestUrlHandler | undefined): void {
	requestUrlHandler = handler;
}

export function requestUrl(
	params: Parameters<RequestUrlHandler>[0],
): ReturnType<RequestUrlHandler> {
	if (requestUrlHandler === undefined) {
		throw new Error('requestUrl was called without setRequestUrlHandler');
	}
	return requestUrlHandler(params);
}

/**
 * Enough of `Plugin` to construct the real SyncPlugin and drive its engine lifecycle.
 * `onload` is not called by these tests, so the status bar item stays null and the
 * status-bar and foreground-listener paths never run.
 */
export class Plugin {
	#data: unknown = null;

	constructor(
		readonly app: unknown,
		readonly manifest: unknown,
	) {}

	addCommand(): void {}
	addRibbonIcon(): unknown {
		return {};
	}
	addSettingTab(): void {}
	addStatusBarItem(): unknown {
		return null;
	}
	registerEvent(): void {}
	registerDomEvent(): void {}
	registerInterval(): void {}
	registerView(): void {}
	async loadData(): Promise<unknown> {
		return this.#data;
	}
	async saveData(data: unknown): Promise<void> {
		this.#data = data;
	}
}

export class Modal {
	constructor(readonly app: unknown) {}
	open(): void {}
	close(): void {}
	setTitle(): void {}
}

export class PluginSettingTab {
	constructor(
		readonly app: unknown,
		readonly plugin: unknown,
	) {}
	display(): void {}
	hide(): void {}
}

/** A chainable no-op: the settings tab builds these at construction time. */
export class Setting {
	constructor(readonly containerEl: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	addText(): this {
		return this;
	}
	addButton(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
	addDropdown(): this {
		return this;
	}
}

export class ItemView {
	constructor(readonly leaf: unknown) {}
}

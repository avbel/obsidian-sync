/** A file listing entry the engine needs: path plus stat metadata, no contents read. */
export interface VaultFile {
	path: string;
	mtime: number;
	size: number;
	ctime: number;
}

/**
 * Raised when a write guarded by `expected` finds different bytes on disk, meaning
 * the user edited the file between the engine reading it and applying a remote
 * version. The caller re-reads and resolves again rather than clobbering the edit.
 */
export class StaleWriteError extends Error {
	readonly path: string;

	constructor(path: string) {
		super(`${path} changed locally while a remote version was being applied`);
		this.name = 'StaleWriteError';
		this.path = path;
	}
}

export interface WriteOptions {
	mtime?: number | undefined;
	/** The bytes the caller last saw; the write is refused if the file no longer holds them. */
	expected?: Uint8Array | undefined;
}

/**
 * The vault surface the sync engine depends on, kept narrow and injection-friendly so
 * the whole engine is testable against an in-memory vault (§11) and the Obsidian
 * adapter is the only module that imports `obsidian`.
 */
export interface VaultAdapter {
	list(): Promise<VaultFile[]>;
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<Uint8Array>;
	/** Compare-and-set against `expected`, closing the mid-keystroke pull window (§6.2). */
	write(path: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
	remove(path: string): Promise<void>;
	/** Remote deletes honour the trash preference so a bad sync is recoverable (§6.2). */
	trash(path: string): Promise<void>;
}

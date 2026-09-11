/** A file listing entry the engine needs: path plus stat metadata, no contents read. */
export interface VaultFile {
	path: string;
	mtime: number;
	size: number;
	ctime: number;
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
	/** Atomic read-modify-write for text, closing the mid-keystroke pull window (§6.2). */
	write(path: string, data: Uint8Array, mtime?: number): Promise<void>;
	remove(path: string): Promise<void>;
	/** Remote deletes honour the trash preference so a bad sync is recoverable (§6.2). */
	trash(path: string): Promise<void>;
}

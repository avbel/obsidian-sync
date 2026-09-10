export type ChangeKind = 'upsert' | 'delete';

export interface ChangeEntry {
	seq: number;
	fileId: string;
	kind: ChangeKind;
	versionId: string | undefined;
	size: number;
	createdAt: number;
}

export interface ChangesResponse {
	changes: ChangeEntry[];
	seq: number;
	hasMore: boolean;
}

export interface CommitVersionRequest {
	/** Version this client believes is current; omitted when creating the file. */
	parentVersion: string | undefined;
	/** Base64 of the encrypted metadata envelope: path, mtime, ctime, mime. */
	metaBlob: string;
	/** Ordered blob addresses. Empty for a zero-byte file. */
	chunks: string[];
	/** Plaintext byte length, for display and quota only. */
	size: number;
	deviceId: string;
}

export interface CommitVersionResponse {
	versionId: string;
	seq: number;
}

export interface ConflictResponse {
	error: 'conflict';
	/** The version the server actually holds; undefined when the file is deleted. */
	headVersion: string | undefined;
}

export interface BlobCheckRequest {
	addresses: string[];
}

export interface BlobCheckResponse {
	/** Subset of the requested addresses the server does not hold. */
	missing: string[];
}

export interface FileState {
	fileId: string;
	headVersion: string;
	metaBlob: string;
	size: number;
	updatedSeq: number;
}

export interface VaultStateResponse {
	files: FileState[];
	seq: number;
}

export interface VaultSummary {
	id: string;
	name: string;
	/** Base64 of the per-vault PBKDF2 salt. Not secret. */
	kdfSalt: string;
}

export interface MeResponse {
	user: string;
	vaults: VaultSummary[];
	protocolVersion: number;
}

export interface CreateVaultRequest {
	name: string;
}

export interface VersionSummary {
	versionId: string;
	parentVersion: string | undefined;
	size: number;
	deviceId: string;
	createdAt: number;
}

export interface VersionsResponse {
	versions: VersionSummary[];
}

export interface StreamTicketResponse {
	ticket: string;
	expiresAt: number;
}

export interface NudgeMessage {
	seq: number;
}

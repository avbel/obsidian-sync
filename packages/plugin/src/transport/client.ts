import type {
	BlobCheckResponse,
	ChangesResponse,
	CommitVersionRequest,
	CommitVersionResponse,
	CreateVaultRequest,
	MeResponse,
	StreamTicketResponse,
	VaultStateResponse,
	VersionsResponse,
} from '@obsidian-sync/protocol';

/**
 * The subset of Obsidian's `requestUrl` the client depends on, kept structural so
 * the whole transport layer is testable with a stub and never imports `obsidian`
 * (which is unavailable under Node and unusable from the plugin's pure logic).
 */
export interface SyncResponse {
	status: number;
	arrayBuffer: ArrayBuffer;
	json(): unknown;
}

export interface SyncRequest {
	path: string;
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	/** A JSON object to serialize, or raw bytes for a chunk upload. */
	body?: Uint8Array | object;
	query?: Record<string, string | number>;
	raw?: boolean;
}

export interface Requester {
	request(request: SyncRequest): Promise<SyncResponse>;
}

export class ServerError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown) {
		super(`sync server responded ${status}`);
		this.name = 'ServerError';
		this.status = status;
		this.body = body;
	}
}

/** A 401 halts sync (§9); distinguished so callers stop rather than back off. */
export class UnauthorizedError extends Error {
	constructor() {
		super('the sync server rejected the credentials');
		this.name = 'UnauthorizedError';
	}
}

/** 409 is normal control flow (§9), not a failure; surfaced as a typed signal. */
export class ConflictError extends Error {
	readonly headVersion: string | undefined;

	constructor(headVersion: string | undefined) {
		super('a newer version exists on the server');
		this.name = 'ConflictError';
		this.headVersion = headVersion;
	}
}

/**
 * A request that never settled. `requestUrl` has no timeout of its own (§R1), and a
 * connection frozen by an app suspension otherwise hangs forever, wedging both the
 * sync run and the long-poll loop behind a promise that can never resolve.
 */
export class TimeoutError extends Error {
	constructor(ms: number) {
		super(`the sync server did not respond within ${ms}ms`);
		this.name = 'TimeoutError';
	}
}

/** 507: server disk full — the client pauses uploads (§9). */
export class DiskFullError extends Error {
	constructor() {
		super('the sync server is out of storage');
		this.name = 'DiskFullError';
	}
}

function withQuery(path: string, query?: Record<string, string | number>): string {
	if (query === undefined || Object.keys(query).length === 0) {
		return path;
	}
	const search = Object.entries(query)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
		.join('&');
	return `${path}?${search}`;
}

export class ApiClient {
	readonly #requester: Requester;

	constructor(requester: Requester) {
		this.#requester = requester;
	}

	async #call<T>(request: SyncRequest): Promise<T> {
		const response = await this.#requester.request(request);
		if (response.status === 401) {
			throw new UnauthorizedError();
		}
		if (response.status === 507) {
			throw new DiskFullError();
		}
		if (response.status === 409) {
			const body = response.json() as { headVersion?: string };
			throw new ConflictError(body.headVersion);
		}
		if (response.status < 200 || response.status >= 300) {
			throw new ServerError(response.status, response.json());
		}
		return response.json() as T;
	}

	me(): Promise<MeResponse> {
		return this.#call<MeResponse>({ path: '/v1/me', method: 'GET' });
	}

	createVault(name: string): Promise<MeResponse['vaults'][number]> {
		const body: CreateVaultRequest = { name };
		return this.#call({ path: '/v1/vaults', method: 'POST', body });
	}

	changes(
		vaultId: string,
		since: number,
		waitSeconds: number,
		limit?: number,
	): Promise<ChangesResponse> {
		const query: Record<string, string | number> = { since, wait: waitSeconds };
		if (limit !== undefined) {
			query.limit = limit;
		}
		return this.#call<ChangesResponse>({
			path: withQuery(`/v1/vaults/${vaultId}/changes`, query),
			method: 'GET',
		});
	}

	checkBlobs(vaultId: string, addresses: string[]): Promise<BlobCheckResponse> {
		return this.#call<BlobCheckResponse>({
			path: `/v1/vaults/${vaultId}/blobs/check`,
			method: 'POST',
			body: { addresses },
		});
	}

	async putBlob(vaultId: string, address: string, data: Uint8Array): Promise<void> {
		const response = await this.#requester.request({
			path: `/v1/vaults/${vaultId}/blobs/${address}`,
			method: 'PUT',
			body: data,
			raw: true,
		});
		if (response.status === 401) {
			throw new UnauthorizedError();
		}
		if (response.status === 507) {
			throw new DiskFullError();
		}
		if (response.status !== 201 && response.status !== 204) {
			throw new ServerError(response.status, undefined);
		}
	}

	async getBlob(vaultId: string, address: string): Promise<Uint8Array> {
		const response = await this.#requester.request({
			path: `/v1/vaults/${vaultId}/blobs/${address}`,
			method: 'GET',
			raw: true,
		});
		if (response.status !== 200) {
			throw new ServerError(response.status, undefined);
		}
		return new Uint8Array(response.arrayBuffer);
	}

	commit(
		vaultId: string,
		fileId: string,
		body: CommitVersionRequest,
	): Promise<CommitVersionResponse> {
		return this.#call<CommitVersionResponse>({
			path: `/v1/vaults/${vaultId}/files/${fileId}`,
			method: 'POST',
			body,
		});
	}

	delete(
		vaultId: string,
		fileId: string,
		parentVersion: string | undefined,
	): Promise<{ seq: number }> {
		const query = parentVersion === undefined ? undefined : { parentVersion };
		return this.#call({
			path: withQuery(`/v1/vaults/${vaultId}/files/${fileId}`, query),
			method: 'DELETE',
		});
	}

	versions(
		vaultId: string,
		fileId: string,
		window?: { limit?: number; offset?: number },
	): Promise<VersionsResponse> {
		const query: Record<string, string | number> = {};
		if (window?.limit !== undefined) {
			query.limit = window.limit;
		}
		if (window?.offset !== undefined) {
			query.offset = window.offset;
		}
		return this.#call<VersionsResponse>({
			path: withQuery(`/v1/vaults/${vaultId}/files/${fileId}/versions`, query),
			method: 'GET',
		});
	}

	state(vaultId: string): Promise<VaultStateResponse> {
		return this.#call<VaultStateResponse>({ path: `/v1/vaults/${vaultId}/state`, method: 'GET' });
	}

	streamTicket(vaultId: string): Promise<StreamTicketResponse> {
		return this.#call<StreamTicketResponse>({
			path: `/v1/vaults/${vaultId}/stream-ticket`,
			method: 'POST',
		});
	}
}

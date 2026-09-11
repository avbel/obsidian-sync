import type { Requester, SyncRequest, SyncResponse } from '../transport/client.js';

interface StoredFile {
	fileId: string;
	headVersion: string;
	metaBlob: string;
	chunks: string[];
	size: number;
	deleted: boolean;
	updatedSeq: number;
}

interface StoredVersion {
	versionId: string;
	fileId: string;
	parentVersion: string | undefined;
	metaBlob: string;
	chunks: string[];
	size: number;
	deviceId: string;
	createdAt: number;
}

interface StoredChange {
	seq: number;
	fileId: string;
	versionId: string | undefined;
	kind: 'upsert' | 'delete';
	size: number;
	createdAt: number;
}

/**
 * A faithful in-memory model of the wire protocol, used by the engine tests to
 * exercise client crypto, optimistic concurrency, and merge end-to-end without a
 * running Fastify process. It mirrors the server's observable rules: a commit whose
 * parentVersion is not the head returns 409 with the real head, blobs are stored
 * opaquely by address, and change_log.seq is the sole cursor.
 */
export class FakeServer implements Requester {
	readonly blobs = new Map<string, Uint8Array>();
	readonly files = new Map<string, StoredFile>();
	readonly versions = new Map<string, StoredVersion>();
	readonly log: StoredChange[] = [];
	private seq = 0;
	private versionCounter = 0;
	vaultId = 'test-vault';

	/** The current head version id of a file, for asserting test preconditions. */
	headOf(fileId: string): string | undefined {
		const file = this.files.get(fileId);
		return file === undefined || file.deleted ? undefined : file.headVersion;
	}

	private nextVersionId(): string {
		this.versionCounter += 1;
		const hex = this.versionCounter.toString(16).padStart(12, '0');
		return `${hex.slice(0, 8)}-0000-4000-8000-${hex.slice(0, 12)}000000000000`.slice(0, 36);
	}

	private json(status: number, body: unknown): SyncResponse {
		return {
			status,
			arrayBuffer: new ArrayBuffer(0),
			json: () => body,
		};
	}

	async request(request: SyncRequest): Promise<SyncResponse> {
		const { path, method, body } = request;
		const url = new URL(`http://x${path}`);
		const parts = url.pathname.split('/').filter((part) => part.length > 0);

		// /v1/vaults/:id/(blobs|files|changes|state|stream-ticket)/...
		if (parts[1] !== 'vaults') {
			return this.json(404, { error: 'not_found' });
		}

		if (parts.length >= 5 && parts[3] === 'blobs' && parts[4] === 'check') {
			return this.blobCheck(body);
		}
		if (parts.length >= 5 && parts[3] === 'blobs') {
			return this.blob(method, parts[4] as string, body);
		}
		if (parts[3] === 'changes') {
			return this.changes(url.searchParams);
		}
		if (parts[3] === 'state') {
			return this.state();
		}
		if (parts[3] === 'files' && parts[4] !== undefined) {
			if (method === 'POST') {
				return this.commit(parts[4], body);
			}
			if (method === 'DELETE') {
				return this.deleteFile(parts[4], url.searchParams);
			}
		}
		return this.json(404, { error: 'not_found' });
	}

	private blob(method: string, address: string, body: unknown): SyncResponse {
		if (method === 'PUT') {
			if (this.blobs.has(address)) {
				return this.json(204, undefined);
			}
			const bytes = body instanceof Uint8Array ? body : new Uint8Array();
			this.blobs.set(address, bytes);
			return this.json(201, undefined);
		}
		const data = this.blobs.get(address);
		return data === undefined
			? this.json(404, { error: 'blob_not_found' })
			: { status: 200, arrayBuffer: data.slice().buffer, json: () => undefined };
	}

	private blobCheck(body: unknown): SyncResponse {
		const addresses = (body as { addresses: string[] }).addresses;
		return this.json(200, { missing: addresses.filter((address) => !this.blobs.has(address)) });
	}

	private changes(params: URLSearchParams): SyncResponse {
		const since = Number(params.get('since') ?? '0');
		const limit = Number(params.get('limit') ?? '500');
		const after = this.log.filter((change) => change.seq > since);
		const page = after.slice(0, limit);
		return this.json(200, {
			changes: page,
			seq: page.at(-1)?.seq ?? Math.max(since, this.seq),
			hasMore: after.length > limit,
		});
	}

	private state(): SyncResponse {
		return this.json(200, {
			files: [...this.files.values()]
				.filter((file) => !file.deleted)
				.map((file) => ({
					fileId: file.fileId,
					headVersion: file.headVersion,
					metaBlob: file.metaBlob,
					size: file.size,
					updatedSeq: file.updatedSeq,
				})),
			seq: this.seq,
		});
	}

	private commit(fileId: string, body: unknown): SyncResponse {
		const request = body as {
			parentVersion?: string;
			metaBlob: string;
			chunks: string[];
			size: number;
			deviceId: string;
		};
		const current = this.files.get(fileId);
		const headVersion = current !== undefined && !current.deleted ? current.headVersion : undefined;
		if (headVersion !== request.parentVersion) {
			return this.json(409, { error: 'conflict', headVersion });
		}

		const versionId = this.nextVersionId();
		this.versions.set(versionId, {
			versionId,
			fileId,
			parentVersion: request.parentVersion,
			metaBlob: request.metaBlob,
			chunks: request.chunks,
			size: request.size,
			deviceId: request.deviceId,
			createdAt: Date.now(),
		});
		this.seq += 1;
		this.log.push({
			seq: this.seq,
			fileId,
			versionId,
			kind: 'upsert',
			size: request.size,
			createdAt: Date.now(),
		});
		this.files.set(fileId, {
			fileId,
			headVersion: versionId,
			metaBlob: request.metaBlob,
			chunks: request.chunks,
			size: request.size,
			deleted: false,
			updatedSeq: this.seq,
		});
		return this.json(201, { versionId, seq: this.seq });
	}

	private deleteFile(fileId: string, params: URLSearchParams): SyncResponse {
		const current = this.files.get(fileId);
		if (current === undefined) {
			return this.json(409, { error: 'conflict', headVersion: undefined });
		}
		const headVersion = !current.deleted ? current.headVersion : undefined;
		if (headVersion === undefined || headVersion !== params.get('parentVersion')) {
			return this.json(409, { error: 'conflict', headVersion });
		}
		this.seq += 1;
		this.log.push({
			seq: this.seq,
			fileId,
			versionId: undefined,
			kind: 'delete',
			size: 0,
			createdAt: Date.now(),
		});
		this.files.set(fileId, { ...current, deleted: true, headVersion: '', updatedSeq: this.seq });
		return this.json(200, { seq: this.seq });
	}
}

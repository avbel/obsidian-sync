import {
	OfflineError,
	type Requester,
	type SyncRequest,
	type SyncResponse,
	TimeoutError,
} from './client.js';

/** Minimal surface matching Obsidian's requestUrl, injected so this file stays free of a direct `obsidian` import. */
export type ObsidianRequestUrl = (params: {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	throw?: boolean;
}) => Promise<{
	status: number;
	arrayBuffer: ArrayBuffer;
	json(): unknown;
	text: string;
}>;

export interface ObsidianRequesterOptions {
	serverUrl: string;
	token: string;
	requestUrl: ObsidianRequestUrl;
	/** Absolute URL fetcher escape hatch used by tests; defaults to requestUrl directly. */
	transport?: 'requestUrl';
	/** Ceiling on a single request, since requestUrl offers none (§R1). */
	timeoutMs?: number;
}

const defaultTimeoutMs = 120_000;

/**
 * Adapts Obsidian's `requestUrl` to the structural Requester the client uses.
 *
 * `requestUrl` is mandatory here rather than `fetch`: on mobile the plugin runs in
 * an https WebView and `fetch`/`ws` to a plain `http://` tailnet address is blocked
 * by mixed-content policy (§2.1). requestUrl bypasses the WebView network stack.
 */
export function createObsidianRequester(options: ObsidianRequesterOptions): Requester {
	const base = options.serverUrl.replace(/\/+$/, '');

	return {
		async request(request: SyncRequest): Promise<SyncResponse> {
			const url = `${base}${request.path}`;
			const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` };

			let body: string | ArrayBuffer | undefined;
			if (request.body !== undefined) {
				if (request.body instanceof Uint8Array) {
					headers['Content-Type'] = 'application/octet-stream';
					body = request.body.buffer.slice(
						request.body.byteOffset,
						request.body.byteOffset + request.body.byteLength,
					) as ArrayBuffer;
				} else {
					headers['Content-Type'] = 'application/json';
					body = JSON.stringify(request.body);
				}
			}

			const params: {
				url: string;
				method: string;
				headers: Record<string, string>;
				body?: string | ArrayBuffer;
				contentType?: string;
				throw?: boolean;
			} = { url, method: request.method, headers, throw: false };
			if (body !== undefined) {
				params.body = body;
			}

			const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const response = await Promise.race([
				options.requestUrl(params).catch((cause: unknown) => {
					throw new OfflineError(cause);
				}),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
				}),
			]).finally(() => {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
			});

			return {
				status: response.status,
				arrayBuffer: response.arrayBuffer,
				json(): unknown {
					try {
						return JSON.parse(response.text) as unknown;
					} catch {
						return undefined;
					}
				},
			};
		},
	};
}

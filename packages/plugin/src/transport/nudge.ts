import type { ApiClient } from './client.js';

/** A nudge source signals "new changes may exist"; it carries no file data (§2.3, §7.3). */
export interface NudgeSource {
	readonly kind: 'longpoll' | 'websocket' | 'interval';
	start(onNudge: () => void): void;
	stop(): void;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export interface LongPollOptions {
	client: ApiClient;
	vaultId: string;
	/** Seconds to hold each request; the caller caps this below the platform ceiling (§R1). */
	waitSeconds: number;
	getCursor(): number;
}

/**
 * Long-poll holds `GET /changes?wait=` open; whenever it settles (a change arrived
 * or the hold timed out) a nudge fires to prompt the engine's pull. Errors nudge
 * too, after a short pause, so a transient failure triggers a retry rather than a
 * stall — and the pull itself re-reads from the durable cursor, so a missed nudge
 * costs only latency, never correctness (§2.3).
 */
export function createLongPollSource(options: LongPollOptions): NudgeSource {
	let active = false;

	return {
		kind: 'longpoll',
		start(onNudge) {
			active = true;
			const loop = async (): Promise<void> => {
				while (active) {
					try {
						await options.client.changes(options.vaultId, options.getCursor(), options.waitSeconds);
					} catch {
						if (!active) {
							return;
						}
						await delay(2000);
					}
					if (!active) {
						return;
					}
					onNudge();
				}
			};
			const start = async (): Promise<void> => {
				await loop();
			};
			start().catch(() => {
				active = false;
			});
		},
		stop() {
			active = false;
		},
	};
}

export interface IntervalOptions {
	intervalMs: number;
}

/** Interval polling is the always-available fallback (§9), needing no live channel. */
export function createIntervalSource(options: IntervalOptions): NudgeSource {
	let timer: ReturnType<typeof setInterval> | undefined;

	return {
		kind: 'interval',
		start(onNudge) {
			timer = setInterval(onNudge, options.intervalMs);
			timer.unref?.();
		},
		stop() {
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		},
	};
}

/** A WebSocket surface narrowed to what the nudge channel uses, so tests need no real socket. */
export interface WebSocketLike {
	send(data: string): void;
	close(): void;
	addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
	addEventListener(type: 'close' | 'error', listener: () => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebSocketOptions {
	serverUrl: string;
	vaultId: string;
	getTicket(): Promise<string>;
	factory: WebSocketFactory;
	onUnavailable(): void;
}

/**
 * The wss:// push channel. It carries only `{seq}` nudges; on any failure it stops
 * and hands back to long-poll via `onUnavailable` (§7.3). Available only over https
 * in a mobile WebView (§2.1) — selection lives in `selectNudgeSource`.
 */
export function createWebSocketSource(options: WebSocketOptions): NudgeSource {
	let socket: WebSocketLike | undefined;
	let active = false;

	return {
		kind: 'websocket',
		start(onNudge) {
			active = true;
			const open = async (): Promise<void> => {
				const ticket = await options.getTicket();
				if (!active) {
					return;
				}
				const base = options.serverUrl.replace(/\/+$/, '');
				const wsBase = base.replace(/^http/, 'ws');
				socket = options.factory(
					`${wsBase}/v1/vaults/${options.vaultId}/stream?ticket=${encodeURIComponent(ticket)}`,
				);
				socket.addEventListener('message', () => {
					onNudge();
				});
				socket.addEventListener('close', () => {
					if (active) {
						options.onUnavailable();
					}
				});
				socket.addEventListener('error', () => {
					if (active) {
						options.onUnavailable();
					}
				});
			};
			open().catch(() => {
				options.onUnavailable();
			});
		},
		stop() {
			active = false;
			socket?.close();
			socket = undefined;
		},
	};
}

export type TransportPreference = 'automatic' | 'longpoll' | 'websocket' | 'interval';

export interface NudgeSelection {
	serverUrl: string;
	preference: TransportPreference;
	longPoll: () => NudgeSource;
	websocket: () => NudgeSource | undefined;
	interval: () => NudgeSource;
}

/**
 * Automatic selection (§7.3): https allows WebSocket (with long-poll failover
 * handled inside the socket source), http forces long-poll because the mobile
 * WebView blocks ws:// to a tailnet address, and interval is the explicit override.
 */
export function selectNudgeSource(selection: NudgeSelection): NudgeSource {
	switch (selection.preference) {
		case 'interval':
			return selection.interval();
		case 'longpoll':
			return selection.longPoll();
		case 'websocket':
			return selection.websocket() ?? selection.longPoll();
		case 'automatic': {
			if (selection.serverUrl.startsWith('https://')) {
				return selection.websocket() ?? selection.longPoll();
			}
			return selection.longPoll();
		}
	}
}

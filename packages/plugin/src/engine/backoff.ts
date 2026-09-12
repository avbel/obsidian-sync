import {
	DiskFullError,
	ServerError,
	TimeoutError,
	UnauthorizedError,
} from '../transport/client.js';

export type FailureKind = 'halt' | 'pause' | 'retry-all' | 'retry-item';

const baseRetryDelayMs = 5_000;
export const maxRetryDelayMs = 300_000;
export const consecutiveFailureLimit = 3;

export function retryDelayMs(attempts: number): number {
	if (attempts <= 0) {
		return 0;
	}
	return Math.min(baseRetryDelayMs * 2 ** Math.min(attempts - 1, 16), maxRetryDelayMs);
}

export function classifyFailure(error: unknown): FailureKind {
	if (error instanceof UnauthorizedError) {
		return 'halt';
	}
	if (error instanceof DiskFullError) {
		return 'pause';
	}
	if (error instanceof TimeoutError) {
		return 'retry-all';
	}
	if (error instanceof ServerError) {
		return error.status >= 500 ? 'retry-all' : 'retry-item';
	}
	return 'retry-item';
}

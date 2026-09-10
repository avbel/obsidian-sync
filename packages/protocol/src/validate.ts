import { blobAddressPattern, versionIdPattern } from './constants.js';
import type { BlobCheckRequest, CommitVersionRequest, CreateVaultRequest } from './wire.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isAddressList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === 'string' && blobAddressPattern.test(entry))
	);
}

export function isCommitVersionRequest(body: unknown): body is CommitVersionRequest {
	const record = asRecord(body);
	if (record === undefined) {
		return false;
	}

	const { parentVersion, metaBlob, chunks, size, deviceId } = record;

	if (parentVersion !== undefined) {
		if (typeof parentVersion !== 'string' || !versionIdPattern.test(parentVersion)) {
			return false;
		}
	}

	return (
		isNonEmptyString(metaBlob) &&
		isAddressList(chunks) &&
		typeof size === 'number' &&
		Number.isInteger(size) &&
		size >= 0 &&
		isNonEmptyString(deviceId)
	);
}

export function isBlobCheckRequest(body: unknown): body is BlobCheckRequest {
	const record = asRecord(body);
	if (record === undefined) {
		return false;
	}
	return isAddressList(record.addresses);
}

export function isCreateVaultRequest(body: unknown): body is CreateVaultRequest {
	const record = asRecord(body);
	if (record === undefined) {
		return false;
	}
	return isNonEmptyString(record.name) && record.name.length <= 64;
}

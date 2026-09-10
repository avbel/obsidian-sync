export const protocolVersion = 1;

export const defaultChunkBytes = 4 * 1024 * 1024;
export const maxChunkBytes = 16 * 1024 * 1024;

export const nonceBytes = 12;
export const tagBytes = 16;
export const keyBytes = 32;

export const pbkdf2Iterations = 650_000;
export const kdfSaltBytes = 16;

/** Hex-encoded HMAC-SHA-256 output. */
export const blobAddressPattern = /^[0-9a-f]{64}$/;
/** Hex-encoded HMAC-SHA-256 output. */
export const fileIdPattern = /^[0-9a-f]{64}$/;
/** UUID v4, as produced by randomUUID(). */
export const versionIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

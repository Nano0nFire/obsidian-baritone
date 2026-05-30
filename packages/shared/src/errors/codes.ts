/**
 * Canonical protocol error codes. Returned in `error` and `reject` messages and
 * thrown server-side as `SyncError`. Stable wire identifiers — do not rename.
 */
export enum ErrorCode {
  // --- protocol / versioning ---
  UPGRADE_REQUIRED = 'UPGRADE_REQUIRED',
  BAD_REQUEST = 'BAD_REQUEST',
  UNSUPPORTED = 'UNSUPPORTED',

  // --- auth / authz ---
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  FORBIDDEN = 'FORBIDDEN',
  DEVICE_REVOKED = 'DEVICE_REVOKED',

  // --- op processing ---
  SEQ_GAP = 'SEQ_GAP',
  STALE = 'STALE',
  ILLEGAL_PATH = 'ILLEGAL_PATH',
  BLOB_MISSING = 'BLOB_MISSING',
  BLOB_HASH_MISMATCH = 'BLOB_HASH_MISMATCH',
  FILE_ACTIVE = 'FILE_ACTIVE',
  CONFLICT_PENDING = 'CONFLICT_PENDING',
  NOT_FOUND = 'NOT_FOUND',

  // --- layer 2 (yjs realtime rooms) ---
  ROOM_NOT_FOUND = 'ROOM_NOT_FOUND',
  ROOM_EPOCH_STALE = 'ROOM_EPOCH_STALE',
  NOT_PARTICIPANT = 'NOT_PARTICIPANT',

  // --- quota / limits ---
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  RATE_LIMITED = 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',

  // --- conflict resolution ---
  CONFLICT_NOT_CLAIMED = 'CONFLICT_NOT_CLAIMED',
  CONFLICT_ALREADY_RESOLVED = 'CONFLICT_ALREADY_RESOLVED',

  // --- internal ---
  INTERNAL = 'INTERNAL',
}

export interface SyncErrorDetails {
  [key: string]: unknown;
}

/** Structured error carrying a stable {@link ErrorCode} and optional details. */
export class SyncError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: SyncErrorDetails,
  ) {
    super(message ?? code);
    this.name = 'SyncError';
  }

  toWire(): { code: ErrorCode; message: string; details?: SyncErrorDetails } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

/** True for errors the client should retry after fetching missing ops. */
export function isRecoverable(code: ErrorCode): boolean {
  return code === ErrorCode.SEQ_GAP || code === ErrorCode.STALE || code === ErrorCode.RATE_LIMITED || code === ErrorCode.ROOM_EPOCH_STALE;
}

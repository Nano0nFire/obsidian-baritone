import type { VersionVector } from '../clock/version-vector.js';
import type { PathClock } from '../clock/lamport.js';

/** Current wire protocol version. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1;
/** Oldest client protocol version this build still accepts. */
export const MIN_CLIENT_PROTOCOL = 1;

export type FileType = 'note' | 'attachment' | 'config';

export type OpKind = 'create' | 'update' | 'rename' | 'delete' | 'restore';

/**
 * A file-level operation (Layer 1). Carries idempotency + ordering metadata and
 * field-specific payloads (content / rename / delete) per spec §S1, §1.
 */
export interface FileOp {
  /** Idempotency key (client-generated UUID). */
  opId: string;
  deviceId: string;
  /** Per-device strictly-increasing sequence (no gaps). */
  deviceSeq: number;
  fileId: string;
  vaultId: string;
  kind: OpKind;
  type: FileType;

  // --- content ops (create/update/restore) ---
  /** Version vector the editing client had observed (the "base"). */
  baseContentVV?: VersionVector;
  /** Version vector after applying this op (base + this device bumped). */
  newContentVV?: VersionVector;
  contentHash?: string;
  size?: number;
  /** Inline UTF-8 text for small notes; omitted when stored as a blob. */
  inlineText?: string;
  /** Blob reference (content hash) for attachments / large content. */
  blobRef?: string;

  // --- rename ops ---
  newPath?: string;
  pathClock?: PathClock;

  // --- delete ops ---
  deleteClock?: PathClock;

  /** Protocol schema version of this op's payload. */
  schemaVersion?: number;
}

/** Server-applied result clocks returned in op_ack. */
export interface ResultingClocks {
  contentVV?: VersionVector;
  pathClock?: PathClock;
  deleteVV?: VersionVector;
  epoch: number;
}

/** A manifest row describing the canonical state of one file. */
export interface ManifestEntry {
  fileId: string;
  type: FileType;
  path: string;
  contentHash: string | null;
  size: number | null;
  blobRef: string | null;
  contentVV: VersionVector;
  pathClock: PathClock;
  epoch: number;
  deleted: boolean;
}

export type ConflictKind = 'content' | 'delete' | 'attachment' | 'rename';
export type ConflictStatus = 'open' | 'claimed' | 'resolved';

export interface ConflictRecord {
  conflictId: string;
  vaultId: string;
  fileId: string;
  kind: ConflictKind;
  baseHash: string | null;
  oursHash: string | null;
  theirsHash: string | null;
  oursVV: VersionVector | null;
  theirsVV: VersionVector | null;
  status: ConflictStatus;
  claimedBy?: string;
}

// ===========================================================================
// Wire messages
// ===========================================================================

export interface HelloMessage {
  t: 'hello';
  token: string;
  deviceId: string;
  vaultId: string;
  lastSeq: number;
  protocolVersion: number;
  clientBuild: string;
  capabilities: string[];
}

export interface FileOpMessage {
  t: 'file_op';
  op: FileOp;
}

export interface GetOpsMessage {
  t: 'get_ops';
  sinceSeq: number;
}

export interface PromoteMessage { t: 'promote'; fileId: string }
export interface DemoteMessage { t: 'demote'; fileId: string }

export interface BlobUploadInitMessage {
  t: 'blob_upload_init';
  fileId?: string;
  hash: string;
  size: number;
}

export interface BlobUploadCompleteMessage {
  t: 'blob_upload_complete';
  hash: string;
}

export interface ClaimConflictMessage { t: 'claim_conflict'; conflictId: string }
export interface ResolveConflictMessage {
  t: 'resolve_conflict';
  conflictId: string;
  resolvedHash?: string;
  inlineText?: string;
  resolvedVV: VersionVector;
}
export interface ReleaseConflictMessage { t: 'release_conflict'; conflictId: string }
export interface ListTrashMessage { t: 'list_trash'; vaultId: string }
export interface RestoreMessage { t: 'restore'; fileId: string }
export interface GetManifestMessage { t: 'get_manifest'; vaultId: string; cursor?: string }
export interface GetContentMessage { t: 'get_content'; hash: string }

export type ClientMessage =
  | HelloMessage
  | FileOpMessage
  | GetOpsMessage
  | PromoteMessage
  | DemoteMessage
  | BlobUploadInitMessage
  | BlobUploadCompleteMessage
  | ClaimConflictMessage
  | ResolveConflictMessage
  | ReleaseConflictMessage
  | ListTrashMessage
  | RestoreMessage
  | GetManifestMessage
  | GetContentMessage;

export interface WelcomeMessage {
  t: 'welcome';
  serverTime: number;
  currentSeq: number;
  serverProtocol: number;
  minClientProtocol: number;
  capabilities: string[];
}

export interface OpsMessage {
  t: 'ops';
  ops: AppliedOp[];
  /** True if more ops remain beyond this batch (continue with get_ops). */
  more: boolean;
}

/** A committed op as broadcast to clients, carrying its assigned vaultSeq. */
export interface AppliedOp {
  vaultSeq: number;
  op: FileOp;
  resultingClocks: ResultingClocks;
}

export interface OpAckMessage {
  t: 'op_ack';
  opId: string;
  vaultSeq: number;
  resultingClocks: ResultingClocks;
  conflictId?: string;
}

export interface BlobUploadUrlMessage {
  t: 'blob_upload_url';
  hash: string;
  /** Presigned PUT URL; null if the blob already exists (skip upload). */
  url: string | null;
  alreadyExists: boolean;
}

export interface ConflictMessage {
  t: 'conflict';
  conflict: ConflictRecord;
}

export interface ConflictStateMessage {
  t: 'conflict_state';
  conflictId: string;
  status: ConflictStatus;
  claimedBy?: string;
  resolvedBy?: string;
}

export interface RoomStateMessage {
  t: 'room_state';
  fileId: string;
  /** base64 Yjs snapshot. */
  yjsSnapshot: string;
  /** base64 Yjs state vector. */
  stateVector: string;
}

export interface ManifestPageMessage {
  t: 'manifest_page';
  watermarkSeq: number;
  items: ManifestEntry[];
  nextCursor: string | null;
}

export interface ContentMessage {
  t: 'content';
  hash: string;
  /** base64-encoded content bytes; null if not found (likely GC'd). */
  data: string | null;
}

export interface TrashListMessage {
  t: 'trash_list';
  items: Array<{ fileId: string; path: string; deletedAt: number; size: number | null }>;
}

export interface ErrorMessage {
  t: 'error';
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RejectMessage {
  t: 'reject';
  /** opId this rejection refers to, if applicable. */
  opId?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ServerMessage =
  | WelcomeMessage
  | OpsMessage
  | OpAckMessage
  | BlobUploadUrlMessage
  | ConflictMessage
  | ConflictStateMessage
  | RoomStateMessage
  | ManifestPageMessage
  | ContentMessage
  | TrashListMessage
  | ErrorMessage
  | RejectMessage;

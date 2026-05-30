import { z } from 'zod';

const vv = z.record(z.string().min(1), z.number().int().nonnegative());
const pathClock = z.object({ lamport: z.number().int().nonnegative(), deviceId: z.string().min(1) });
const fileType = z.enum(['note', 'attachment', 'config']);
const opKind = z.enum(['create', 'update', 'rename', 'delete', 'restore']);
const contentEncoding = z.object({ algorithm: z.literal('aes-256-gcm-pbkdf2-sha256-convergent-v1'), version: z.literal(1) });

export const fileOpSchema = z.object({
  opId: z.string().uuid(),
  deviceId: z.string().min(1),
  deviceSeq: z.number().int().positive(),
  fileId: z.string().min(1),
  vaultId: z.string().min(1),
  kind: opKind,
  type: fileType,
  baseContentVV: vv.optional(),
  newContentVV: vv.optional(),
  contentHash: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  contentEncoding: contentEncoding.optional(),
  inlineText: z.string().optional(),
  blobRef: z.string().optional(),
  newPath: z.string().optional(),
  pathClock: pathClock.optional(),
  deleteClock: pathClock.optional(),
  schemaVersion: z.number().int().positive().optional(),
});

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string().min(1), deviceId: z.string().min(1), vaultId: z.string().min(1), lastSeq: z.number().int().nonnegative(), protocolVersion: z.number().int().positive(), clientBuild: z.string().min(1), capabilities: z.array(z.string()) }),
  z.object({ t: z.literal('file_op'), op: fileOpSchema }),
  z.object({ t: z.literal('get_ops'), sinceSeq: z.number().int().nonnegative() }),
  z.object({ t: z.literal('promote'), fileId: z.string().min(1) }),
  z.object({ t: z.literal('demote'), fileId: z.string().min(1) }),
  z.object({ t: z.literal('yjs_update'), fileId: z.string().min(1), roomEpoch: z.number().int().nonnegative(), updateId: z.number().int().nonnegative(), update: z.string().max(2_000_000) }),
  z.object({ t: z.literal('yjs_awareness'), fileId: z.string().min(1), roomEpoch: z.number().int().nonnegative(), state: z.string().max(200_000) }),
  z.object({ t: z.literal('yjs_sync'), fileId: z.string().min(1), roomEpoch: z.number().int().nonnegative(), stateVector: z.string().max(200_000) }),
  z.object({ t: z.literal('yjs_heartbeat'), fileId: z.string().min(1), roomEpoch: z.number().int().nonnegative() }),
  z.object({ t: z.literal('leave_room'), fileId: z.string().min(1), roomEpoch: z.number().int().nonnegative() }),
  z.object({ t: z.literal('history_list'), requestId: z.string().uuid(), fileId: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), before: z.string().uuid().optional() }),
  z.object({ t: z.literal('history_get'), requestId: z.string().uuid(), fileId: z.string().min(1), versionId: z.string().uuid() }),
  z.object({ t: z.literal('history_restore'), requestId: z.string().uuid(), fileId: z.string().min(1), versionId: z.string().uuid() }),
  z.object({ t: z.literal('blob_upload_init'), fileId: z.string().optional(), hash: z.string().min(1), size: z.number().int().nonnegative() }),
  z.object({ t: z.literal('blob_upload_complete'), hash: z.string().min(1) }),
  z.object({ t: z.literal('claim_conflict'), conflictId: z.string().min(1) }),
  z.object({ t: z.literal('resolve_conflict'), conflictId: z.string().min(1), resolvedHash: z.string().optional(), inlineText: z.string().optional(), resolvedVV: vv }),
  z.object({ t: z.literal('release_conflict'), conflictId: z.string().min(1) }),
  z.object({ t: z.literal('list_trash'), vaultId: z.string().min(1) }),
  z.object({ t: z.literal('restore'), fileId: z.string().min(1) }),
  z.object({ t: z.literal('get_manifest'), vaultId: z.string().min(1), cursor: z.string().optional() }),
  z.object({ t: z.literal('get_content'), hash: z.string().min(1) }),
]);

export type ValidatedClientMessage = z.infer<typeof clientMessageSchema>;

import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { ErrorCode, MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION, SyncError, type AppliedOp, type ServerMessage } from '@obsidian-sync/shared';
import type { BlobStore } from '../blob/store.js';
import { TokenService, type AccessClaims } from '../auth/tokens.js';
import { OpProcessor } from '../engine/op-processor.js';
import { ConflictService } from '../engine/conflict.js';
import { ManifestService } from '../engine/manifest.js';
import { TrashService } from '../engine/trash.js';
import { YjsLayerService } from '../engine/yjs.js';
import type { OpDataStore } from '../engine/store.js';
import { clientMessageSchema, type ValidatedClientMessage } from './validation.js';

interface ConnectionState { claims?: AccessClaims; vaultId?: string; deviceId?: string }

export class SyncWebSocketServer {
  readonly wss: WebSocketServer;
  private readonly clients = new Set<{ socket: WebSocket; state: ConnectionState }>();
  constructor(
    server: http.Server,
    private readonly store: OpDataStore,
    private readonly tokens: TokenService,
    private readonly opProcessor: OpProcessor,
    private readonly conflicts: ConflictService,
    private readonly manifest: ManifestService,
    private readonly trash: TrashService,
    private readonly blobs: BlobStore,
    private readonly yjs: YjsLayerService,
  ) {
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private handleConnection(socket: WebSocket): void {
    const state: ConnectionState = {};
    const client = { socket, state };
    this.clients.add(client);
    socket.on('close', () => this.clients.delete(client));
    socket.on('message', (raw) => {
      void this.handleMessage(socket, state, raw.toString()).catch((error) => send(socket, errorToWire(error)));
    });
  }

  private async handleMessage(socket: WebSocket, state: ConnectionState, raw: string): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid JSON'); }
    const msg = clientMessageSchema.parse(parsed) as ValidatedClientMessage;
    if (msg.t !== 'hello' && !state.claims) throw new SyncError(ErrorCode.UNAUTHENTICATED, 'hello required first');
    switch (msg.t) {
      case 'hello': await this.hello(socket, state, msg); break;
      case 'file_op': {
        if (msg.op.deviceId !== state.deviceId || msg.op.vaultId !== state.vaultId) throw new SyncError(ErrorCode.UNAUTHENTICATED, 'Operation device/vault must match the authenticated connection');
        const result = await this.opProcessor.process(msg.op, state.claims!.userId);
        send(socket, result.type === 'ack' ? { t: 'op_ack', opId: result.opId, vaultSeq: result.vaultSeq, resultingClocks: result.resultingClocks, conflictId: result.conflictId } : { t: 'reject', opId: result.opId, code: result.code, message: result.message, details: result.details });
        if (result.type === 'ack') this.broadcastOps(state.vaultId!, socket, [{ vaultSeq: result.vaultSeq, op: msg.op, resultingClocks: result.resultingClocks }]);
        break;
      }
      case 'get_ops': {
        const ops = await this.store.listOps(state.vaultId!, msg.sinceSeq, 1000);
        send(socket, { t: 'ops', ops, more: ops.length === 1000 });
        break;
      }
      case 'blob_upload_init': send(socket, { t: 'blob_upload_url', ...(await this.blobs.initUpload(msg.hash, msg.size)) }); break;
      case 'blob_upload_complete': await this.blobs.completeUpload(msg.hash); send(socket, { t: 'blob_upload_url', hash: msg.hash, url: null, alreadyExists: true }); break;
      case 'claim_conflict': send(socket, { t: 'conflict_state', conflictId: msg.conflictId, status: (await this.conflicts.claim(msg.conflictId, state.deviceId!)).status, claimedBy: state.deviceId }); break;
      case 'release_conflict': send(socket, { t: 'conflict_state', conflictId: msg.conflictId, status: (await this.conflicts.release(msg.conflictId, state.deviceId!)).status }); break;
      case 'resolve_conflict': send(socket, { t: 'conflict', conflict: await this.conflicts.resolve({ conflictId: msg.conflictId, deviceId: state.deviceId!, resolvedHash: msg.resolvedHash, inlineText: msg.inlineText, resolvedVV: msg.resolvedVV }) }); break;
      case 'get_manifest': send(socket, await this.manifest.page(msg.vaultId, msg.cursor)); break;
      case 'get_content': {
        const bytes = await this.manifest.getContent(msg.hash);
        send(socket, { t: 'content', hash: msg.hash, data: bytes ? Buffer.from(bytes).toString('base64') : null });
        break;
      }
      case 'list_trash': send(socket, { t: 'trash_list', items: await this.trash.list(msg.vaultId) }); break;
      case 'promote': {
        const room = await this.yjs.promote(state.vaultId!, msg.fileId, state.deviceId!, state.claims!.userId);
        send(socket, { t: 'room_state', fileId: msg.fileId, yjsSnapshot: Buffer.from(room.snapshot ?? new Uint8Array()).toString('base64'), stateVector: Buffer.from(room.stateVector ?? new Uint8Array()).toString('base64') });
        break;
      }
      case 'demote': await this.yjs.demote(state.vaultId!, msg.fileId, state.deviceId!, state.claims!.userId); send(socket, { t: 'room_state', fileId: msg.fileId, yjsSnapshot: '', stateVector: '' }); break;
      case 'restore': throw new SyncError(ErrorCode.UNSUPPORTED, 'Use file_op restore so device_seq/idempotency are preserved');
    }
  }

  private broadcastOps(vaultId: string, source: WebSocket, ops: AppliedOp[]): void {
    for (const client of this.clients) {
      if (client.socket !== source && client.state.vaultId === vaultId) send(client.socket, { t: 'ops', ops, more: false });
    }
  }

  private async hello(socket: WebSocket, state: ConnectionState, msg: Extract<ValidatedClientMessage, { t: 'hello' }>): Promise<void> {
    if (msg.protocolVersion < MIN_CLIENT_PROTOCOL) throw new SyncError(ErrorCode.UPGRADE_REQUIRED, 'Client protocol is too old', { minClientProtocol: MIN_CLIENT_PROTOCOL });
    const claims = await this.tokens.verifyAccess(msg.token);
    if (claims.deviceId !== msg.deviceId || claims.vaultId !== msg.vaultId) throw new SyncError(ErrorCode.UNAUTHENTICATED, 'Token/device/vault mismatch');
    state.claims = claims; state.deviceId = msg.deviceId; state.vaultId = msg.vaultId;
    send(socket, { t: 'welcome', serverTime: Date.now(), currentSeq: await this.store.currentSeq(msg.vaultId), serverProtocol: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL, capabilities: ['layer1', 'blob-presign', 'manifest-v1', 'conflict-v1', 'yjs-lease-v1'] });
    const ops = await this.store.listOps(msg.vaultId, msg.lastSeq, 1000);
    if (ops.length) send(socket, { t: 'ops', ops, more: ops.length === 1000 });
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1_000_000) return;
  socket.send(JSON.stringify(message));
}

function errorToWire(error: unknown): ServerMessage {
  if (error instanceof SyncError) return { t: 'error', ...error.toWire() };
  if (typeof error === 'object' && error && 'issues' in error) return { t: 'error', code: ErrorCode.BAD_REQUEST, message: 'Validation failed', details: { issues: (error as { issues: unknown }).issues } };
  return { t: 'error', code: ErrorCode.INTERNAL, message: error instanceof Error ? error.message : 'Internal error' };
}

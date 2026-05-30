import {
  CONTENT_ENCRYPTION_ENCODING,
  ENCRYPTED_BLOB_ALGORITHM,
  ErrorCode,
  PROTOCOL_VERSION,
  bump,
  contentHash,
  contentHashText,
  decryptVaultBytes,
  encryptVaultBytes,
  isEncryptedBlobEnvelope,
  join,
  serializeEncryptedBlob,
  makePathClock,
  nextLamport,
  type AppliedOp,
  type ConflictRecord,
  type FileOp,
  type FileType,
  type ContentMessage,
  type OpAckMessage,
  type PathClock,
  type RejectMessage,
  type ServerMessage,
  type VaultContentKey,
  type VersionVector,
} from "@obsidian-sync/shared";
import { BlobUploader } from "../blob/uploader.js";
import type { PluginSettings } from "../settings.js";
import type { LocalIndexStore } from "../localindex/index.js";
import { OutboxManager, type FileOpDraft } from "./outbox.js";
import type { SyncTransport, TransportState } from "./transport.js";
import type { VaultIO } from "./vault-io.js";
import type { YjsSessionManager } from "./yjs-session.js";
import { isTextPath } from "../pathing.js";
import { shouldApplyConfigPath } from "../configsync/configsync.js";

export type EngineState = "idle" | "paused" | "connecting" | "syncing" | "error";

function decodeBase64(data: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(data, "base64"));
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface EngineHooks {
  onState?(state: EngineState, detail?: string): void;
  onConflict?(conflict: ConflictRecord): void;
  onError?(error: Error): void;
}

export class SyncEngine {
  private outbox: OutboxManager;
  private readonly blobUploader: BlobUploader;
  private lamport = 0;
  private state: EngineState = "idle";
  private unsubscribe: Array<() => void> = [];

  constructor(
    private readonly settings: PluginSettings,
    private readonly index: LocalIndexStore,
    private readonly vault: VaultIO,
    private readonly transport: SyncTransport,
    private readonly hooks: EngineHooks = {},
    private readonly yjs?: YjsSessionManager,
    private readonly contentKeyProvider: () => VaultContentKey | null = () => null,
  ) {
    this.outbox = new OutboxManager(settings.deviceId, index.device.nextDeviceSeq, index.device.outbox);
    this.blobUploader = new BlobUploader(transport);
  }

  start(): void {
    this.unsubscribe.push(this.transport.onMessage((message) => this.handleMessage(message)));
    this.unsubscribe.push(this.transport.onState((state) => this.handleTransportState(state)));
    if (this.settings.paused) {
      this.setState("paused");
      return;
    }
    this.transport.connect();
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    this.transport.close();
    await this.persistOutbox();
    this.setState("idle");
  }

  pause(): void {
    this.settings.paused = true;
    this.transport.close();
    this.setState("paused");
  }

  resume(): void {
    this.settings.paused = false;
    this.transport.connect();
  }

  async enqueueLocalChange(draft: FileOpDraft): Promise<FileOp> {
    const op = this.outbox.enqueue(draft);
    await this.persistOutbox();
    this.flushOutbox();
    return op;
  }

  async makeContentOp(fileId: string, path: string, type: FileType, textOrBytes?: string | Uint8Array): Promise<FileOpDraft> {
    const entry = this.index.byFileId(fileId);
    const base = entry?.appliedContentVV ?? {};
    const next = bump(base, this.settings.deviceId);
    let contentHashValue: string;
    let size: number;
    let inlineText: string | undefined;
    let blobRef: string | undefined;
    let contentEncoding: FileOpDraft["contentEncoding"];
    if (this.isEncryptionEnabled()) {
      const plaintext = await this.readPlaintextBytes(path, textOrBytes);
      const encrypted = await this.encryptForStorage(plaintext);
      contentHashValue = await this.blobUploader.upload(fileId, encrypted);
      size = encrypted.byteLength;
      blobRef = contentHashValue;
      contentEncoding = CONTENT_ENCRYPTION_ENCODING;
    } else if (typeof textOrBytes === "string" || (textOrBytes === undefined && isTextPath(path))) {
      const text = typeof textOrBytes === "string" ? textOrBytes : await this.vault.readText(path);
      contentHashValue = await contentHashText(text);
      size = new TextEncoder().encode(text).byteLength;
      inlineText = text;
    } else {
      const bytes = textOrBytes instanceof Uint8Array ? textOrBytes : await this.vault.readBytes(path);
      contentHashValue = await this.blobUploader.upload(fileId, bytes);
      size = bytes.byteLength;
      blobRef = contentHashValue;
    }
    return { vaultId: this.settings.vaultId, fileId, kind: entry ? "update" : "create", type, baseContentVV: base, newContentVV: next, contentHash: contentHashValue, size, contentEncoding, inlineText, blobRef };
  }

  async hashPath(path: string): Promise<string> {
    if (!this.isEncryptionEnabled()) {
      if (isTextPath(path)) return contentHashText(await this.vault.readText(path));
      return contentHash(await this.vault.readBytes(path));
    }
    return contentHash(await this.encryptForStorage(await this.readPlaintextBytes(path)));
  }

  makeRenameOp(fileId: string, newPath: string, type: FileType): FileOpDraft {
    this.lamport = nextLamport(this.lamport);
    return { vaultId: this.settings.vaultId, fileId, kind: "rename", type, newPath, pathClock: makePathClock(this.lamport, this.settings.deviceId) };
  }

  makeDeleteOp(fileId: string, type: FileType): FileOpDraft {
    this.lamport = nextLamport(this.lamport);
    return { vaultId: this.settings.vaultId, fileId, kind: "delete", type, deleteClock: makePathClock(this.lamport, this.settings.deviceId) };
  }

  promote(fileId: string): void {
    if (this.isEncryptionEnabled()) {
      this.hooks.onError?.(new Error("Realtime collaboration is disabled while vault content encryption is enabled"));
      return;
    }
    this.transport.send({ t: "promote", fileId });
  }
  demote(fileId: string): void { this.transport.send({ t: "demote", fileId }); }
  requestResync(): void { this.transport.send({ t: "get_ops", sinceSeq: this.index.device.appliedSeq }); }
  isRealtimeActiveFile(fileId: string): boolean { return this.yjs?.hasSession(fileId) ?? false; }
  isRealtimeActivePath(path: string): boolean {
    const entry = this.index.byPath(path);
    return entry ? this.isRealtimeActiveFile(entry.fileId) : false;
  }

  private handleTransportState(state: TransportState): void {
    if (this.settings.paused) return;
    if (state === "open") {
      this.setState("syncing");
      this.transport.send({
        t: "hello",
        token: this.settings.accessToken,
        deviceId: this.settings.deviceId,
        vaultId: this.settings.vaultId,
        lastSeq: this.index.device.appliedSeq,
        protocolVersion: PROTOCOL_VERSION,
        clientBuild: "0.1.0",
        capabilities: ["layer1", "manual-conflicts", "promote-demote"],
      });
      this.flushOutbox();
      this.yjs?.handleTransportOpen();
    } else if (state === "connecting") this.setState("connecting");
  }

  private async handleMessage(message: ServerMessage): Promise<void> {
    try {
      if (await this.yjs?.handleMessage(message)) return;
      switch (message.t) {
        case "welcome":
          if (message.currentSeq > this.index.device.appliedSeq) this.transport.send({ t: "get_ops", sinceSeq: this.index.device.appliedSeq });
          this.flushOutbox();
          break;
        case "ops":
          await this.applyOps(message.ops);
          if (message.more) this.transport.send({ t: "get_ops", sinceSeq: this.index.device.appliedSeq });
          break;
        case "op_ack":
          await this.handleAck(message);
          break;
        case "reject":
          await this.handleReject(message);
          break;
        case "conflict":
          this.index.addConflict(message.conflict.conflictId);
          await this.index.save();
          this.hooks.onConflict?.(message.conflict);
          break;
        case "conflict_state":
          if (message.status === "resolved") {
            this.index.removeConflict(message.conflictId);
            await this.index.save();
          }
          break;
        case "error":
          if (message.code === ErrorCode.ROOM_EPOCH_STALE) {
            const fileId = typeof message.details?.fileId === "string" ? message.details.fileId : undefined;
            if (fileId && this.isRealtimeActiveFile(fileId)) {
              void this.yjs?.resyncFile(fileId).catch((error: unknown) => this.hooks.onError?.(error instanceof Error ? error : new Error(String(error))));
              break;
            }
          }
          throw new Error(`${message.code}: ${message.message}`);
      }
    } catch (error) {
      this.setState("error", error instanceof Error ? error.message : String(error));
      this.hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleAck(message: OpAckMessage): Promise<void> {
    if (message.conflictId) this.outbox.conflict(message.opId, message.conflictId);
    else this.outbox.ack(message.opId, message.vaultSeq);
    this.index.setAppliedSeq(message.vaultSeq);
    await this.persistOutbox();
  }

  private async handleReject(message: RejectMessage): Promise<void> {
    if (!message.opId) return;
    if (message.code === ErrorCode.SEQ_GAP || message.code === ErrorCode.STALE) {
      this.outbox.reject(message.opId, message.message, false);
      this.transport.send({ t: "get_ops", sinceSeq: this.index.device.appliedSeq });
    } else if (message.code === ErrorCode.FILE_ACTIVE) {
      const entry = this.outbox.entries.find((item) => item.op.opId === message.opId);
      if (entry) this.promote(entry.op.fileId);
      this.outbox.reject(message.opId, message.message, false);
    } else {
      this.outbox.reject(message.opId, message.message, true);
    }
    await this.persistOutbox();
  }

  private flushOutbox(): void {
    if (this.transport.readyState !== "open" || this.settings.paused) return;
    for (const entry of this.outbox.retryable()) {
      this.outbox.markInflight(entry.op.opId);
      this.transport.send({ t: "file_op", op: entry.op });
    }
    void this.persistOutbox();
  }

  private async applyOps(ops: readonly AppliedOp[]): Promise<void> {
    const sorted = [...ops].sort((a, b) => a.vaultSeq - b.vaultSeq);
    for (const item of sorted) {
      if (item.vaultSeq <= this.index.device.appliedSeq) continue;
      if (item.vaultSeq !== this.index.device.appliedSeq + 1) {
        this.transport.send({ t: "get_ops", sinceSeq: this.index.device.appliedSeq });
        return;
      }
      await this.applyOp(item.op, item.resultingClocks.contentVV, item.resultingClocks.pathClock);
      this.index.setAppliedSeq(item.vaultSeq);
    }
    await this.index.save();
  }

  private async applyOp(op: FileOp, contentVV?: VersionVector, pathClock?: PathClock): Promise<void> {
    const entry = this.index.byFileId(op.fileId);
    if (op.pathClock) this.lamport = Math.max(this.lamport, op.pathClock.lamport);
    if (op.deleteClock) this.lamport = Math.max(this.lamport, op.deleteClock.lamport);
    if (op.kind === "delete") {
      if (entry && this.vault.exists(entry.path)) await this.vault.trash(entry.path, this.settings.remoteDeleteTarget === "system-trash");
      this.index.markDeleted(op.fileId);
      return;
    }
    if (op.kind === "rename" && op.newPath && entry) {
      if (entry.path !== op.newPath && this.vault.exists(entry.path)) await this.vault.rename(entry.path, op.newPath);
      this.index.upsertFile({ ...entry, path: op.newPath, pathClock: pathClock ?? op.pathClock });
      return;
    }
    if ((op.kind === "create" || op.kind === "update" || op.kind === "restore") && op.contentHash) {
      const target = op.newPath ?? entry?.path;
      if (!target) return;
      const configDecision = shouldApplyConfigPath(target, this.settings);
      if (configDecision.category && !configDecision.applies) return;
      const activeRealtime = !op.contentEncoding && this.yjs?.hasSession(op.fileId) && isTextPath(target);
      if (activeRealtime) {
        const text = op.inlineText ?? new TextDecoder().decode(await this.fetchContentBytes(op.contentHash));
        const result = await this.yjs?.reconcileLayer1Content(op.fileId, text, op.contentHash);
        if (!result?.active) await this.vault.writeText(target, text);
      } else if (op.inlineText !== undefined) {
        await this.vault.writeText(target, op.inlineText);
      } else {
        await this.fetchAndWriteBlob(target, op.contentHash, op.contentEncoding);
      }
      this.index.upsertFile({
        fileId: op.fileId,
        path: target,
        type: op.type,
        contentHash: op.contentHash,
        size: op.size ?? 0,
        appliedContentVV: contentVV ?? op.newContentVV ?? {},
        pathClock: pathClock ?? entry?.pathClock,
        isDir: false,
        mtime: Date.now(),
        deleted: false,
      });
    }
  }

  private async fetchAndWriteBlob(target: string, hash: string, contentEncoding?: FileOp["contentEncoding"]): Promise<void> {
    if (this.index.device.downloadedHashes.includes(hash) && this.vault.exists(target)) {
      if (contentEncoding) {
        if ((await this.hashPath(target)) === hash) return;
      } else {
        const existing = await this.vault.readBytes(target);
        if ((await contentHash(existing)) === hash) return;
      }
    }
    const bytes = await this.fetchContentBytes(hash, contentEncoding);
    if (contentEncoding && isTextPath(target)) await this.vault.writeText(target, new TextDecoder().decode(bytes));
    else await this.vault.writeBytes(target, bytes);
    this.index.device.downloadedHashes = [...new Set([...this.index.device.downloadedHashes, hash])];
  }

  private async fetchContentBytes(hash: string, contentEncoding?: FileOp["contentEncoding"]): Promise<Uint8Array> {
    const contentPromise = this.transport.waitFor("content", (msg): msg is ContentMessage => msg.hash === hash);
    this.transport.send({ t: "get_content", hash });
    const content = await contentPromise;
    if (content.data === null) throw new Error(`Content ${hash} unavailable; resync required`);
    const bytes = decodeBase64(content.data);
    if ((await contentHash(bytes)) !== hash) throw new Error(`Hash verification failed for ${hash}`);
    if (!contentEncoding) return bytes;
    if (contentEncoding.algorithm !== ENCRYPTED_BLOB_ALGORITHM || !isEncryptedBlobEnvelope(bytes)) throw new Error(`Unsupported encrypted content format for ${hash}`);
    return decryptVaultBytes(bytes, this.requireContentKey());
  }

  private isEncryptionEnabled(): boolean {
    return this.settings.contentEncryption.enabled;
  }

  private requireContentKey(): VaultContentKey {
    const key = this.contentKeyProvider();
    if (!key) throw new Error("Vault content encryption is enabled but no passphrase has been unlocked for this session");
    return key;
  }

  private async encryptForStorage(plaintext: Uint8Array): Promise<Uint8Array> {
    return serializeEncryptedBlob(await encryptVaultBytes(plaintext, this.requireContentKey()));
  }

  private async readPlaintextBytes(path: string, textOrBytes?: string | Uint8Array): Promise<Uint8Array> {
    if (typeof textOrBytes === "string") return new TextEncoder().encode(textOrBytes);
    if (textOrBytes instanceof Uint8Array) return textOrBytes;
    if (isTextPath(path)) return new TextEncoder().encode(await this.vault.readText(path));
    return this.vault.readBytes(path);
  }

  private async persistOutbox(): Promise<void> {
    this.index.setOutbox(this.outbox.entries, this.outbox.nextDeviceSeq);
    await this.index.save();
  }

  private setState(state: EngineState, detail?: string): void {
    this.state = state;
    this.hooks.onState?.(state, detail);
  }
}

export function conflictResolutionVV(ours: VersionVector, theirs: VersionVector, deviceId: string): VersionVector {
  return bump(join(ours, theirs), deviceId);
}

import { PROTOCOL_VERSION, type FileOp, type FileType, type OpKind } from "@obsidian-sync/shared";

export type OutboxStatus = "queued" | "inflight" | "conflicted" | "rejected";
export interface OutboxEntry {
  op: FileOp;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  queuedAt: number;
  updatedAt: number;
}

export type FileOpDraft = Omit<FileOp, "opId" | "deviceId" | "deviceSeq" | "schemaVersion"> & Partial<Pick<FileOp, "opId">>;

export function createFileOpDraft(input: { vaultId: string; fileId: string; type: FileType; kind: OpKind } & Partial<FileOpDraft>): FileOpDraft {
  return { ...input };
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class OutboxManager {
  private readonly map = new Map<string, OutboxEntry>();
  private _nextDeviceSeq: number;

  constructor(private readonly deviceId: string, nextDeviceSeq: number, entries: readonly OutboxEntry[]) {
    this._nextDeviceSeq = nextDeviceSeq;
    for (const entry of entries) this.map.set(entry.op.opId, { ...entry });
    const maxExisting = Math.max(0, ...entries.map((entry) => entry.op.deviceSeq));
    if (this._nextDeviceSeq <= maxExisting) this._nextDeviceSeq = maxExisting + 1;
  }

  get nextDeviceSeq(): number { return this._nextDeviceSeq; }
  get entries(): OutboxEntry[] { return [...this.map.values()].sort((a, b) => a.op.deviceSeq - b.op.deviceSeq); }

  enqueue(draft: FileOpDraft): FileOp {
    const op: FileOp = {
      ...draft,
      opId: draft.opId ?? uuid(),
      deviceId: this.deviceId,
      deviceSeq: this._nextDeviceSeq,
      schemaVersion: PROTOCOL_VERSION,
    };
    this._nextDeviceSeq += 1;
    const now = Date.now();
    this.map.set(op.opId, { op, status: "queued", attempts: 0, queuedAt: now, updatedAt: now });
    return op;
  }

  markInflight(opId: string): OutboxEntry | undefined {
    const entry = this.map.get(opId);
    if (!entry) return undefined;
    entry.status = "inflight";
    entry.attempts += 1;
    entry.updatedAt = Date.now();
    return entry;
  }

  reject(opId: string, message: string, terminal = false): void {
    const entry = this.map.get(opId);
    if (!entry) return;
    entry.status = terminal ? "rejected" : "queued";
    entry.lastError = message;
    entry.updatedAt = Date.now();
  }

  conflict(opId: string, conflictId: string): void {
    const entry = this.map.get(opId);
    if (!entry) return;
    entry.status = "conflicted";
    entry.lastError = conflictId;
    entry.updatedAt = Date.now();
  }

  ack(opId: string, _vaultSeq: number): void {
    this.map.delete(opId);
  }

  /**
   * Roll back the most-recently enqueued op (highest deviceSeq) after a terminal
   * reject, freeing its deviceSeq so the stream stays gap-free. Only valid for
   * the op holding the highest seq (the one just sent in a serialized flush).
   */
  rollbackLast(opId: string): boolean {
    const entry = this.map.get(opId);
    if (!entry || entry.op.deviceSeq !== this._nextDeviceSeq - 1) return false;
    this.map.delete(opId);
    this._nextDeviceSeq -= 1;
    return true;
  }

  /**
   * Discard never-sent ("queued") ops and rewind nextDeviceSeq so the device's
   * sequence stays contiguous. Used by force-pull to drop unsynced local edits.
   * Refuses (blockedByInflight) when any op is inflight, since the server may
   * already have consumed that seq.
   */
  discardUnsent(): { discarded: number; blockedByInflight: boolean } {
    const all = this.entries;
    if (all.some((entry) => entry.status === "inflight")) return { discarded: 0, blockedByInflight: true };
    const queued = all.filter((entry) => entry.status === "queued");
    if (queued.length === 0) return { discarded: 0, blockedByInflight: false };
    const lowestQueuedSeq = Math.min(...queued.map((entry) => entry.op.deviceSeq));
    // Only safe when nothing with a higher seq was already accepted by the server.
    if (all.some((entry) => entry.status !== "queued" && entry.op.deviceSeq > lowestQueuedSeq)) {
      return { discarded: 0, blockedByInflight: true };
    }
    for (const entry of queued) this.map.delete(entry.op.opId);
    this._nextDeviceSeq = lowestQueuedSeq;
    return { discarded: queued.length, blockedByInflight: false };
  }

  retryable(): OutboxEntry[] {
    return this.entries.filter((entry) => entry.status === "queued" || entry.status === "inflight");
  }
}

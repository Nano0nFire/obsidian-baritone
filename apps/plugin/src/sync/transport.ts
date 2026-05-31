import type { ClientMessage, ServerMessage } from "@obsidian-sync/shared";

export type TransportState = "closed" | "connecting" | "open" | "ready";
type Listener = (message: ServerMessage) => void | Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number";
}

function hasBoolean(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "boolean";
}

function validateServerMessage(parsed: Record<string, unknown>): void {
  switch (parsed.t) {
    case "welcome":
      if (!hasNumber(parsed, "serverTime") || !hasNumber(parsed, "currentSeq") || !hasNumber(parsed, "serverProtocol") || !hasNumber(parsed, "minClientProtocol") || !Array.isArray(parsed.capabilities)) throw new Error("Invalid welcome message");
      return;
    case "ops":
      if (!Array.isArray(parsed.ops) || !hasBoolean(parsed, "more")) throw new Error("Invalid ops message");
      return;
    case "op_ack":
      if (!hasString(parsed, "opId") || !hasNumber(parsed, "vaultSeq") || !isRecord(parsed.resultingClocks) || !hasNumber(parsed.resultingClocks, "epoch")) throw new Error("Invalid op_ack message");
      return;
    case "blob_upload_url":
      if (!hasString(parsed, "hash") || !(parsed.url === null || typeof parsed.url === "string") || !hasBoolean(parsed, "alreadyExists")) throw new Error("Invalid blob_upload_url message");
      return;
    case "conflict":
      if (!isRecord(parsed.conflict) || !hasString(parsed.conflict, "conflictId")) throw new Error("Invalid conflict message");
      return;
    case "conflict_state":
      if (!hasString(parsed, "conflictId") || !hasString(parsed, "status")) throw new Error("Invalid conflict_state message");
      return;
    case "room_state":
      if (!hasString(parsed, "fileId") || !hasNumber(parsed, "roomEpoch") || !hasString(parsed, "yjsSnapshot") || !hasString(parsed, "stateVector")) throw new Error("Invalid room_state message");
      return;
    case "yjs_update":
      if (!hasString(parsed, "fileId") || !hasNumber(parsed, "roomEpoch") || !hasNumber(parsed, "seq") || !hasString(parsed, "update")) throw new Error("Invalid yjs_update message");
      return;
    case "yjs_ack":
      if (!hasString(parsed, "fileId") || !hasNumber(parsed, "roomEpoch") || !hasNumber(parsed, "updateId") || !hasNumber(parsed, "seq")) throw new Error("Invalid yjs_ack message");
      return;
    case "yjs_awareness":
      if (!hasString(parsed, "fileId") || !hasNumber(parsed, "roomEpoch") || !hasString(parsed, "from") || !hasString(parsed, "state")) throw new Error("Invalid yjs_awareness message");
      return;
    case "room_closed":
      if (!hasString(parsed, "fileId") || !hasNumber(parsed, "roomEpoch") || !hasString(parsed, "reason")) throw new Error("Invalid room_closed message");
      return;
    case "manifest_page":
      if (!hasNumber(parsed, "watermarkSeq") || !Array.isArray(parsed.items) || !(parsed.nextCursor === null || typeof parsed.nextCursor === "string")) throw new Error("Invalid manifest_page message");
      return;
    case "content":
      if (!hasString(parsed, "hash") || !(parsed.data === null || typeof parsed.data === "string")) throw new Error("Invalid content message");
      return;
    case "trash_list":
      if (!Array.isArray(parsed.items)) throw new Error("Invalid trash_list message");
      return;
    case "history_list":
      if (!hasString(parsed, "requestId") || !hasString(parsed, "fileId") || !Array.isArray(parsed.versions) || !hasBoolean(parsed, "more")) throw new Error("Invalid history_list message");
      return;
    case "history_version":
      if (!hasString(parsed, "requestId") || !hasString(parsed, "fileId") || !hasString(parsed, "versionId") || !hasString(parsed, "text")) throw new Error("Invalid history_version message");
      return;
    case "history_restored":
      if (!hasString(parsed, "requestId") || !hasString(parsed, "fileId") || !hasString(parsed, "versionId") || !hasString(parsed, "text")) throw new Error("Invalid history_restored message");
      return;
    case "error":
      if (!hasString(parsed, "code") || !hasString(parsed, "message")) throw new Error("Invalid error message");
      return;
    case "reject":
      if (!hasString(parsed, "code") || !hasString(parsed, "message")) throw new Error("Invalid reject message");
      return;
    default:
      throw new Error(`Unsupported server message type: ${String(parsed.t)}`);
  }
}

export function parseServerMessage(raw: string): ServerMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.t !== "string") throw new Error("Invalid server message envelope");
  validateServerMessage(parsed);
  return parsed as unknown as ServerMessage;
}

export interface ReconnectOptions {
  minDelayMs: number;
  maxDelayMs: number;
}

export interface TransportHooks {
  onStateChange?(state: TransportState): void;
  onInvalidMessage?(error: Error, raw: string): void;
}

export class SyncTransport {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(state: TransportState) => void>();
  private pendingMessages: ClientMessage[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private state: TransportState = "closed";
  private attempt = 0;

  constructor(
    private readonly url: string,
    private readonly options: ReconnectOptions = { minDelayMs: 500, maxDelayMs: 30_000 },
    private readonly hooks: TransportHooks = {},
  ) {}

  get readyState(): TransportState { return this.state; }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (state: TransportState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  connect(): void {
    this.stopped = false;
    if (this.socket || this.state === "connecting" || this.state === "open") return;
    this.setState("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.setState("open");
      const queued = [...this.pendingMessages];
      this.pendingMessages = [];
      for (const msg of queued) this.send(msg);
    };
    socket.onmessage = (event) => {
      try {
        const msg = parseServerMessage(String(event.data));
        if (msg.t === "welcome") this.setState("ready");
        for (const listener of this.listeners) void listener(msg);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.hooks.onInvalidMessage?.(normalized, String(event.data));
        console.error("obsidian-sync: dropped invalid server message", error);
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.setState("closed");
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setState("closed");
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.pendingMessages.push(message);
    this.connect();
  }

  waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("Timed out waiting for transport readiness"));
      }, timeoutMs);
      const off = this.onState((state) => {
        if (state === "ready") {
          clearTimeout(timer);
          off();
          resolve();
        } else if (state === "closed") {
          clearTimeout(timer);
          off();
          reject(new Error("Transport closed before authentication completed"));
        }
      });
    });
  }

  waitFor<T extends ServerMessage["t"]>(type: T, predicate: (message: Extract<ServerMessage, { t: T }>) => boolean, timeoutMs = 30_000): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      const off = this.onMessage((message) => {
        if (message.t !== type) return;
        const typed = message as Extract<ServerMessage, { t: T }>;
        if (!predicate(typed)) return;
        clearTimeout(timer);
        off();
        resolve(typed);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(this.options.maxDelayMs, this.options.minDelayMs * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onStateChange?.(state);
    for (const listener of this.stateListeners) listener(state);
  }
}

import type { ClientMessage, ServerMessage } from "@obsidian-sync/shared";

export type TransportState = "closed" | "connecting" | "open";
type Listener = (message: ServerMessage) => void | Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseServerMessage(raw: string): ServerMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.t !== "string") throw new Error("Invalid server message envelope");
  return parsed as unknown as ServerMessage;
}

export interface ReconnectOptions {
  minDelayMs: number;
  maxDelayMs: number;
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

  constructor(private readonly url: string, private readonly options: ReconnectOptions = { minDelayMs: 500, maxDelayMs: 30_000 }) {}

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
        for (const listener of this.listeners) void listener(msg);
      } catch (error) {
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
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

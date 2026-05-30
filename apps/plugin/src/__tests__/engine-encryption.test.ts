import { describe, expect, it } from "vitest";
import {
  contentHash,
  deriveVaultContentKey,
  encryptVaultBytes,
  serializeEncryptedBlob,
  type AppliedOp,
  type ClientMessage,
  type FileOp,
  type ServerMessage,
  type VaultContentKey,
} from "@obsidian-sync/shared";
import { SyncEngine } from "../sync/engine.js";
import { LocalIndexStore, type PluginAdapter } from "../localindex/index.js";
import type { SyncTransport, TransportState } from "../sync/transport.js";
import type { VaultFileInfo, VaultIO } from "../sync/vault-io.js";
import { DEFAULT_SETTINGS, type PluginSettings } from "../settings.js";
import { YjsSessionManager } from "../sync/yjs-session.js";

const deviceId = "device-enc";
const vaultId = "vault-enc";
const salt = new Uint8Array(Array.from({ length: 16 }, (_, i) => i + 1));

function memAdapter(): PluginAdapter {
  const store = new Map<string, string>();
  return {
    async exists(path) { return store.has(path); },
    async read(path) { return store.get(path) ?? ""; },
    async write(path, data) { store.set(path, data); },
    async remove(path) { store.delete(path); },
    async rename(oldPath, newPath) { const value = store.get(oldPath); if (value !== undefined) { store.set(newPath, value); store.delete(oldPath); } },
  };
}

class FakeVault implements VaultIO {
  readonly files = new Map<string, Uint8Array>();
  listFiles(): VaultFileInfo[] { return [...this.files.entries()].map(([path, bytes]) => ({ path, mtime: 1, size: bytes.byteLength })); }
  async readText(path: string): Promise<string> { return new TextDecoder().decode(this.files.get(path) ?? new Uint8Array()); }
  async readBytes(path: string): Promise<Uint8Array> { return this.files.get(path) ?? new Uint8Array(); }
  async writeText(path: string, text: string): Promise<void> { this.files.set(path, new TextEncoder().encode(text)); }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> { this.files.set(path, bytes); }
  async rename(): Promise<void> {}
  async trash(): Promise<void> {}
  exists(path: string): boolean { return this.files.has(path); }
}

class FakeTransport {
  readyState: TransportState = "open";
  readonly sent: ClientMessage[] = [];
  readonly uploaded = new Map<string, Uint8Array>();
  contentByHash = new Map<string, Uint8Array>();
  private messageListener: ((m: ServerMessage) => void | Promise<void>) | null = null;
  private waiters: Array<{ type: ServerMessage["t"]; predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];

  onMessage(listener: (m: ServerMessage) => void | Promise<void>): () => void { this.messageListener = listener; return () => { this.messageListener = null; }; }
  onState(): () => void { return () => {}; }
  connect(): void {}
  close(): void {}

  send(message: ClientMessage): void {
    this.sent.push(message);
    if (message.t === "blob_upload_init") this.deliverToWaiter({ t: "blob_upload_url", hash: message.hash, url: null, alreadyExists: true });
    if (message.t === "get_content") {
      const bytes = this.contentByHash.get(message.hash) ?? null;
      this.deliverToWaiter({ t: "content", hash: message.hash, data: bytes ? Buffer.from(bytes).toString("base64") : null });
    }
  }

  waitFor<T extends ServerMessage["t"]>(type: T, predicate: (m: Extract<ServerMessage, { t: T }>) => boolean): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((resolve) => this.waiters.push({ type, predicate: predicate as (m: ServerMessage) => boolean, resolve: resolve as (m: ServerMessage) => void }));
  }

  async deliver(message: ServerMessage): Promise<void> { await this.messageListener?.(message); }

  private deliverToWaiter(message: ServerMessage): void {
    const waiter = this.waiters.find((item) => item.type === message.t && item.predicate(message));
    if (!waiter) return;
    this.waiters = this.waiters.filter((item) => item !== waiter);
    waiter.resolve(message);
  }
}

function encryptedSettings(): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    deviceId,
    vaultId,
    accessToken: "token",
    contentEncryption: { enabled: true, salt: Buffer.from(salt).toString("base64"), verifier: "test-verifier" },
  };
}

function makeEngine(key: VaultContentKey, transport = new FakeTransport(), vault = new FakeVault()) {
  const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
  const errors: Error[] = [];
  const engine = new SyncEngine(encryptedSettings(), index, vault, transport as unknown as SyncTransport, { onError: (error) => errors.push(error) }, undefined, () => key);
  return { engine, index, transport, vault, errors };
}

function encryptedRemoteOp(fileId: string, path: string, hash: string, size: number): FileOp {
  return {
    opId: "remote-op-1",
    deviceId: "remote",
    deviceSeq: 1,
    fileId,
    vaultId,
    kind: "create",
    type: "note",
    newPath: path,
    pathClock: { lamport: 1, deviceId: "remote" },
    newContentVV: { remote: 1 },
    contentHash: hash,
    blobRef: hash,
    size,
    contentEncoding: { algorithm: "aes-256-gcm-pbkdf2-sha256-convergent-v1", version: 1 },
  };
}

describe("SyncEngine content encryption", () => {
  it("uploads encrypted note content as a hashed blob and never sends plaintext inlineText", async () => {
    const key = await deriveVaultContentKey("passphrase", salt);
    const { engine, transport, vault } = makeEngine(key);
    await vault.writeText("secret.md", "very secret note");

    const draft = await engine.makeContentOp("file-1", "secret.md", "note");

    expect(draft.inlineText).toBeUndefined();
    expect(draft.blobRef).toBe(draft.contentHash);
    expect(draft.contentEncoding?.algorithm).toBe("aes-256-gcm-pbkdf2-sha256-convergent-v1");
    expect(transport.sent.some((message) => message.t === "blob_upload_init" && message.hash === draft.contentHash && message.size === draft.size)).toBe(true);
  });

  it("decrypts incoming encrypted blobs after verifying the ciphertext content hash", async () => {
    const key = await deriveVaultContentKey("passphrase", salt);
    const plaintext = new TextEncoder().encode("remote secret");
    const encrypted = serializeEncryptedBlob(await encryptVaultBytes(plaintext, key));
    const hash = await contentHash(encrypted);
    const { engine, index, transport, vault } = makeEngine(key);
    transport.contentByHash.set(hash, encrypted);
    engine.start();

    const applied: AppliedOp = { vaultSeq: 1, op: encryptedRemoteOp("file-2", "remote.md", hash, encrypted.byteLength), resultingClocks: { contentVV: { remote: 1 }, pathClock: { lamport: 1, deviceId: "remote" }, epoch: 0 } };
    await transport.deliver({ t: "ops", ops: [applied], more: false });

    await expect(vault.readText("remote.md")).resolves.toBe("remote secret");
    expect(index.byFileId("file-2")?.contentHash).toBe(hash);
    expect(index.device.downloadedHashes).toContain(hash);
  });
});

describe("Layer 2 encryption guard", () => {
  it("blocks promote/openFile when vault content encryption is enabled", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport, { canPromote: () => false, promoteDisabledReason: "Vault content encryption is enabled" });

    await expect(manager.openFile("file-1")).rejects.toThrow(/encryption/i);
    expect(transport.sent.some((message) => message.t === "promote")).toBe(false);
  });
});

import { ENCRYPTED_BLOB_ALGORITHM, contentHash, decryptVaultBytes, isEncryptedBlobEnvelope, type ContentMessage, type ManifestEntry, type ManifestPageMessage, type VaultContentKey } from "@obsidian-sync/shared";
import type { LocalIndexStore } from "../localindex/index.js";
import type { SyncTransport } from "./transport.js";
import type { VaultIO } from "./vault-io.js";

function decodeBase64(data: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(data, "base64"));
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export class InitialSyncRunner {
  constructor(private readonly transport: SyncTransport, private readonly index: LocalIndexStore, private readonly vault: VaultIO, private readonly vaultId: string, private readonly contentKeyProvider: () => VaultContentKey | null = () => null) {}

  async run(): Promise<void> {
    let cursor = this.index.device.manifestCursor ?? undefined;
    let watermark = this.index.device.manifestWatermarkSeq ?? 0;
    do {
      const pagePromise = this.transport.waitFor("manifest_page", (msg): msg is ManifestPageMessage => msg.nextCursor !== undefined);
      this.transport.send({ t: "get_manifest", vaultId: this.vaultId, cursor });
      const page = await pagePromise;
      watermark = page.watermarkSeq;
      for (const item of page.items) await this.applyManifestEntry(item);
      cursor = page.nextCursor ?? undefined;
      this.index.device.manifestCursor = cursor ?? null;
      this.index.device.manifestWatermarkSeq = watermark;
      await this.index.save();
    } while (cursor);
    this.index.setAppliedSeq(watermark);
    this.index.device.manifestCursor = null;
    await this.index.save();
    this.transport.send({ t: "get_ops", sinceSeq: watermark });
  }

  private async applyManifestEntry(entry: ManifestEntry): Promise<void> {
    if (entry.deleted || !entry.contentHash) return;
    let bytes: Uint8Array;
    const canUseLocalCache = !entry.contentEncoding && this.index.device.downloadedHashes.includes(entry.contentHash) && this.vault.exists(entry.path);
    if (canUseLocalCache) {
      bytes = await this.vault.readBytes(entry.path);
    } else {
      const contentPromise = this.transport.waitFor("content", (msg): msg is ContentMessage => msg.hash === entry.contentHash);
      this.transport.send({ t: "get_content", hash: entry.contentHash });
      const content = await contentPromise;
      if (content.data === null) throw new Error(`Content ${entry.contentHash} unavailable; manifest must be refreshed`);
      bytes = decodeBase64(content.data);
      this.index.device.downloadedHashes = [...new Set([...this.index.device.downloadedHashes, entry.contentHash])];
    }
    const actual = await contentHash(bytes);
    if (actual !== entry.contentHash) throw new Error(`Hash verification failed for ${entry.path}`);
    if (entry.contentEncoding) {
      if (entry.contentEncoding.algorithm !== ENCRYPTED_BLOB_ALGORITHM || !isEncryptedBlobEnvelope(bytes)) throw new Error(`Unsupported encrypted content format for ${entry.path}`);
      const key = this.contentKeyProvider();
      if (!key) throw new Error("Vault content encryption is enabled but no passphrase has been unlocked for this session");
      bytes = await decryptVaultBytes(bytes, key);
    }
    if (entry.type === "note" || entry.type === "config") await this.vault.writeText(entry.path, new TextDecoder().decode(bytes));
    else await this.vault.writeBytes(entry.path, bytes);
    this.index.upsertFile({
      fileId: entry.fileId,
      path: entry.path,
      type: entry.type,
      contentHash: entry.contentHash,
      size: entry.size ?? bytes.byteLength,
      appliedContentVV: entry.contentVV,
      pathClock: entry.pathClock,
      isDir: false,
      mtime: Date.now(),
      deleted: false,
    });
  }
}

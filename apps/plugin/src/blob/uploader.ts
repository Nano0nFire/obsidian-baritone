import { contentHash, type BlobUploadUrlMessage } from "@obsidian-sync/shared";
import type { FetchLike } from "../http-adapter.js";
import type { SyncTransport } from "../sync/transport.js";

export class BlobUploader {
  constructor(
    private readonly transport: SyncTransport,
    private readonly fetchLike: FetchLike = fetch,
  ) {}

  async upload(fileId: string | undefined, bytes: Uint8Array): Promise<string> {
    const hash = await contentHash(bytes);
    const responsePromise = this.transport.waitFor("blob_upload_url", (msg): msg is BlobUploadUrlMessage => msg.hash === hash);
    this.transport.send({ t: "blob_upload_init", fileId, hash, size: bytes.byteLength });
    const response = await responsePromise;
    if (!response.alreadyExists && response.url) {
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const put = await this.fetchLike(response.url, { method: "PUT", body });
      if (!put.ok) throw new Error(`Blob upload failed: ${put.status} ${put.statusText}`);
      this.transport.send({ t: "blob_upload_complete", hash });
    }
    return hash;
  }
}

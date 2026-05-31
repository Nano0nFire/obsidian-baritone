import { describe, expect, it, vi } from "vitest";
import { contentHash, type ClientMessage, type ServerMessage } from "@obsidian-sync/shared";
import { BlobUploader } from "../blob/uploader.js";
import type { SyncTransport } from "../sync/transport.js";
import type { FetchLike } from "../http-adapter.js";

class FakeTransport {
  readonly sent: ClientMessage[] = [];
  private waiters: Array<{ type: ServerMessage["t"]; predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];

  onMessage(): () => void { return () => {}; }
  onState(): () => void { return () => {}; }
  connect(): void {}
  close(): void {}

  send(message: ClientMessage): void {
    this.sent.push(message);
    if (message.t === "blob_upload_init") {
      this.deliver({
        t: "blob_upload_url",
        hash: message.hash,
        url: "http://blob.example/upload",
        alreadyExists: false,
      });
    }
    if (message.t === "blob_upload_complete") {
      this.deliver({
        t: "blob_upload_url",
        hash: message.hash,
        url: null,
        alreadyExists: true,
      });
    }
  }

  waitFor<T extends ServerMessage["t"]>(type: T, predicate: (m: Extract<ServerMessage, { t: T }>) => boolean): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((resolve) => {
      this.waiters.push({
        type,
        predicate: predicate as (m: ServerMessage) => boolean,
        resolve: resolve as (m: ServerMessage) => void,
      });
    });
  }

  private deliver(message: ServerMessage): void {
    const waiter = this.waiters.find((item) => item.type === message.t && item.predicate(message));
    if (!waiter) return;
    this.waiters = this.waiters.filter((item) => item !== waiter);
    waiter.resolve(message);
  }
}

describe("BlobUploader", () => {
  it("uses the injected fetch implementation for blob PUT uploads", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await contentHash(bytes);
    const transport = new FakeTransport();
    const injectedFetch = vi.fn<FetchLike>(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({}),
      text: async () => "",
    }));
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be used");
    });
    vi.stubGlobal("fetch", globalFetch);

    const uploader = new BlobUploader(transport as unknown as SyncTransport, injectedFetch);
    await expect(uploader.upload("file-1", bytes)).resolves.toBe(hash);

    expect(injectedFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(transport.sent.some((message) => message.t === "blob_upload_complete" && message.hash === hash)).toBe(true);
  });
});

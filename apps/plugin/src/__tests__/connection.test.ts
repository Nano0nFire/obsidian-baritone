import { describe, expect, it, vi } from "vitest";
import { checkServerConnection, serverHttpBase } from "../connection.js";

describe("serverHttpBase", () => {
  it("maps ws:// to http:// and strips a trailing /sync", () => {
    expect(serverHttpBase("ws://192.168.0.132:3000/sync")).toBe("http://192.168.0.132:3000");
  });

  it("maps wss:// to https:// and strips a trailing /sync/", () => {
    expect(serverHttpBase("wss://sync.example.com/sync/")).toBe("https://sync.example.com");
  });

  it("passes an http(s) base through unchanged", () => {
    expect(serverHttpBase("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

describe("checkServerConnection", () => {
  it("rejects an empty URL without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await checkServerConnection("   ", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/empty/i) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns ok with check flags when /readyz reports ready", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, checks: { database: true, websocket: true } }), { status: 200 }),
    );
    const result = await checkServerConnection("ws://192.168.0.132:3000/sync", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, database: true, websocket: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("http://192.168.0.132:3000/readyz");
  });

  it("reports not-ready when the server returns 503", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, checks: { database: false, websocket: true } }), { status: 503 }),
    );
    const result = await checkServerConnection("http://localhost:3000", fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("reports the error message when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const result = await checkServerConnection("http://localhost:3000", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "Failed to fetch" });
  });

  it("times out even when the request implementation ignores the abort signal", async () => {
    // Obsidian's requestUrl cannot be aborted, so the timeout must be enforced
    // by checkServerConnection itself rather than relying on the abort signal.
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const result = await checkServerConnection(
      "http://localhost:3000",
      fetchImpl as unknown as typeof fetch,
      20,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/timed out/i);
  });
});

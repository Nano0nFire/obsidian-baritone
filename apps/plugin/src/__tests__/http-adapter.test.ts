import { describe, expect, it, vi } from "vitest";
import { makeRequestUrlFetch, type RequestUrlLike, type RequestUrlLikeResponse } from "../http-adapter.js";

function res(partial: Partial<RequestUrlLikeResponse>): RequestUrlLikeResponse {
  return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: undefined, text: "", ...partial };
}

describe("makeRequestUrlFetch", () => {
  it("maps a 2xx requestUrl response to an ok fetch-like response", async () => {
    const requestUrl: RequestUrlLike = vi.fn(async () =>
      res({ status: 200, json: { ok: true, checks: { database: true, websocket: false } }, text: "{}" }),
    );
    const fetchLike = makeRequestUrlFetch(requestUrl);
    const response = await fetchLike("http://server/readyz");
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, checks: { database: true, websocket: false } });
  });

  it("treats 4xx/5xx as not ok and never throws (throw:false)", async () => {
    const requestUrl = vi.fn(async () => res({ status: 503, json: { ok: false }, text: "" }));
    const fetchLike = makeRequestUrlFetch(requestUrl as unknown as RequestUrlLike);
    const response = await fetchLike("http://server/readyz");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
    expect(((requestUrl.mock.calls[0] as unknown[])[0] as { throw?: boolean }).throw).toBe(false);
  });

  it("forwards method, url, headers, and string body", async () => {
    const requestUrl = vi.fn(async () => res({ status: 200, json: { accessToken: "a" } }));
    const fetchLike = makeRequestUrlFetch(requestUrl as unknown as RequestUrlLike);
    await fetchLike("http://server/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u" }),
    });
    const param = (requestUrl.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(param.method).toBe("POST");
    expect(param.url).toBe("http://server/auth/login");
    expect((param.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(param.body).toBe(JSON.stringify({ username: "u" }));
  });

  it("converts a Uint8Array body into an ArrayBuffer for binary PUT uploads", async () => {
    const requestUrl = vi.fn(async () => res({ status: 200 }));
    const fetchLike = makeRequestUrlFetch(requestUrl as unknown as RequestUrlLike);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await fetchLike("http://minio/blob", { method: "PUT", body: bytes as unknown as ArrayBuffer });
    const param = (requestUrl.mock.calls[0] as unknown[])[0] as { body: unknown };
    expect(param.body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(param.body as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
  });

  it("exposes the response text", async () => {
    const requestUrl = vi.fn(async () => res({ status: 200, text: "hello" }));
    const fetchLike = makeRequestUrlFetch(requestUrl as unknown as RequestUrlLike);
    const response = await fetchLike("http://server/x");
    await expect(response.text()).resolves.toBe("hello");
  });
});

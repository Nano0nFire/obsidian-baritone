/**
 * Adapter that bridges Obsidian's `requestUrl` (a main-process HTTP client that
 * is NOT subject to the renderer's CORS policy) to a minimal `fetch`-like API.
 *
 * The Obsidian desktop/mobile renderer enforces CORS on `window.fetch`, so
 * requests to a self-hosted sync server that does not emit
 * `Access-Control-Allow-Origin` headers fail with "Failed to fetch". Routing
 * those requests through `requestUrl` avoids the problem entirely.
 *
 * This module is intentionally free of any `obsidian` import so it stays unit
 * testable in Node; the real `requestUrl` is bound in `http.ts`.
 */

/** Subset of Obsidian's `RequestUrlResponse` that we rely on. */
export interface RequestUrlLikeResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

/** Subset of Obsidian's `RequestUrlParam`. */
export interface RequestUrlLikeParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export type RequestUrlLike = (param: RequestUrlLikeParam) => Promise<RequestUrlLikeResponse>;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

function toArrayBuffer(body: string | ArrayBuffer | ArrayBufferView | undefined): string | ArrayBuffer | undefined {
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  return body;
}

function contentTypeOf(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") return value;
  }
  return undefined;
}

/** Wrap an Obsidian-style `requestUrl` into a `fetch`-like function. */
export function makeRequestUrlFetch(requestUrlImpl: RequestUrlLike): FetchLike {
  return async (url, init) => {
    const response = await requestUrlImpl({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers,
      contentType: contentTypeOf(init?.headers),
      body: toArrayBuffer(init?.body),
      // Never throw on 4xx/5xx so callers can inspect the status, mirroring fetch.
      throw: false,
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: "",
      json: async () => response.json,
      text: async () => response.text,
    };
  };
}

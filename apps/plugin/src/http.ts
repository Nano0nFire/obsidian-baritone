import { requestUrl } from "obsidian";
import { makeRequestUrlFetch, type FetchLike, type RequestUrlLike } from "./http-adapter.js";

/**
 * A `fetch`-compatible function backed by Obsidian's `requestUrl`, so plugin
 * HTTP calls bypass the renderer CORS sandbox. Use this instead of the global
 * `fetch` for every request to the sync server or blob storage.
 */
export const requestUrlFetch: FetchLike = makeRequestUrlFetch(requestUrl as unknown as RequestUrlLike);

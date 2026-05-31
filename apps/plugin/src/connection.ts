/** Convert the configured WebSocket sync URL into the server's HTTP base URL. */
export function serverHttpBase(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  const asHttp = trimmed.startsWith("ws://")
    ? `http://${trimmed.slice(5)}`
    : trimmed.startsWith("wss://")
      ? `https://${trimmed.slice(6)}`
      : trimmed;
  return asHttp.replace(/\/sync\/?$/, "");
}

export type ConnectionResult =
  | { ok: true; database: boolean; websocket: boolean; status: number }
  | { ok: false; reason: string; status?: number };

interface ReadyzBody {
  ok?: boolean;
  checks?: { database?: boolean; websocket?: boolean };
}

/**
 * Probe the sync server's `/readyz` endpoint to verify reachability and
 * readiness. Pure and dependency-injected (fetch) so it can be unit tested and
 * reused by the settings "Test connection" button.
 */
export async function checkServerConnection(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<ConnectionResult> {
  if (serverUrl.trim() === "") {
    return { ok: false, reason: "Server URL is empty" };
  }
  const url = `${serverHttpBase(serverUrl)}/readyz`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", signal: controller.signal });
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.name === "AbortError"
          ? `Timed out after ${timeoutMs} ms`
          : error.message
        : String(error);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }

  let body: ReadyzBody = {};
  try {
    body = (await response.json()) as ReadyzBody;
  } catch {
    // Non-JSON response; fall through to the status-based check below.
  }

  if (!response.ok || body.ok !== true) {
    return { ok: false, reason: `Server not ready (HTTP ${response.status})`, status: response.status };
  }
  return {
    ok: true,
    database: body.checks?.database ?? false,
    websocket: body.checks?.websocket ?? false,
    status: response.status,
  };
}

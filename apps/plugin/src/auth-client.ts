import { serverHttpBase } from "./connection.js";
import type { FetchLike } from "./http-adapter.js";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

interface ErrorBody {
  message?: string;
}

async function parseAuthResponse(response: Awaited<ReturnType<FetchLike>>): Promise<AuthTokens> {
  const body = await response.json() as Partial<AuthTokens & ErrorBody>;
  if (!response.ok || !body.accessToken || !body.refreshToken || !body.deviceId) {
    throw new Error(body.message ?? `HTTP ${response.status}`);
  }
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, deviceId: body.deviceId };
}

export async function loginWithPassword(
  serverUrl: string,
  request: { username: string; password: string; vaultId: string; deviceName?: string },
  fetchImpl: FetchLike,
): Promise<AuthTokens> {
  const response = await fetchImpl(`${serverHttpBase(serverUrl)}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return parseAuthResponse(response);
}

export async function refreshSessionTokens(serverUrl: string, refreshToken: string, fetchImpl: FetchLike): Promise<AuthTokens> {
  const response = await fetchImpl(`${serverHttpBase(serverUrl)}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  return parseAuthResponse(response);
}

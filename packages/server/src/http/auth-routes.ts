import type http from 'node:http';
import { ErrorCode, SyncError } from '@obsidian-sync/shared';
import { z } from 'zod';
import type { LoginAttemptContext } from '../auth/service.js';

/** Minimal surface of {@link AuthService} required by the auth HTTP routes. */
export interface LoginCapable {
  login(
    username: string,
    password: string,
    vaultId: string,
    deviceName: string,
    context?: LoginAttemptContext,
  ): Promise<{ accessToken: string; refreshToken: string; deviceId: string }>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; deviceId: string }>;
}

/** Maximum accepted request body for auth endpoints (defends against abuse). */
export const AUTH_BODY_LIMIT_BYTES = 64 * 1024;

const loginRequestSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
  vaultId: z.string().min(1).max(200),
  deviceName: z.string().max(200).optional(),
});

const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(1024),
});

/** Map a protocol {@link ErrorCode} to the HTTP status clients should see. */
export function httpStatusForError(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.UNAUTHENTICATED:
    case ErrorCode.TOKEN_EXPIRED:
      return 401;
    case ErrorCode.FORBIDDEN:
    case ErrorCode.DEVICE_REVOKED:
      return 403;
    case ErrorCode.NOT_FOUND:
    case ErrorCode.ROOM_NOT_FOUND:
      return 404;
    case ErrorCode.RATE_LIMITED:
      return 429;
    case ErrorCode.PAYLOAD_TOO_LARGE:
      return 413;
    case ErrorCode.UPGRADE_REQUIRED:
      return 426;
    case ErrorCode.QUOTA_EXCEEDED:
      return 409;
    case ErrorCode.INTERNAL:
      return 500;
    default:
      return 400;
  }
}

export interface RouteResult {
  status: number;
  body: unknown;
}

/**
 * Pure login handler: parse + validate the raw JSON body, invoke the auth
 * service, and translate the outcome (or error) into an HTTP status + body.
 * Kept transport-agnostic so it can be unit-tested without a socket.
 */
export async function handleLogin(auth: LoginCapable, rawBody: string, ip: string): Promise<RouteResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: ErrorCode.BAD_REQUEST, message: 'Invalid JSON body' } };
  }
  const validated = loginRequestSchema.safeParse(parsed);
  if (!validated.success) {
    return { status: 400, body: { error: ErrorCode.BAD_REQUEST, message: 'Invalid login request' } };
  }
  const { username, password, vaultId, deviceName } = validated.data;
  try {
    const tokens = await auth.login(username, password, vaultId, deviceName ?? '', { ip });
    return { status: 200, body: tokens };
  } catch (error) {
    if (error instanceof SyncError) {
      return { status: httpStatusForError(error.code), body: { error: error.code, message: error.message } };
    }
    return { status: 500, body: { error: ErrorCode.INTERNAL, message: 'Internal error' } };
  }
}

export async function handleRefresh(auth: LoginCapable, rawBody: string): Promise<RouteResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: ErrorCode.BAD_REQUEST, message: 'Invalid JSON body' } };
  }
  const validated = refreshRequestSchema.safeParse(parsed);
  if (!validated.success) {
    return { status: 400, body: { error: ErrorCode.BAD_REQUEST, message: 'Invalid refresh request' } };
  }
  try {
    return { status: 200, body: await auth.refresh(validated.data.refreshToken) };
  } catch (error) {
    if (error instanceof SyncError) {
      return { status: httpStatusForError(error.code), body: { error: error.code, message: error.message } };
    }
    return { status: 500, body: { error: ErrorCode.INTERNAL, message: 'Internal error' } };
  }
}

/**
 * Best-effort client IP. `X-Forwarded-For` is only honored when the deployment
 * is explicitly configured behind a trusted proxy (`trustProxy`); otherwise a
 * direct client could spoof the header to evade the login rate limiter.
 */
export function clientIp(req: http.IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (header) {
      const first = header.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req: http.IncomingMessage, limit: number): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let tooLarge = false;
    const finish = (value: { body: string; tooLarge: boolean }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        finish({ body: '', tooLarge: true });
        // Stop buffering but drain the rest so the response can flush before we
        // tear the socket down (avoids resetting the client mid-request).
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ body: Buffer.concat(chunks).toString('utf8'), tooLarge: false }));
    // Guard against a client that disconnects without emitting `end` (otherwise
    // the promise would never settle and leak the request handler).
    req.on('close', () => {
      if (!settled) reject(new Error('Request closed before body completed'));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export interface AuthRouterOptions {
  /** Honor `X-Forwarded-For` for client IP (only when behind a trusted proxy). */
  trustProxy?: boolean;
}

/**
 * Build an HTTP router for the auth endpoints. Returns a handler that resolves
 * to `true` when it owned the request (and has written a response), or `false`
 * to let the caller fall through to other routes (e.g. health checks / 404).
 */
export function createAuthRouter(auth: LoginCapable, options: AuthRouterOptions = {}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const trustProxy = options.trustProxy ?? false;
  return async (req, res) => {
    const path = req.url?.split('?', 1)[0];
    if (path !== '/auth/login' && path !== '/auth/refresh') return false;
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: ErrorCode.BAD_REQUEST, message: 'Method not allowed' });
      return true;
    }
    const { body, tooLarge } = await readBody(req, AUTH_BODY_LIMIT_BYTES);
    if (tooLarge) {
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: ErrorCode.PAYLOAD_TOO_LARGE, message: 'Request body too large' }));
      res.on('finish', () => req.destroy());
      return true;
    }
    const result = path === '/auth/login'
      ? await handleLogin(auth, body, clientIp(req, trustProxy))
      : await handleRefresh(auth, body);
    writeJson(res, result.status, result.body);
    return true;
  };
}

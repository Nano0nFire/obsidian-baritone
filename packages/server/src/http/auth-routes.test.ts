import http from 'node:http';
import { AddressInfo } from 'node:net';
import { ErrorCode, SyncError } from '@obsidian-sync/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthRouter, clientIp, handleLogin, handleRefresh, httpStatusForError, type LoginCapable } from './auth-routes.js';

const okResult = { accessToken: 'access.jwt', refreshToken: 'refresh.tok', deviceId: 'dev-1' };

function fakeAuth(login: LoginCapable['login'], refresh: LoginCapable['refresh'] = vi.fn(async () => okResult)): LoginCapable {
  return { login, refresh };
}

describe('httpStatusForError', () => {
  it('maps protocol error codes to HTTP statuses', () => {
    expect(httpStatusForError(ErrorCode.UNAUTHENTICATED)).toBe(401);
    expect(httpStatusForError(ErrorCode.TOKEN_EXPIRED)).toBe(401);
    expect(httpStatusForError(ErrorCode.FORBIDDEN)).toBe(403);
    expect(httpStatusForError(ErrorCode.DEVICE_REVOKED)).toBe(403);
    expect(httpStatusForError(ErrorCode.BAD_REQUEST)).toBe(400);
    expect(httpStatusForError(ErrorCode.RATE_LIMITED)).toBe(429);
    expect(httpStatusForError(ErrorCode.NOT_FOUND)).toBe(404);
    expect(httpStatusForError(ErrorCode.PAYLOAD_TOO_LARGE)).toBe(413);
    expect(httpStatusForError(ErrorCode.INTERNAL)).toBe(500);
  });
});

function ipReq(headers: Record<string, string | string[]>, remoteAddress?: string) {
  return { headers, socket: { remoteAddress } } as unknown as import('node:http').IncomingMessage;
}

describe('clientIp', () => {
  it('ignores X-Forwarded-For by default (untrusted), using the socket address', () => {
    expect(clientIp(ipReq({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9'))).toBe('10.0.0.9');
  });

  it('honors the left-most X-Forwarded-For hop when proxy is trusted', () => {
    expect(clientIp(ipReq({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, '10.0.0.9'), true)).toBe('1.2.3.4');
  });

  it('falls back to the socket address when trusted but no header present', () => {
    expect(clientIp(ipReq({}, '10.0.0.9'), true)).toBe('10.0.0.9');
  });

  it('returns "unknown" when nothing is available', () => {
    expect(clientIp(ipReq({}))).toBe('unknown');
  });
});

describe('handleLogin', () => {
  it('returns 200 and tokens for valid credentials, forwarding ip and deviceName', async () => {
    const login = vi.fn(async () => okResult);
    const body = JSON.stringify({ username: 'alice', password: 'pw', vaultId: 'v1', deviceName: 'Laptop' });
    const result = await handleLogin(fakeAuth(login), body, '203.0.113.7');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(okResult);
    expect(login).toHaveBeenCalledWith('alice', 'pw', 'v1', 'Laptop', { ip: '203.0.113.7' });
  });

  describe('handleRefresh', () => {
    it('returns 200 and rotated tokens for a valid refresh token', async () => {
      const refresh = vi.fn(async () => okResult);
      const result = await handleRefresh(fakeAuth(vi.fn(async () => okResult), refresh), JSON.stringify({ refreshToken: 'refresh-1' }));
      expect(result.status).toBe(200);
      expect(result.body).toEqual(okResult);
      expect(refresh).toHaveBeenCalledWith('refresh-1');
    });

    it('returns 400 when refreshToken is missing', async () => {
      const refresh = vi.fn(async () => okResult);
      const result = await handleRefresh(fakeAuth(vi.fn(async () => okResult), refresh), JSON.stringify({}));
      expect(result.status).toBe(400);
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  it('defaults deviceName to empty string and ignores unknown fields (e.g. deviceId)', async () => {
    const login = vi.fn(async () => okResult);
    const body = JSON.stringify({ username: 'a', password: 'b', vaultId: 'v1', deviceId: 'ignored' });
    const result = await handleLogin(fakeAuth(login), body, 'ip');
    expect(result.status).toBe(200);
    expect(login).toHaveBeenCalledWith('a', 'b', 'v1', '', { ip: 'ip' });
  });

  it('returns 400 for invalid JSON', async () => {
    const login = vi.fn(async () => okResult);
    const result = await handleLogin(fakeAuth(login), '{not json', 'ip');
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: ErrorCode.BAD_REQUEST });
    expect(login).not.toHaveBeenCalled();
  });

  it('returns 400 when required fields are missing', async () => {
    const login = vi.fn(async () => okResult);
    const result = await handleLogin(fakeAuth(login), JSON.stringify({ username: 'a' }), 'ip');
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: ErrorCode.BAD_REQUEST });
    expect(login).not.toHaveBeenCalled();
  });

  it('maps a SyncError(UNAUTHENTICATED) to 401 without leaking which field was wrong', async () => {
    const login = vi.fn(async () => { throw new SyncError(ErrorCode.UNAUTHENTICATED, 'Invalid username or password'); });
    const result = await handleLogin(fakeAuth(login), JSON.stringify({ username: 'a', password: 'b', vaultId: 'v1' }), 'ip');
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: ErrorCode.UNAUTHENTICATED, message: 'Invalid username or password' });
  });

  it('maps a SyncError(FORBIDDEN) to 403', async () => {
    const login = vi.fn(async () => { throw new SyncError(ErrorCode.FORBIDDEN, 'No vault access'); });
    const result = await handleLogin(fakeAuth(login), JSON.stringify({ username: 'a', password: 'b', vaultId: 'v1' }), 'ip');
    expect(result.status).toBe(403);
  });

  it('maps a SyncError(RATE_LIMITED) to 429', async () => {
    const login = vi.fn(async () => { throw new SyncError(ErrorCode.RATE_LIMITED, 'Too many login attempts'); });
    const result = await handleLogin(fakeAuth(login), JSON.stringify({ username: 'a', password: 'b', vaultId: 'v1' }), 'ip');
    expect(result.status).toBe(429);
  });

  it('maps an unknown error to 500 INTERNAL without exposing internals', async () => {
    const login = vi.fn(async () => { throw new Error('pg exploded: password=secret'); });
    const result = await handleLogin(fakeAuth(login), JSON.stringify({ username: 'a', password: 'b', vaultId: 'v1' }), 'ip');
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: ErrorCode.INTERNAL, message: 'Internal error' });
  });
});

describe('createAuthRouter (real HTTP roundtrip)', () => {
  let server: http.Server;
  let baseUrl: string;
  let loginImpl: LoginCapable['login'];

  beforeEach(async () => {
    loginImpl = async () => okResult;
    const router = createAuthRouter({ login: (...a) => loginImpl(...a), refresh: async () => okResult });
    server = http.createServer((req, res) => {
      void router(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('handles POST /auth/login end-to-end', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b', vaultId: 'v1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okResult);
  });

  it('returns 405 for non-POST on /auth/login', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('handles POST /auth/refresh end-to-end', async () => {
    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'refresh-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okResult);
  });

  it('does not handle unrelated paths (router returns false → 404)', async () => {
    const res = await fetch(`${baseUrl}/something-else`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('rejects bodies that exceed the size cap with 413', async () => {
    const huge = JSON.stringify({ username: 'a', password: 'x'.repeat(200_000), vaultId: 'v1' });
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    expect(res.status).toBe(413);
  });
});

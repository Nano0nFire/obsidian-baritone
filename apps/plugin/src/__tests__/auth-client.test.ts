import { describe, expect, it, vi } from 'vitest';
import { loginWithPassword, refreshSessionTokens } from '../auth-client.js';
import type { FetchLike } from '../http-adapter.js';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

describe('auth client', () => {
  it('posts login credentials to /auth/login', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, { accessToken: 'a', refreshToken: 'r', deviceId: 'd' }) as never);

    const result = await loginWithPassword('ws://127.0.0.1:3000/sync', { username: 'alice', password: 'pw', vaultId: 'vault-1', deviceName: 'Laptop' }, fetchImpl);

    expect(result).toEqual({ accessToken: 'a', refreshToken: 'r', deviceId: 'd' });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3000/auth/login', expect.objectContaining({ method: 'POST' }));
  });

  it('posts refresh tokens to /auth/refresh', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, { accessToken: 'a2', refreshToken: 'r2', deviceId: 'd' }) as never);

    const result = await refreshSessionTokens('ws://127.0.0.1:3000/sync', 'refresh-1', fetchImpl);

    expect(result).toEqual({ accessToken: 'a2', refreshToken: 'r2', deviceId: 'd' });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3000/auth/refresh', expect.objectContaining({ method: 'POST' }));
  });
});

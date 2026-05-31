import { ErrorCode } from '@obsidian-sync/shared';
import { describe, expect, it, vi } from 'vitest';
import { AuthService, type AuthRepository } from './service.js';
import { TokenService, type RefreshTokenRecord } from './tokens.js';

function makeRepo(): AuthRepository {
  return {
    createUser: vi.fn(),
    getUserByUsername: vi.fn(),
    createVault: vi.fn(),
    setMember: vi.fn(),
    getMember: vi.fn(),
    createDevice: vi.fn(),
    getDevice: vi.fn(),
  };
}

describe('AuthService.refresh', () => {
  it('rotates the refresh token and issues a fresh access token for a valid device/member', async () => {
    const repo = makeRepo();
    vi.mocked(repo.getDevice).mockResolvedValue({ deviceId: 'dev-1', userId: 'user-1', vaultId: 'vault-1', revoked: false });
    vi.mocked(repo.getMember).mockResolvedValue({ role: 'editor' });
    const tokens = new TokenService('secret', {
      saveRefreshToken: vi.fn(),
      getRefreshTokenByHash: vi.fn(),
      replaceRefreshToken: vi.fn(),
      revokeRefreshToken: vi.fn(),
    });
    const old: RefreshTokenRecord = {
      tokenId: 'tok-1',
      userId: 'user-1',
      deviceId: 'dev-1',
      refreshHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
      revoked: false,
    };
    vi.spyOn(tokens, 'rotateRefresh').mockImplementation(async (_token, issue) => {
      const claims = await issue(old);
      return { accessToken: `access-${claims.role}`, refreshToken: 'refresh-2' };
    });

    const service = new AuthService(repo, tokens);
    const result = await service.refresh('refresh-1');

    expect(result).toEqual({ accessToken: 'access-editor', refreshToken: 'refresh-2', deviceId: 'dev-1' });
  });

  it('rejects refresh for a revoked or missing device', async () => {
    const repo = makeRepo();
    vi.mocked(repo.getDevice).mockResolvedValue(null);
    const tokens = new TokenService('secret', {
      saveRefreshToken: vi.fn(),
      getRefreshTokenByHash: vi.fn(),
      replaceRefreshToken: vi.fn(),
      revokeRefreshToken: vi.fn(),
    });
    const old: RefreshTokenRecord = {
      tokenId: 'tok-1',
      userId: 'user-1',
      deviceId: 'dev-1',
      refreshHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
      revoked: false,
    };
    vi.spyOn(tokens, 'rotateRefresh').mockImplementation(async (_token, issue) => issue(old).then(() => ({ accessToken: 'a', refreshToken: 'b' })));

    const service = new AuthService(repo, tokens);

    await expect(service.refresh('refresh-1')).rejects.toMatchObject({ code: ErrorCode.DEVICE_REVOKED });
  });
});

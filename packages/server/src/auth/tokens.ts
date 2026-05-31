import { createHash, randomUUID } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { ErrorCode, SyncError } from '@obsidian-sync/shared';

export interface AccessClaims {
  userId: string;
  deviceId: string;
  vaultId: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface RefreshTokenRecord {
  tokenId: string;
  userId: string;
  deviceId: string;
  refreshHash: string;
  expiresAt: Date;
  revoked: boolean;
  replacedBy?: string;
}

export interface TokenRepository {
  saveRefreshToken(record: RefreshTokenRecord): Promise<void>;
  getRefreshTokenByHash(hash: string): Promise<RefreshTokenRecord | null>;
  replaceRefreshToken(hash: string, next: RefreshTokenRecord): Promise<RefreshTokenRecord | null>;
  revokeRefreshToken(tokenId: string, replacedBy?: string): Promise<void>;
}

export class TokenService {
  private readonly secret: Uint8Array;

  constructor(secret: string, private readonly repo?: TokenRepository) {
    this.secret = new TextEncoder().encode(secret);
  }

  async issueAccess(claims: AccessClaims, ttlSeconds = 900): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.secret);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'] });
      const claims = payload as Partial<AccessClaims>;
      if (!claims.userId || !claims.deviceId || !claims.vaultId || !claims.role) throw new Error('missing claims');
      return { userId: claims.userId, deviceId: claims.deviceId, vaultId: claims.vaultId, role: claims.role };
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw new SyncError(ErrorCode.TOKEN_EXPIRED, error.message);
      throw new SyncError(ErrorCode.UNAUTHENTICATED, error instanceof Error ? error.message : 'Invalid token');
    }
  }

  async issueRefresh(userId: string, deviceId: string, days = 30): Promise<{ token: string; record: RefreshTokenRecord }> {
    if (!this.repo) throw new Error('Token repository required for refresh tokens');
    const { token, record } = this.createRefreshToken(userId, deviceId, days);
    await this.repo.saveRefreshToken(record);
    return { token, record };
  }

  async rotateRefresh(token: string, issue: (old: RefreshTokenRecord) => Promise<AccessClaims>): Promise<{ accessToken: string; refreshToken: string }> {
    if (!this.repo) throw new Error('Token repository required for refresh tokens');
    const tokenHash = hashToken(token);
    const record = await this.repo.getRefreshTokenByHash(tokenHash);
    if (!record || record.revoked || record.expiresAt <= new Date()) throw new SyncError(ErrorCode.UNAUTHENTICATED, 'Invalid refresh token');
    const claims = await issue(record);
    const next = this.createRefreshToken(record.userId, record.deviceId);
    const replaced = await this.repo.replaceRefreshToken(tokenHash, next.record);
    if (!replaced) throw new SyncError(ErrorCode.UNAUTHENTICATED, 'Invalid refresh token');
    return { accessToken: await this.issueAccess(claims), refreshToken: next.token };
  }

  private createRefreshToken(userId: string, deviceId: string, days = 30): { token: string; record: RefreshTokenRecord } {
    const token = `r.${randomUUID()}.${randomUUID()}`;
    const record: RefreshTokenRecord = { tokenId: randomUUID(), userId, deviceId, refreshHash: hashToken(token), expiresAt: new Date(Date.now() + days * 86_400_000), revoked: false };
    return { token, record };
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

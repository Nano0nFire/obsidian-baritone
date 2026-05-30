import { randomUUID } from 'node:crypto';
import { ErrorCode, SyncError } from '@obsidian-sync/shared';
import { hashPassword, verifyPassword } from './password.js';
import { TokenService, type AccessClaims } from './tokens.js';
import type { Role } from '../engine/store.js';
import type { LoginRateLimiter } from '../ws/rate-limit.js';

export interface AuthRepository {
  createUser(username: string, pwHash: string): Promise<{ userId: string; username: string }>;
  getUserByUsername(username: string): Promise<{ userId: string; username: string; pwHash: string } | null>;
  createVault(name: string, ownerUserId: string): Promise<{ vaultId: string; name: string }>;
  setMember(vaultId: string, userId: string, role: Role): Promise<void>;
  getMember(vaultId: string, userId: string): Promise<{ role: Role } | null>;
  createDevice(userId: string, vaultId: string, name: string): Promise<{ deviceId: string }>;
  getDevice(deviceId: string): Promise<{ deviceId: string; userId: string; vaultId: string; revoked: boolean } | null>;
}

export interface LoginAttemptContext {
  ip?: string;
}

export class AuthService {
  constructor(private readonly repo: AuthRepository, private readonly tokens: TokenService, private readonly loginLimiter?: LoginRateLimiter) {}

  async createUser(username: string, password: string): Promise<{ userId: string; username: string }> {
    validateUsername(username);
    return this.repo.createUser(username, await hashPassword(password));
  }

  async createVault(name: string, ownerUserId: string): Promise<{ vaultId: string; name: string }> {
    if (!name || name.length > 200) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid vault name');
    return this.repo.createVault(name, ownerUserId);
  }

  async addMember(vaultId: string, actorUserId: string, targetUserId: string, role: Role): Promise<void> {
    await this.requireRole(vaultId, actorUserId, 'owner');
    if (!['owner', 'editor', 'viewer'].includes(role)) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid role');
    await this.repo.setMember(vaultId, targetUserId, role);
  }

  async login(username: string, password: string, vaultId: string, deviceName: string, context: LoginAttemptContext = {}): Promise<{ accessToken: string; refreshToken: string; deviceId: string }> {
    const ip = context.ip ?? 'unknown';
    this.loginLimiter?.assertAllowed(ip, username);
    try {
      const user = await this.repo.getUserByUsername(username);
      if (!user || !(await verifyPassword(password, user.pwHash))) throw new SyncError(ErrorCode.UNAUTHENTICATED, 'Invalid username or password');
      const member = await this.repo.getMember(vaultId, user.userId);
      if (!member) throw new SyncError(ErrorCode.FORBIDDEN, 'No vault access');
      const device = await this.repo.createDevice(user.userId, vaultId, deviceName || `device-${randomUUID()}`);
      const claims: AccessClaims = { userId: user.userId, vaultId, deviceId: device.deviceId, role: member.role };
      const refresh = await this.tokens.issueRefresh(user.userId, device.deviceId);
      this.loginLimiter?.recordSuccess(ip, username);
      return { accessToken: await this.tokens.issueAccess(claims), refreshToken: refresh.token, deviceId: device.deviceId };
    } catch (error) {
      if (error instanceof SyncError && error.code !== ErrorCode.RATE_LIMITED) this.loginLimiter?.recordFailure(ip, username);
      throw error;
    }
  }

  async requireRole(vaultId: string, userId: string, minimum: Role): Promise<Role> {
    const member = await this.repo.getMember(vaultId, userId);
    if (!member) throw new SyncError(ErrorCode.FORBIDDEN, 'No vault access');
    if (roleRank(member.role) < roleRank(minimum)) throw new SyncError(ErrorCode.FORBIDDEN, 'Insufficient role');
    return member.role;
  }

  async verifyDevice(claims: AccessClaims): Promise<void> {
    const device = await this.repo.getDevice(claims.deviceId);
    if (!device || device.revoked || device.userId !== claims.userId || device.vaultId !== claims.vaultId) throw new SyncError(ErrorCode.DEVICE_REVOKED, 'Device is not valid');
  }
}

export function roleRank(role: Role): number {
  return role === 'viewer' ? 1 : role === 'editor' ? 2 : 3;
}

function validateUsername(username: string): void {
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw new SyncError(ErrorCode.BAD_REQUEST, 'Username must be 3-64 chars: letters, digits, _, ., -');
}

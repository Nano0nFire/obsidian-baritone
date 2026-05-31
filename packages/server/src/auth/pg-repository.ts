import type { Queryable, TxFn } from '../db/pool.js';
import type { Role } from '../engine/store.js';
import type { AuthRepository } from './service.js';
import type { RefreshTokenRecord, TokenRepository } from './tokens.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

interface TransactionalQueryable extends Queryable {
  withTx?<T>(fn: TxFn<T>): Promise<T>;
}

export class PgAuthRepository implements AuthRepository, TokenRepository {
  constructor(private readonly db: TransactionalQueryable) {}

  async createUser(username: string, pwHash: string): Promise<{ userId: string; username: string }> {
    const res = await this.db.query<{ user_id: string; username: string }>('INSERT INTO users(username,pw_hash) VALUES($1,$2) RETURNING user_id,username', [username, pwHash]);
    return { userId: res.rows[0]!.user_id, username: res.rows[0]!.username };
  }
  async getUserByUsername(username: string) {
    const res = await this.db.query<{ user_id: string; username: string; pw_hash: string }>('SELECT user_id,username,pw_hash FROM users WHERE username=$1', [username]);
    const row = res.rows[0];
    return row ? { userId: row.user_id, username: row.username, pwHash: row.pw_hash } : null;
  }
  async createVault(name: string, ownerUserId: string) {
    const res = await this.db.query<{ vault_id: string; name: string }>('INSERT INTO vaults(name) VALUES($1) RETURNING vault_id,name', [name]);
    await this.setMember(res.rows[0]!.vault_id, ownerUserId, 'owner');
    return { vaultId: res.rows[0]!.vault_id, name: res.rows[0]!.name };
  }
  async setMember(vaultId: string, userId: string, role: Role): Promise<void> {
    await this.db.query('INSERT INTO vault_members(vault_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(vault_id,user_id) DO UPDATE SET role=EXCLUDED.role', [vaultId, userId, role]);
  }
  async getMember(vaultId: string, userId: string) {
    if (!isUuid(vaultId) || !isUuid(userId)) return null;
    const res = await this.db.query<{ role: Role }>('SELECT role FROM vault_members WHERE vault_id=$1 AND user_id=$2', [vaultId, userId]);
    return res.rows[0] ?? null;
  }
  async createDevice(userId: string, vaultId: string, name: string) {
    const res = await this.db.query<{ device_id: string }>('INSERT INTO devices(user_id,vault_id,name) VALUES($1,$2,$3) RETURNING device_id', [userId, vaultId, name]);
    return { deviceId: res.rows[0]!.device_id };
  }
  async getDevice(deviceId: string) {
    if (!isUuid(deviceId)) return null;
    const res = await this.db.query<{ device_id: string; user_id: string; vault_id: string; revoked: boolean }>('SELECT device_id,user_id,vault_id,revoked FROM devices WHERE device_id=$1', [deviceId]);
    const r = res.rows[0];
    return r ? { deviceId: r.device_id, userId: r.user_id, vaultId: r.vault_id, revoked: r.revoked } : null;
  }
  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    await this.db.query('INSERT INTO tokens(token_id,user_id,device_id,refresh_hash,expires_at,revoked,replaced_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [record.tokenId, record.userId, record.deviceId, record.refreshHash, record.expiresAt, record.revoked, record.replacedBy ?? null]);
  }
  async getRefreshTokenByHash(hash: string): Promise<RefreshTokenRecord | null> {
    const res = await this.db.query<{ token_id: string; user_id: string; device_id: string; refresh_hash: string; expires_at: Date; revoked: boolean; replaced_by: string | null }>('SELECT token_id,user_id,device_id,refresh_hash,expires_at,revoked,replaced_by FROM tokens WHERE refresh_hash=$1', [hash]);
    const r = res.rows[0];
    return r ? { tokenId: r.token_id, userId: r.user_id, deviceId: r.device_id, refreshHash: r.refresh_hash, expiresAt: r.expires_at, revoked: r.revoked, replacedBy: r.replaced_by ?? undefined } : null;
  }
  async replaceRefreshToken(hash: string, next: RefreshTokenRecord): Promise<RefreshTokenRecord | null> {
    return this.withTx(async (tx) => {
      const res = await tx.query<{ token_id: string; user_id: string; device_id: string; refresh_hash: string; expires_at: Date; revoked: boolean; replaced_by: string | null }>(
        'UPDATE tokens SET revoked=true,replaced_by=$2 WHERE refresh_hash=$1 AND revoked=false AND expires_at > now() RETURNING token_id,user_id,device_id,refresh_hash,expires_at,revoked,replaced_by',
        [hash, next.tokenId],
      );
      const row = res.rows[0];
      if (!row) return null;
      await tx.query(
        'INSERT INTO tokens(token_id,user_id,device_id,refresh_hash,expires_at,revoked,replaced_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [next.tokenId, next.userId, next.deviceId, next.refreshHash, next.expiresAt, next.revoked, next.replacedBy ?? null],
      );
      return {
        tokenId: row.token_id,
        userId: row.user_id,
        deviceId: row.device_id,
        refreshHash: row.refresh_hash,
        expiresAt: row.expires_at,
        revoked: row.revoked,
        replacedBy: row.replaced_by ?? undefined,
      };
    });
  }
  async revokeRefreshToken(tokenId: string, replacedBy?: string): Promise<void> {
    await this.db.query('UPDATE tokens SET revoked=true,replaced_by=$2 WHERE token_id=$1', [tokenId, replacedBy ?? null]);
  }

  private async withTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    if (this.db.withTx) return this.db.withTx(fn);
    return fn(this.db);
  }
}

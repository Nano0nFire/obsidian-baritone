import { describe, expect, it } from 'vitest';
import { PgAuthRepository } from './pg-repository.js';
import type { Queryable } from '../db/pool.js';
import type { RefreshTokenRecord } from './tokens.js';

function throwingDb(): Queryable {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    query: async () => {
      throw new Error('database should not be queried for malformed identifiers');
    },
  } as unknown as Queryable;
}

describe('PgAuthRepository identifier validation', () => {
  it('returns null from getMember when the vaultId is not a UUID (no DB hit)', async () => {
    const repo = new PgAuthRepository(throwingDb());
    const member = await repo.getMember('default', '2c351657-891e-4288-ad54-377f5cad903d');
    expect(member).toBeNull();
  });

  it('returns null from getMember when the userId is not a UUID', async () => {
    const repo = new PgAuthRepository(throwingDb());
    const member = await repo.getMember('9b5c5e47-b534-4c23-af05-f6c33daf9c38', 'not-a-uuid');
    expect(member).toBeNull();
  });

  it('returns null from getDevice when the deviceId is not a UUID', async () => {
    const repo = new PgAuthRepository(throwingDb());
    const device = await repo.getDevice('not-a-uuid');
    expect(device).toBeNull();
  });
});

describe('PgAuthRepository.replaceRefreshToken', () => {
  it('consumes the old token and inserts the replacement inside one transaction', async () => {
    const calls: string[] = [];
    const oldRecord = {
      token_id: 'old-token',
      user_id: 'user-1',
      device_id: 'device-1',
      refresh_hash: 'old-hash',
      expires_at: new Date('2030-01-01T00:00:00Z'),
      revoked: false,
      replaced_by: null,
    };
    const tx: Queryable = {
      async query(text: string) {
        calls.push(text);
        if (text.startsWith('UPDATE tokens SET revoked=true')) return { rows: [oldRecord], rowCount: 1 };
        if (text.startsWith('INSERT INTO tokens(')) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const db = {
      async query() {
        throw new Error('top-level query should not be used');
      },
      async withTx<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
        return fn(tx);
      },
    };
    const repo = new PgAuthRepository(db);
    const next: RefreshTokenRecord = {
      tokenId: 'next-token',
      userId: 'user-1',
      deviceId: 'device-1',
      refreshHash: 'next-hash',
      expiresAt: new Date('2030-02-01T00:00:00Z'),
      revoked: false,
    };

    const replaced = await repo.replaceRefreshToken('old-hash', next);

    expect(replaced).toEqual({
      tokenId: 'old-token',
      userId: 'user-1',
      deviceId: 'device-1',
      refreshHash: 'old-hash',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      revoked: false,
      replacedBy: undefined,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('UPDATE tokens SET revoked=true,replaced_by=$2');
    expect(calls[1]).toContain('INSERT INTO tokens(token_id,user_id,device_id,refresh_hash,expires_at,revoked,replaced_by)');
  });
});

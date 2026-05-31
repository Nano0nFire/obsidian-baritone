import { describe, expect, it } from 'vitest';
import { PgAuthRepository } from './pg-repository.js';
import type { Queryable } from '../db/pool.js';

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

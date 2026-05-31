import { ErrorCode, SyncError } from '@obsidian-sync/shared';
import { describe, expect, it } from 'vitest';
import { TokenService } from './tokens.js';

describe('TokenService.verifyAccess', () => {
  it('maps expired access tokens to TOKEN_EXPIRED', async () => {
    const tokens = new TokenService('secret');
    const token = await tokens.issueAccess({ userId: 'u1', deviceId: 'd1', vaultId: 'v1', role: 'owner' }, -1);

    await expect(tokens.verifyAccess(token)).rejects.toMatchObject({
      code: ErrorCode.TOKEN_EXPIRED,
    } satisfies Partial<SyncError>);
  });
});

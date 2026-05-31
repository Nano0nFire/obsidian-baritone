import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@obsidian-sync/shared';
import { SyncWebSocketServer, clientIp } from './server.js';

type HelloInvoker = {
  hello(
    socket: { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn> },
    state: object,
    msg: {
      t: 'hello';
      token: string;
      deviceId: string;
      vaultId: string;
      lastSeq: number;
      protocolVersion: number;
      clientBuild: string;
      capabilities: string[];
    },
  ): Promise<void>;
};

describe('ws clientIp', () => {
  function req(headers: http.IncomingHttpHeaders, remoteAddress = '10.0.0.9'): http.IncomingMessage {
    return {
      headers,
      socket: { remoteAddress },
    } as unknown as http.IncomingMessage;
  }

  it('ignores x-forwarded-for unless trustProxy is enabled', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }))).toBe('10.0.0.9');
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), true)).toBe('1.2.3.4');
  });
});

describe('SyncWebSocketServer hello authorization', () => {
  it('rejects hello when the device is revoked after the JWT was minted', async () => {
    const httpServer = http.createServer();
    const ws = new SyncWebSocketServer(
      httpServer,
      { currentSeq: vi.fn(async () => 0) } as never,
      { verifyAccess: vi.fn(async () => ({ userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', role: 'editor' })) } as never,
      { getDevice: vi.fn(async () => ({ deviceId: 'device-1', userId: 'user-1', vaultId: 'vault-1', revoked: true })), getMember: vi.fn(async () => ({ role: 'editor' })) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const invoker = ws as unknown as HelloInvoker;

    await expect(invoker.hello({ readyState: 1, bufferedAmount: 0, send: vi.fn() }, {}, {
      t: 'hello',
      token: 'token',
      deviceId: 'device-1',
      vaultId: 'vault-1',
      lastSeq: 0,
      protocolVersion: 1,
      clientBuild: '0.6.0',
      capabilities: [],
    })).rejects.toMatchObject({
      code: ErrorCode.DEVICE_REVOKED,
    });

    httpServer.close();
  });

  it('scopes manifest requests to the authenticated vault instead of the client-supplied vault id', async () => {
    const httpServer = http.createServer();
    const manifest = { page: vi.fn(async () => ({ t: 'manifest_page', watermarkSeq: 0, items: [], nextCursor: null })) };
    const ws = new SyncWebSocketServer(
      httpServer,
      { currentSeq: vi.fn(async () => 0), hasContentForVault: vi.fn(async () => true) } as never,
      { verifyAccess: vi.fn() } as never,
      { getDevice: vi.fn(), getMember: vi.fn() } as never,
      {} as never,
      {} as never,
      manifest as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (ws as unknown as { handleMessage(socket: object, state: object, raw: string): Promise<void> }).handleMessage(
      { readyState: 1, bufferedAmount: 0, send: vi.fn() },
      { claims: { userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', role: 'editor' }, deviceId: 'device-1', vaultId: 'vault-1' },
      JSON.stringify({ t: 'get_manifest', vaultId: 'vault-2' }),
    );

    expect(manifest.page).toHaveBeenCalledWith('vault-1', undefined);
    httpServer.close();
  });

  it('rejects content fetches for hashes not referenced by the authenticated vault', async () => {
    const httpServer = http.createServer();
    const ws = new SyncWebSocketServer(
      httpServer,
      { currentSeq: vi.fn(async () => 0), hasContentForVault: vi.fn(async () => false) } as never,
      { verifyAccess: vi.fn() } as never,
      { getDevice: vi.fn(), getMember: vi.fn() } as never,
      {} as never,
      {} as never,
      { getContent: vi.fn(async () => null) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect((ws as unknown as { handleMessage(socket: object, state: object, raw: string): Promise<void> }).handleMessage(
      { readyState: 1, bufferedAmount: 0, send: vi.fn() },
      { claims: { userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', role: 'editor' }, deviceId: 'device-1', vaultId: 'vault-1' },
      JSON.stringify({ t: 'get_content', hash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }),
    )).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });

    httpServer.close();
  });

  it('rejects repeated hello messages on the same socket', async () => {
    const httpServer = http.createServer();
    const ws = new SyncWebSocketServer(
      httpServer,
      { currentSeq: vi.fn(async () => 0), listOps: vi.fn(async () => []) } as never,
      { verifyAccess: vi.fn(async () => ({ userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', role: 'editor' })) } as never,
      { getDevice: vi.fn(async () => ({ deviceId: 'device-1', userId: 'user-1', vaultId: 'vault-1', revoked: false })), getMember: vi.fn(async () => ({ vaultId: 'vault-1', userId: 'user-1', role: 'editor' })) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { disconnect: vi.fn(async () => undefined) } as never,
    );
    const state = { messageLimiter: { assertAllowed() {} } } as never;
    const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn() };

    await (ws as unknown as { handleMessage(socket: object, state: object, raw: string): Promise<void> }).handleMessage(
      socket,
      state,
      JSON.stringify({ t: 'hello', protocolVersion: 1, token: 'token', deviceId: 'device-1', vaultId: 'vault-1', lastSeq: 0, clientBuild: '0.6.0', capabilities: [] }),
    );

    await expect((ws as unknown as { handleMessage(socket: object, state: object, raw: string): Promise<void> }).handleMessage(
      socket,
      state,
      JSON.stringify({ t: 'hello', protocolVersion: 1, token: 'token', deviceId: 'device-1', vaultId: 'vault-1', lastSeq: 0, clientBuild: '0.6.0', capabilities: [] }),
    )).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
    });

    httpServer.close();
  });

  it('rejects file ops that try to reference foreign content hashes', async () => {
    const httpServer = http.createServer();
    const opProcessor = { process: vi.fn() };
    const ws = new SyncWebSocketServer(
      httpServer,
      { currentSeq: vi.fn(async () => 0), hasContentForVault: vi.fn(async () => false) } as never,
      { verifyAccess: vi.fn() } as never,
      { getDevice: vi.fn(), getMember: vi.fn() } as never,
      opProcessor as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect((ws as unknown as { handleMessage(socket: object, state: object, raw: string): Promise<void> }).handleMessage(
      { readyState: 1, bufferedAmount: 0, send: vi.fn() },
      { claims: { userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', role: 'editor' }, deviceId: 'device-1', vaultId: 'vault-1' },
      JSON.stringify({
        t: 'file_op',
        op: {
          schemaVersion: 1,
          opId: '11111111-1111-4111-8111-111111111111',
          deviceId: 'device-1',
          deviceSeq: 1,
          vaultId: 'vault-1',
          fileId: 'file-1',
          kind: 'update',
          type: 'attachment',
          contentHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          blobRef: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          size: 10,
          newContentVV: { 'device-1': 1 },
        },
      }),
    )).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });

    expect(opProcessor.process).not.toHaveBeenCalled();
    httpServer.close();
  });
});

import http from 'node:http';
import { loadConfig } from './config.js';
import { PgDatabase } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PgOpDataStore } from './db/pg-op-store.js';
import { PgAuthRepository } from './auth/pg-repository.js';
import { TokenService } from './auth/tokens.js';
import { BlobStore } from './blob/store.js';
import { OpProcessor } from './engine/op-processor.js';
import { ConflictService } from './engine/conflict.js';
import { ManifestService } from './engine/manifest.js';
import { TrashService } from './engine/trash.js';
import { PgYjsRoomStore } from './engine/yjs.js';
import { RoomManager } from './engine/room-manager.js';
import { SyncWebSocketServer } from './ws/server.js';

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const config = loadConfig();
  const db = new PgDatabase(config.DATABASE_URL);
  await migrate(db);
  const data = new PgOpDataStore(db);
  const authRepo = new PgAuthRepository(db);
  const tokens = new TokenService(config.JWT_SECRET, authRepo);
  const opProcessor = new OpProcessor(data);
  const blobStore = new BlobStore({ endpoint: config.S3_ENDPOINT, bucket: config.S3_BUCKET, accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY, region: config.S3_REGION }, data);
  const conflicts = new ConflictService(data);
  const manifest = new ManifestService(data);
  const trash = new TrashService(data, opProcessor, config.TRASH_RETENTION_DAYS);
  const wsRef: { current?: SyncWebSocketServer } = {};
  const rooms = new RoomManager(data, new PgYjsRoomStore(db), opProcessor, {
    broadcastVault: (vaultId, _sourceDeviceId, ops) => wsRef.current?.broadcastOps(vaultId, null, ops),
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const ws = new SyncWebSocketServer(server, data, tokens, opProcessor, conflicts, manifest, trash, blobStore, rooms);
  wsRef.current = ws;
  await new Promise<void>((resolve) => server.listen(config.SERVER_PORT, resolve));
  console.log(JSON.stringify({ event: 'server_started', port: config.SERVER_PORT, publicUrl: config.PUBLIC_URL }));
  return {
    async close() {
      await ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  const shutdown = () => {
    void running?.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  startServer().then((s) => { running = s; }).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}

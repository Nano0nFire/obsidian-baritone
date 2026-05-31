import http from 'node:http';
import { ErrorCode } from '@obsidian-sync/shared';
import { loadConfig } from './config.js';
import { PgDatabase, type Queryable } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PgOpDataStore } from './db/pg-op-store.js';
import { PgAuthRepository } from './auth/pg-repository.js';
import { AuthService } from './auth/service.js';
import { TokenService } from './auth/tokens.js';
import { createAuthRouter, type LoginCapable } from './http/auth-routes.js';
import { BlobStore } from './blob/store.js';
import { OpProcessor } from './engine/op-processor.js';
import { ConflictService } from './engine/conflict.js';
import { ManifestService } from './engine/manifest.js';
import { TrashService } from './engine/trash.js';
import { PgYjsRoomStore } from './engine/yjs.js';
import { YjsGcJob } from './engine/yjs-gc.js';
import { RoomManager } from './engine/room-manager.js';
import { SyncWebSocketServer } from './ws/server.js';
import { FixedWindowRateLimiter, LoginRateLimiter } from './ws/rate-limit.js';
import { createLogger, parseLogLevel, type Logger } from './log/logger.js';

export interface ReadinessDependencies {
  db: Pick<Queryable, 'query'>;
  ws: { isReady(): boolean };
}

export interface ReadinessReport {
  ok: boolean;
  checks: { database: boolean; websocket: boolean };
}

/** Async HTTP route handler; resolves `true` when it owned (responded to) the request. */
export type AuthRouter = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

export async function checkReadiness(deps: ReadinessDependencies): Promise<ReadinessReport> {
  const checks = { database: false, websocket: deps.ws.isReady() };
  try {
    await deps.db.query('SELECT 1');
    checks.database = true;
  } catch {
    checks.database = false;
  }
  return { ok: checks.database && checks.websocket, checks };
}

export function createHttpHandler(deps: ReadinessDependencies & { authRouter?: AuthRouter }): http.RequestListener {
  return (req, res) => {
    const url = req.url?.split('?', 1)[0];
    if (url === '/healthz') {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (url === '/readyz') {
      void checkReadiness(deps).then((report) => writeJson(res, report.ok ? 200 : 503, report));
      return;
    }
    if (deps.authRouter) {
      void deps
        .authRouter(req, res)
        .then((handled) => {
          if (!handled && !res.headersSent) writeJson(res, 404, { error: 'not_found' });
        })
        .catch(() => {
          if (!res.headersSent) writeJson(res, 500, { error: ErrorCode.INTERNAL });
        });
      return;
    }
    writeJson(res, 404, { error: 'not_found' });
  };
}

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL });
  const db = new PgDatabase(config.DATABASE_URL);
  let closing = false;
  await migrate(db);
  const data = new PgOpDataStore(db);
  const authRepo = new PgAuthRepository(db);
  const tokens = new TokenService(config.JWT_SECRET, authRepo);
  const loginLimiter = new LoginRateLimiter({
    maxFailures: config.AUTH_RATE_LIMIT_MAX_FAILURES,
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    lockoutMs: config.AUTH_RATE_LIMIT_LOCKOUT_MS,
  });
  const authService: LoginCapable = new AuthService(authRepo, tokens, loginLimiter);
  const authRouter = createAuthRouter(authService, { trustProxy: config.TRUST_PROXY });
  if (!/^https:/i.test(config.PUBLIC_URL) && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(config.PUBLIC_URL)) {
    logger.warn('auth endpoint served over plain HTTP; credentials and tokens are not encrypted in transit', {
      event: 'auth_insecure_transport',
      publicUrl: config.PUBLIC_URL,
    });
  }
  const opProcessor = new OpProcessor(data);
  const blobStore = new BlobStore({ endpoint: config.S3_ENDPOINT, bucket: config.S3_BUCKET, accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY, region: config.S3_REGION }, data);
  const conflicts = new ConflictService(data);
  const manifest = new ManifestService(data);
  const trash = new TrashService(data, opProcessor, config.TRASH_RETENTION_DAYS);
  const yjsStore = new PgYjsRoomStore(db);
  const wsRef: { current?: SyncWebSocketServer } = {};
  const rooms = new RoomManager(data, yjsStore, opProcessor, {
    updateRateLimit: { maxUpdates: config.YJS_UPDATE_RATE_LIMIT_MAX, windowMs: config.YJS_UPDATE_RATE_LIMIT_WINDOW_MS },
    snapshotEveryUpdates: config.YJS_SNAPSHOT_EVERY_UPDATES,
    broadcastVault: (vaultId, _sourceDeviceId, ops) => wsRef.current?.broadcastOps(vaultId, null, ops),
    logger: logger.child({ component: 'rooms' }),
  });
  const yjsGc = new YjsGcJob(yjsStore, { retainedVersionsPerFile: config.YJS_HISTORY_RETAINED_VERSIONS, intervalMs: config.YJS_HISTORY_GC_INTERVAL_MS, logger: logger.child({ component: 'yjs-gc' }) });
  yjsGc.start();

  const server = http.createServer(createHttpHandler({ db, ws: { isReady: () => !closing && (wsRef.current?.isReady() ?? false) }, authRouter }));
  const ws = new SyncWebSocketServer(server, data, tokens, opProcessor, conflicts, manifest, trash, blobStore, rooms, {
    connectionLimiter: new FixedWindowRateLimiter({ max: config.WS_CONNECTION_RATE_LIMIT_MAX, windowMs: config.WS_CONNECTION_RATE_LIMIT_WINDOW_MS }),
    messageLimiterFactory: () => new FixedWindowRateLimiter({ max: config.WS_MESSAGE_RATE_LIMIT_MAX, windowMs: config.WS_MESSAGE_RATE_LIMIT_WINDOW_MS }),
    logger: logger.child({ component: 'ws' }),
  });
  wsRef.current = ws;
  await new Promise<void>((resolve) => server.listen(config.SERVER_PORT, resolve));
  logger.info('server started', { event: 'server_started', port: config.SERVER_PORT, publicUrl: config.PUBLIC_URL });
  return {
    async close() {
      if (closing) return;
      closing = true;
      logger.info('server shutdown started', { event: 'server_shutdown_started', timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
      await withTimeout((async () => {
        await ws.close(config.SHUTDOWN_TIMEOUT_MS);
        await yjsGc.stop();
        await rooms.closeAll('evicted');
        await closeHttpServer(server);
        await db.close();
      })(), config.SHUTDOWN_TIMEOUT_MS, logger);
      logger.info('server shutdown completed', { event: 'server_shutdown_completed' });
    },
  };
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, logger: Logger): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`shutdown timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    logger.error('server shutdown failed', { event: 'server_shutdown_failed', error });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bootstrapLogger = createLogger({ level: parseLogLevel(process.env.LOG_LEVEL) });
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootstrapLogger.info('shutdown signal received', { event: 'shutdown_signal', signal });
    void running?.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  startServer().then((s) => { running = s; }).catch((error) => {
    bootstrapLogger.error('server failed to start', { event: 'server_start_failed', error });
    process.exit(1);
  });
}

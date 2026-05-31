import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { checkReadiness, createHttpHandler, type ReadinessDependencies } from './index.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

function deps(overrides: Partial<ReadinessDependencies> = {}): ReadinessDependencies {
  return {
    db: { query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) },
    ws: { isReady: () => true },
    ...overrides,
  };
}

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return `http://127.0.0.1:${address.port}`;
}

describe('health endpoints', () => {
  it('keeps /healthz as JSON liveness', async () => {
    const baseUrl = await listen(createHttpHandler(deps()));

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns 200 from /readyz when database and websocket server are ready', async () => {
    const baseUrl = await listen(createHttpHandler(deps()));

    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, checks: { database: true, websocket: true } });
  });

  it('returns 503 from /readyz when the database check fails', async () => {
    const failingDb = { query: async () => { throw new Error('db down'); } };
    const baseUrl = await listen(createHttpHandler(deps({ db: failingDb })));

    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, checks: { database: false, websocket: true } });
  });

  it('includes websocket readiness in the readiness check', async () => {
    await expect(checkReadiness(deps({ ws: { isReady: () => false } }))).resolves.toMatchObject({ ok: false, checks: { database: true, websocket: false } });
  });

  it('delegates matching requests to the auth router', async () => {
    const handler = createHttpHandler({
      ...deps(),
      authRouter: async (req, res) => {
        if (req.url !== '/auth/login') return false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ routed: true }));
        return true;
      },
    });
    const baseUrl = await listen(handler);
    const response = await fetch(`${baseUrl}/auth/login`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ routed: true });
  });

  it('returns 404 JSON for unknown routes when an auth router declines them', async () => {
    const handler = createHttpHandler({ ...deps(), authRouter: async () => false });
    const baseUrl = await listen(handler);
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});

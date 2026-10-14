import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedHosts, registerHostGuard } from '../src/server/host.js';
import { serveDemo } from '../src/server/demo.js';
import { buildBoard, type Board, type Poller } from '../src/server/poller.js';
import { registerRoutes } from '../src/server/routes.js';
import { openStore, type Store } from '../src/store/db.js';
import type { Config } from '../src/types.js';

const HOME = 'paranext/paranext-core';
const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'me', botLogins: [], pollIntervalMs: 180000, staleAfterHours: 48,
};

let app: FastifyInstance;
let store: Store;
afterEach(async () => { await app.close(); store.close(); });

const server = async (): Promise<void> => {
  store = openStore(':memory:', HOME);
  const board: Board = buildBoard([], [], store, cfg, new Date('2026-09-11T12:00:00Z'));
  const poller: Poller = { snapshot: () => board, start() {}, stop() {}, refresh: async () => {} };
  app = Fastify();
  registerHostGuard(app, 5174);
  registerRoutes(app, poller, store);
  await app.ready();
};

const get = (url: string, host?: string) =>
  app.inject({ method: 'GET', url, headers: host === undefined ? {} : { host } });

describe('host guard', () => {
  it.each(['evil.example:5174', 'evil.example', 'localhost.evil.example:5174', 'localhost:9999', '127.0.0.1', ''])(
    'refuses a read with Host %j',
    async (host) => {
      await server();
      expect((await get('/api/board', host)).statusCode).toBe(403);
    },
  );

  it.each([
    'localhost:5174', '127.0.0.1:5174', '[::1]:5174', 'localhost:5173', '127.0.0.1:5173', 'LOCALHOST:5173',
  ])('lets a read with Host %s through', async (host) => {
    await server();
    expect((await get('/api/board', host)).statusCode).toBe(200);
  });

  it('refuses writes from a rebound host too, even with the dashboard header', async () => {
    await server();
    const response = await app.inject({
      method: 'POST', url: '/api/pr/paranext/paranext-core/1/discord',
      headers: { host: 'evil.example:5174', 'x-pr-dashboard': '1' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('accepts exactly the loopback names on the API and web ports', () => {
    expect(allowedHosts(5174, 5173).sort()).toEqual([
      '127.0.0.1:5173', '127.0.0.1:5174', '[::1]:5173', '[::1]:5174', 'localhost:5173', 'localhost:5174',
    ]);
  });

  it('guards demo mode on whatever port it bound', async () => {
    store = openStore(':memory:', HOME);
    app = await serveDemo(0);
    const port = (app.server.address() as AddressInfo).port;
    const read = (host: string) => app.inject({ method: 'GET', url: '/api/board', headers: { host } });
    expect((await read(`localhost:${port}`)).statusCode).toBe(200);
    expect((await read(`evil.example:${port}`)).statusCode).toBe(403);
  });
});

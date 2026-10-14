import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBoard, type Board, type Poller } from '../src/server/poller.js';
import { registerRoutes, type Runner } from '../src/server/routes.js';
import { serveDemo } from '../src/server/demo.js';
import { createSessionService } from '../src/sessions/service.js';
import type { ListDeps } from '../src/sessions/list.js';
import { openStore, type Store } from '../src/store/db.js';
import { prKey } from '../src/pr-key.js';
import type { Config, PrInput, SessionsConfig } from '../src/types.js';

const HOME = 'paranext/paranext-core';
const STUDIO = 'paranext/paratext-10-studio';
const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'me', botLogins: [], pollIntervalMs: 180000, staleAfterHours: 48,
};

const pr = (over: Partial<PrInput>): PrInput => ({
  repo: HOME, number: 1, title: 'Fix the thing', url: `https://github.com/${HOME}/pull/1`,
  author: 'me', updatedAt: '2026-09-10T00:00:00Z', isDraft: false, headOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviews: [], comments: [],
  commits: [{
    oid: 'abc', committedDate: '2026-09-01T00:00:00Z', authorLogin: 'me',
    authorEmail: null, messageHeadline: 'work', parentCount: 1,
  }],
  threads: [], checks: [], ...over,
});

const listDeps = (agents: unknown[]): ListDeps => ({
  exec: async (file) => {
    if (file === 'git') throw new Error('no git in tests');
    return JSON.stringify(agents);
  },
  readText: () => null,
  env: {},
  homeDir: '/home/me',
});

const AGENTS = [{
  pid: 7, id: 'abc12345', cwd: '/work/it\'s here', kind: 'background', startedAt: 1,
  sessionId: 'uuid-1', name: 'Session #1', status: 'busy', state: 'working',
}];

const ALLOWED = { 'x-pr-dashboard': '1' };

interface Harness {
  app: FastifyInstance;
  store: Store;
  runner: { exec: ReturnType<typeof vi.fn>; spawnDetached: ReturnType<typeof vi.fn> };
  refreshPoller: ReturnType<typeof vi.fn>;
  setNow: (ms: number) => void;
}

const harness = async (
  sessionsConfig: SessionsConfig | undefined,
  prs: PrInput[] = [pr({})],
  reviewing: PrInput[] = [],
): Promise<Harness> => {
  const store = openStore(':memory:', HOME);
  const board: Board = buildBoard(prs, [], store, cfg, new Date('2026-09-11T12:00:00Z'), reviewing);
  const refreshPoller = vi.fn(async () => {});
  const poller: Poller = {
    snapshot: () => board, start: () => {}, stop: () => {}, refresh: refreshPoller,
  };
  const runner = {
    exec: vi.fn(async () => 'started job 9\n'),
    spawnDetached: vi.fn(async () => {}),
  };
  let now = 1_000_000;
  const service = sessionsConfig === undefined
    ? undefined : createSessionService(sessionsConfig, listDeps(AGENTS));
  await service?.refresh();
  const app = Fastify();
  registerRoutes(app, poller, store, {
    sessions: service === undefined || sessionsConfig === undefined
      ? undefined : { service, config: sessionsConfig },
    runner: runner as unknown as Runner,
    now: () => now,
  });
  await app.ready();
  return { app, store, runner, refreshPoller, setNow: (ms) => { now = ms; } };
};

const open: SessionsConfig = {
  openTerminalCommand: ['wt.exe', '--title', '{name}', '{claudeCommand}', 'attach', '{id}', '--cd={cwd}', '{sessionId}'],
  claudeCommand: '/bin/claude',
  repoPaths: { [HOME]: '/home/me/core' },
};

let h: Harness;
afterEach(async () => { await h.app.close(); h.store.close(); });

describe('GET /api/board', () => {
  it('merges the session listing into the board', async () => {
    h = await harness(open);
    const response = await h.app.inject({ method: 'GET', url: '/api/board' });
    const board = response.json<Board>();
    expect(board.items[0]?.sessions.map((s) => s.id)).toEqual(['abc12345']);
    expect(board.sessionActions).toEqual({ openTerminal: true, startSession: true });
    expect(board.items[0]?.canStartSession).toBe(true);
  });

  it('serves an empty, session-free board when the feature is off', async () => {
    h = await harness(undefined);
    const board = (await h.app.inject({ method: 'GET', url: '/api/board' })).json<Board>();
    expect(board.items[0]?.sessions).toEqual([]);
    expect(board.sessionActions).toEqual({ openTerminal: false, startSession: false });
    expect(board.sessionsError).toBeNull();
  });
});

describe('CSRF guard', () => {
  const posts = [
    '/api/pr/paranext/paranext-core/1/discord',
    '/api/sessions/abc12345/open-terminal',
    '/api/pr/paranext/paranext-core/1/start-session',
  ];

  beforeEach(async () => { h = await harness(open); });

  it.each(posts)('rejects %s without the header', async (url) => {
    const response = await h.app.inject({ method: 'POST', url });
    expect(response.statusCode).toBe(403);
    expect(h.runner.exec).not.toHaveBeenCalled();
    expect(h.runner.spawnDetached).not.toHaveBeenCalled();
  });

  it.each(posts)('rejects %s from a foreign origin even with the header', async (url) => {
    for (const origin of ['https://evil.example', 'http://localhost:5174', 'null', 'http://localhost:5173.evil.example']) {
      const response = await h.app.inject({
        method: 'POST', url, headers: { ...ALLOWED, origin },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(h.runner.exec).not.toHaveBeenCalled();
    expect(h.runner.spawnDetached).not.toHaveBeenCalled();
  });

  it.each(posts)('rejects %s when the header has the wrong value', async (url) => {
    const response = await h.app.inject({ method: 'POST', url, headers: { 'x-pr-dashboard': '0' } });
    expect(response.statusCode).toBe(403);
  });

  it('lets the board origins through with the header', async () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const response = await h.app.inject({
        method: 'POST', url: '/api/pr/paranext/paranext-core/1/discord',
        headers: { ...ALLOWED, origin },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('lets a request with no origin through with the header', async () => {
    const response = await h.app.inject({
      method: 'POST', url: '/api/pr/paranext/paranext-core/1/discord', headers: ALLOWED,
    });
    expect(response.statusCode).toBe(200);
  });

  it('writes the Discord stamp only for a guarded request', async () => {
    await h.app.inject({ method: 'POST', url: '/api/pr/paranext/paranext-core/1/discord' });
    expect(h.store.getDiscordPostedAt(prKey(HOME, 1))).toBeNull();
    await h.app.inject({
      method: 'POST', url: '/api/pr/paranext/paranext-core/1/discord', headers: ALLOWED,
    });
    expect(h.store.getDiscordPostedAt(prKey(HOME, 1))).not.toBeNull();
  });

  it('does not guard reads', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/board' });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /api/sessions/:id/open-terminal', () => {
  it('404s for a session that is not in the current listing', async () => {
    h = await harness(open);
    const response = await h.app.inject({
      method: 'POST', url: '/api/sessions/deadbeef/open-terminal', headers: ALLOWED,
    });
    expect(response.statusCode).toBe(404);
    expect(h.runner.spawnDetached).not.toHaveBeenCalled();
  });

  it('runs the configured argv with values from the listing, with no shell', async () => {
    h = await harness(open);
    const response = await h.app.inject({
      method: 'POST', url: '/api/sessions/abc12345/open-terminal', headers: ALLOWED,
    });
    expect(response.statusCode).toBe(202);
    expect(h.runner.spawnDetached).toHaveBeenCalledTimes(1);
    expect(h.runner.spawnDetached).toHaveBeenCalledWith('wt.exe', [
      '--title', 'Session #1', '/bin/claude', 'attach', 'abc12345', "--cd=/work/it's here", 'uuid-1',
    ]);
  });

  it('ignores anything in the request body or query that tries to steer the command', async () => {
    h = await harness(open);
    await h.app.inject({
      method: 'POST', url: '/api/sessions/abc12345/open-terminal?cwd=/evil&id=x',
      headers: { ...ALLOWED, 'content-type': 'application/json' },
      payload: JSON.stringify({ cwd: '/evil', name: 'evil', argv: ['rm'] }),
    });
    const argv = h.runner.spawnDetached.mock.calls[0]!;
    expect(JSON.stringify(argv)).not.toContain('evil');
  });

  it('404s when no terminal command is configured', async () => {
    h = await harness({ ...open, openTerminalCommand: undefined });
    const response = await h.app.inject({
      method: 'POST', url: '/api/sessions/abc12345/open-terminal', headers: ALLOWED,
    });
    expect(response.statusCode).toBe(404);
    expect(h.runner.spawnDetached).not.toHaveBeenCalled();
  });

  it('reports a launch failure', async () => {
    h = await harness(open);
    h.runner.spawnDetached.mockRejectedValueOnce(new Error('spawn wt.exe ENOENT'));
    const response = await h.app.inject({
      method: 'POST', url: '/api/sessions/abc12345/open-terminal', headers: ALLOWED,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'spawn wt.exe ENOENT' });
  });

  it('404s when the sessions feature is off', async () => {
    h = await harness(undefined);
    const response = await h.app.inject({
      method: 'POST', url: '/api/sessions/abc12345/open-terminal', headers: ALLOWED,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/pr/:owner/:name/:number/start-session', () => {
  const url = (repo: string, n: number) => `/api/pr/${repo}/${n}/start-session`;
  const start = (path: string) => h.app.inject({ method: 'POST', url: path, headers: ALLOWED });

  it('404s for a PR that is not on the board', async () => {
    h = await harness(open);
    expect((await start(url(HOME, 99))).statusCode).toBe(404);
    expect(h.runner.exec).not.toHaveBeenCalled();
  });

  it('rejects a repo with no local clone configured', async () => {
    h = await harness(open, [pr({}), pr({ repo: STUDIO, number: 5, url: `https://github.com/${STUDIO}/pull/5` })]);
    const response = await start(url(STUDIO, 5));
    expect(response.statusCode).toBe(400);
    expect(h.runner.exec).not.toHaveBeenCalled();
  });

  it('rejects a malformed PR number and repo', async () => {
    h = await harness(open);
    expect((await start(url(HOME, 0))).statusCode).toBe(400);
    expect((await start('/api/pr/paranext/par%20x/1/start-session')).statusCode).toBe(400);
  });

  it('starts a background session in the repo clone with the name and prompt filled in', async () => {
    h = await harness(
      { ...open, startPrompt: 'Review {repo}#{number} by {author}: {title} {url}' },
    );
    const response = await start(url(HOME, 1));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, output: 'started job 9' });
    expect(h.runner.exec).toHaveBeenCalledWith(
      '/bin/claude',
      ['--bg', '--name', 'paranext-core #1 Fix the thing',
        `Review ${HOME}#1 by me: Fix the thing https://github.com/${HOME}/pull/1`],
      expect.objectContaining({ cwd: '/home/me/core', timeout: 30_000 }),
    );
  });

  it('starts sessions for the Others\' PRs too', async () => {
    h = await harness(
      { ...open, repoPaths: { [STUDIO]: '/home/me/studio' } }, [],
      [pr({ repo: STUDIO, number: 5, author: 'alice', url: `https://github.com/${STUDIO}/pull/5` })],
    );
    expect((await start(url(STUDIO, 5))).statusCode).toBe(200);
    expect(h.runner.exec.mock.calls[0]?.[2]).toMatchObject({ cwd: '/home/me/studio' });
  });

  it('shortens a long title in the session name only', async () => {
    const title = 'x'.repeat(100);
    h = await harness(open, [pr({ title })]);
    await start(url(HOME, 1));
    const args = h.runner.exec.mock.calls[0]![1] as string[];
    expect(args[2]!.length).toBeLessThanOrEqual('paranext-core #1 '.length + 60);
    expect(args[3]).toContain(title);
  });

  it('keeps a prompt that starts with a dash from being read as a flag', async () => {
    h = await harness({ ...open, startPrompt: '--dangerous {title}' });
    await start(url(HOME, 1));
    const args = h.runner.exec.mock.calls[0]![1] as string[];
    expect(args[3]!.startsWith('-')).toBe(false);
  });

  it('truncates the CLI output it returns to 2 KB', async () => {
    h = await harness(open);
    h.runner.exec.mockResolvedValueOnce('y'.repeat(5000));
    const output = (await start(url(HOME, 1))).json<{ output: string }>().output;
    expect(output.length).toBeLessThanOrEqual(2048);
  });

  it('allows one start per PR per minute, and a retry after a failure', async () => {
    h = await harness(open);
    expect((await start(url(HOME, 1))).statusCode).toBe(200);
    h.setNow(1_000_000 + 30_000);
    expect((await start(url(HOME, 1))).statusCode).toBe(429);
    expect(h.runner.exec).toHaveBeenCalledTimes(1);
    h.setNow(1_000_000 + 61_000);
    h.runner.exec.mockRejectedValueOnce(new Error('claude exploded'));
    const failed = await start(url(HOME, 1));
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: 'claude exploded' });
    expect((await start(url(HOME, 1))).statusCode).toBe(200);
  });

  it('404s when the sessions feature is off', async () => {
    h = await harness(undefined);
    expect((await start(url(HOME, 1))).statusCode).toBe(404);
  });
});

describe('demo mode', () => {
  it('refuses the session actions and guards the Discord write', async () => {
    h = await harness(undefined);
    const demo = await serveDemo(0);
    const base = `http://127.0.0.1:${(demo.server.address() as AddressInfo).port}`;
    const post = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: 'POST', headers });
    expect((await post('/api/sessions/x/open-terminal', ALLOWED)).status).toBe(404);
    expect((await post('/api/pr/paranext/paranext-core/2717/start-session', ALLOWED)).status).toBe(404);
    expect((await post('/api/pr/paranext/paranext-core/2717/discord')).status).toBe(403);
    expect((await post('/api/pr/paranext/paranext-core/2717/discord', ALLOWED)).status).toBe(200);
    await demo.close();
  });
});

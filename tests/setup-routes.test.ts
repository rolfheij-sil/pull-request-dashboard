import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBoard, type Board, type Poller } from '../src/server/poller.js';
import { registerRoutes, type Runner } from '../src/server/routes.js';
import type { ListDeps } from '../src/sessions/list.js';
import { createSessionService } from '../src/sessions/service.js';
import type { DetectDeps } from '../src/setup/detect.js';
import { createSetupService } from '../src/setup/service.js';
import { writeSaved } from '../src/setup/settings.js';
import { openStore, type Store } from '../src/store/db.js';
import type { Config, SessionsConfig } from '../src/types.js';

const HOME = 'paranext/paranext-core';
const CLAUDE = '/home/me/.local/bin/claude';
const cfg: Config = {
  repoPath: '/g/core', owner: 'paranext', name: 'paranext-core',
  me: 'me', botLogins: [], pollIntervalMs: 180000, staleAfterHours: 48,
};
const ALLOWED = { 'x-pr-dashboard': '1' };

/** A machine with Terminal and iTerm (macOS) or two Linux terminals, and two clones. */
const machine = (platform: NodeJS.Platform): DetectDeps => {
  const remotes: Record<string, string> = {
    '/g/core': 'git@github.com:paranext/paranext-core.git',
    '/g/studio': 'https://github.com/paranext/paratext-10-studio.git',
  };
  return {
    platform, arch: 'x64', env: { PATH: '/bin', TERMINAL: 'alpha' }, homeDir: '/home/me',
    readText: () => null,
    isExecutable: (file) => ['/bin/claude', '/bin/alpha', '/bin/x-terminal-emulator'].includes(file),
    exists: (file) => [
      '/Applications/Utilities/Terminal.app', '/Applications/iTerm.app',
    ].includes(file),
    isDirectory: (file) => file in remotes,
    listDirs: () => [],
    exec: async (file, args) => {
      if (file === 'git') {
        const dir = args[1]!;
        if (args[2] === 'remote' && remotes[dir] !== undefined) return remotes[dir]!;
        throw new Error('git: nothing');
      }
      return '2.1.299 (Claude Code)';
    },
  };
};

const listDeps = (): ListDeps => ({
  exec: async (file) => {
    if (file === 'git') throw new Error('no git');
    return JSON.stringify([{
      pid: 7, id: 'abc12345', cwd: '/work', kind: 'background', startedAt: 1,
      sessionId: 'uuid-1', name: 'Session', status: 'busy', state: 'working',
    }, {
      pid: 8, cwd: '/work', kind: 'interactive', startedAt: 2,
      sessionId: 'uuid-2', name: 'Interactive', status: 'idle', state: 'done',
    }]);
  },
  readText: () => null, env: {}, homeDir: '/home/me',
});

interface Harness {
  app: FastifyInstance;
  store: Store;
  runner: { exec: ReturnType<typeof vi.fn>; spawnDetached: ReturnType<typeof vi.fn> };
  setup: ReturnType<typeof createSetupService>;
}

let h: Harness;
let dbPath = '';

const harness = async (options: {
  configSessions?: SessionsConfig;
  platform?: NodeJS.Platform;
  store?: Store;
} = {}): Promise<Harness> => {
  const store = options.store ?? openStore(':memory:', HOME);
  const board: Board = buildBoard([], [], store, cfg, new Date('2026-09-11T12:00:00Z'));
  const poller: Poller = { snapshot: () => board, start() {}, stop() {}, refresh: async () => {} };
  const deps = machine(options.platform ?? 'darwin');
  const service = createSessionService(() => setup.effective().sessions, listDeps());
  const setup = createSetupService({
    configSessions: options.configSessions, repoPath: '/g/core', store,
    liveSessions: () => service.snapshot().sessions,
    deps,
  });
  await setup.redetect();
  await service.refresh();
  const runner = { exec: vi.fn(async () => ''), spawnDetached: vi.fn(async () => {}) };
  const app = Fastify();
  registerRoutes(app, poller, store, { sessions: service, setup, runner: runner as unknown as Runner });
  await app.ready();
  return { app, store, runner, setup };
};

afterEach(async () => { await h.app.close(); h.store.close(); });

const put = (body: unknown, headers: Record<string, string> = ALLOWED) =>
  h.app.inject({ method: 'PUT', url: '/api/setup', headers, payload: body as object });

describe('GET /api/setup', () => {
  it('reports what was detected, what is saved and what is in effect', async () => {
    h = await harness({ configSessions: { startPrompt: 'Fixed {url}' } });
    const body = (await h.app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(body.detected.claude).toMatchObject({ path: '/bin/claude', version: '2.1.299 (Claude Code)' });
    expect(body.detected.desktopResume).toBe(true);
    expect(body.saved).toEqual({});
    expect(body.effective).toMatchObject({
      terminalPreset: 'macos-terminal', openTerminalSource: 'detected', startPrompt: 'Fixed {url}',
    });
    expect(body.effective.repoPaths).toEqual({});
    expect(body.lockedByConfig).toEqual(['startPrompt']);
  });
});

describe('PUT /api/setup', () => {
  it('needs the dashboard header and a board origin', async () => {
    h = await harness();
    expect((await put({ primaryAction: 'copy' }, {})).statusCode).toBe(403);
    expect((await put({ primaryAction: 'copy' }, { ...ALLOWED, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(h.setup.saved()).toEqual({});
  });

  it('saves valid choices and reports the new effective settings', async () => {
    h = await harness();
    const response = await put({
      primaryAction: 'copy', terminalPreset: 'iterm', startPrompt: 'Look at {url}',
      repoPaths: { 'Paranext/Paratext-10-Studio': '/g/studio' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().effective).toMatchObject({
      primaryAction: 'copy', terminalPreset: 'iterm', openTerminalSource: 'panel',
      startPrompt: 'Look at {url}',
    });
    expect(h.setup.saved()).toEqual({
      primaryAction: 'copy', terminalPreset: 'iterm', startPrompt: 'Look at {url}',
      repoPaths: { 'paranext/paratext-10-studio': '/g/studio' },
    });
  });

  it('puts the saved choices to work on the board', async () => {
    h = await harness();
    await put({ primaryAction: 'terminal', terminalPreset: 'iterm' });
    const board = (await h.app.inject({ method: 'GET', url: '/api/board' })).json<Board>();
    expect(board.primaryAction).toBe('terminal');
    expect(board.sessionActions).toMatchObject({ openTerminal: true, openDesktop: true });
  });

  it('persists across reopening the database', async () => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'prd-')), 'saved.db');
    h = await harness({ store: openStore(dbPath, HOME) });
    expect((await put({ primaryAction: 'copy', repoPaths: { [HOME]: '/g/core' } })).statusCode).toBe(200);
    h.store.close();
    const reopened = openStore(dbPath, HOME);
    const setup = createSetupService({
      configSessions: undefined, repoPath: '/g/core', store: reopened, deps: machine('darwin'),
    });
    expect(setup.saved()).toEqual({ primaryAction: 'copy', repoPaths: { [HOME]: '/g/core' } });
    h.store = reopened;
  });

  it.each([
    ['openTerminalCommand', ['rm', '-rf', '/']],
    ['argv', ['x']],
    ['command', 'rm -rf /'],
    ['claudeCommand', '/evil'],
  ])('rejects %s, saving nothing', async (field, value) => {
    h = await harness();
    const response = await put({ primaryAction: 'copy', [field]: value });
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[field]).toMatch(/not a setting/);
    expect(h.setup.saved()).toEqual({});
  });

  it('rejects a bad primary action, and desktop where it is unavailable', async () => {
    h = await harness({ platform: 'linux' });
    expect((await put({ primaryAction: 'teleport' })).json().errors.primaryAction).toMatch(/one of/);
    const desktop = await put({ primaryAction: 'desktop' });
    expect(desktop.statusCode).toBe(400);
    expect(desktop.json().errors.primaryAction).toMatch(/desktop/);
  });

  it('accepts desktop where it is available', async () => {
    h = await harness({ platform: 'darwin' });
    expect((await put({ primaryAction: 'desktop' })).statusCode).toBe(200);
  });

  it('rejects a terminal that was not detected', async () => {
    h = await harness();
    const response = await put({ terminalPreset: 'rm -rf' });
    expect(response.json().errors.terminalPreset).toMatch(/detected/);
  });

  it('rejects over-long or unknown-placeholder prompts', async () => {
    h = await harness();
    expect((await put({ startPrompt: 'x'.repeat(2001) })).json().errors.startPrompt).toMatch(/2000/);
    expect((await put({ startPrompt: 'Run {cwd}' })).json().errors.startPrompt).toMatch(/\{cwd\}/);
    expect((await put({ startPrompt: 'x'.repeat(2000) })).statusCode).toBe(200);
  });

  it('rejects folders that are relative, missing, or a clone of another repo, per field', async () => {
    h = await harness();
    const response = await put({
      repoPaths: {
        'paranext/paranext-core': 'g/core',
        'paranext/paratext-10-studio': '/g/missing',
        'paranext/other': '/g/studio',
        'not a repo': '/g/core',
      },
    });
    expect(response.statusCode).toBe(400);
    const { errors } = response.json();
    expect(errors['repoPaths.paranext/paranext-core']).toMatch(/absolute/);
    expect(errors['repoPaths.paranext/paratext-10-studio']).toMatch(/exists/);
    expect(errors['repoPaths.paranext/other']).toMatch(/not paranext\/other/);
    expect(errors['repoPaths.not a repo']).toMatch(/owner\/name/);
    expect(h.setup.saved()).toEqual({});
  });

  it('forgets a folder saved as empty', async () => {
    h = await harness();
    await put({ repoPaths: { [HOME]: '/g/core' } });
    await put({ repoPaths: { [HOME]: '' } });
    expect(h.setup.saved().repoPaths).toBeUndefined();
  });

  it('rejects fields config.json sets, saving nothing', async () => {
    h = await harness({ configSessions: {
      openTerminalCommand: ['mine', '{id}'], startPrompt: 'Mine', repoPaths: { [HOME]: '/g/core' },
    } });
    const response = await put({
      primaryAction: 'copy', terminalPreset: 'iterm', startPrompt: 'Other',
      repoPaths: { [HOME]: '/g/core', 'paranext/paratext-10-studio': '/g/studio' },
    });
    expect(response.statusCode).toBe(400);
    const { errors } = response.json();
    expect(errors.terminalPreset).toMatch(/config\.json/);
    expect(errors.startPrompt).toMatch(/config\.json/);
    expect(errors[`repoPaths.${HOME}`]).toBeUndefined();
    expect(errors['repoPaths.paranext/paratext-10-studio']).toBeUndefined();
    expect(h.setup.saved()).toEqual({});
  });

  it('keeps an unchanged saved folder without checking it, so an unrelated save succeeds', async () => {
    h = await harness();
    writeSaved(h.store, { repoPaths: { [HOME]: '/g/no-longer-there' } });
    const response = await put({
      primaryAction: 'copy', repoPaths: { [HOME]: '/g/no-longer-there' },
    });
    expect(response.statusCode).toBe(200);
    expect(h.setup.saved()).toEqual({
      primaryAction: 'copy', repoPaths: { [HOME]: '/g/no-longer-there' },
    });
  });

  it('still checks a folder that is new or changed', async () => {
    h = await harness();
    writeSaved(h.store, { repoPaths: { [HOME]: '/g/core' } });
    const changed = await put({ repoPaths: { [HOME]: '/g/missing' } });
    expect(changed.statusCode).toBe(400);
    expect(changed.json().errors[`repoPaths.${HOME}`]).toMatch(/exists/);
    expect(h.setup.saved().repoPaths).toEqual({ [HOME]: '/g/core' });
  });

  it('drops a saved folder for a repo config.json has since taken over, without an error', async () => {
    h = await harness({ configSessions: { repoPaths: { [HOME]: '/g/core' } } });
    writeSaved(h.store, { repoPaths: { [HOME]: '/g/old' } });
    const response = await put({ primaryAction: 'copy', repoPaths: { [HOME]: '/g/old' } });
    expect(response.statusCode).toBe(200);
    expect(h.setup.saved()).toEqual({ primaryAction: 'copy' });
    expect(response.json().effective.repoPaths[HOME]).toBe('/g/core');
  });

  it('clears a stale saved folder for a repo that is not on the board', async () => {
    h = await harness();
    writeSaved(h.store, { repoPaths: { 'o/gone': '/g/gone', [HOME]: '/g/core' } });
    const response = await put({ repoPaths: { 'o/gone': '', [HOME]: '/g/core' } });
    expect(response.statusCode).toBe(200);
    expect(h.setup.saved().repoPaths).toEqual({ [HOME]: '/g/core' });
  });

  it('rejects a body that is not an object', async () => {
    h = await harness();
    const response = await h.app.inject({
      method: 'PUT', url: '/api/setup', headers: { ...ALLOWED, 'content-type': 'application/json' },
      payload: '["copy"]',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('detection progress', () => {
  it('reports detecting until the first detection has finished', async () => {
    const store = openStore(':memory:', HOME);
    const setup = createSetupService({
      configSessions: undefined, repoPath: '/g/core', store, deps: machine('linux'),
    });
    expect(setup.detecting()).toBe(true);
    expect(setup.detected().claude.path).toBeNull();
    const running = setup.redetect();
    expect(setup.detecting()).toBe(true);
    await running;
    expect(setup.detecting()).toBe(false);
    expect(setup.detected().claude.path).toBe('/bin/claude');
    store.close();
  });

  it('puts the flag in the setup response', async () => {
    h = await harness();
    const body = (await h.app.inject({ method: 'GET', url: '/api/setup' })).json();
    expect(body.detecting).toBe(false);
  });
});

describe('POST /api/setup/redetect', () => {
  it('needs the dashboard header, and returns the fresh setup', async () => {
    h = await harness();
    expect((await h.app.inject({ method: 'POST', url: '/api/setup/redetect' })).statusCode).toBe(403);
    const response = await h.app.inject({ method: 'POST', url: '/api/setup/redetect', headers: ALLOWED });
    expect(response.statusCode).toBe(200);
    expect(response.json().detected.claude.path).toBe('/bin/claude');
  });
});

describe('POST /api/sessions/:id/open-desktop', () => {
  const open = (id: string, headers: Record<string, string> = ALLOWED) =>
    h.app.inject({ method: 'POST', url: `/api/sessions/${id}/open-desktop`, headers });

  it('needs the dashboard header', async () => {
    h = await harness({ platform: 'darwin' });
    expect((await open('abc12345', {})).statusCode).toBe(403);
    expect(h.runner.spawnDetached).not.toHaveBeenCalled();
  });

  it('resumes a listed session in the desktop app with the exact argv', async () => {
    h = await harness({ platform: 'darwin' });
    expect((await open('abc12345')).statusCode).toBe(202);
    expect(h.runner.spawnDetached).toHaveBeenCalledWith('/bin/claude', ['--desktop', '--resume', 'uuid-1']);
  });

  it('finds an interactive session by its full session id', async () => {
    h = await harness({ platform: 'darwin' });
    expect((await open('uuid-2')).statusCode).toBe(202);
    expect(h.runner.spawnDetached).toHaveBeenCalledWith('/bin/claude', ['--desktop', '--resume', 'uuid-2']);
  });

  it('404s for a session that is not listed', async () => {
    h = await harness({ platform: 'darwin' });
    expect((await open('deadbeef')).statusCode).toBe(404);
    expect(h.runner.spawnDetached).not.toHaveBeenCalled();
  });

  it('404s where the desktop app is unavailable', async () => {
    h = await harness({ platform: 'linux' });
    expect((await open('abc12345')).statusCode).toBe(404);
    expect(h.runner.spawnDetached).not.toHaveBeenCalled();
  });

  it('resolves {claudeCommand} in a detected terminal to the detected CLI', async () => {
    h = await harness({ platform: 'darwin' });
    await h.app.inject({
      method: 'POST', url: '/api/sessions/abc12345/open-terminal', headers: ALLOWED,
    });
    const argv = h.runner.spawnDetached.mock.calls[0]!;
    expect(argv[0]).toBe('osascript');
    expect((argv[1] as string[]).slice(-3)).toEqual(['/work', '/bin/claude', 'abc12345']);
  });

  it('resolves {claudeCommand} in a detected terminal to the CLI config.json names', async () => {
    h = await harness({ platform: 'darwin', configSessions: { claudeCommand: '/opt/claude' } });
    await h.app.inject({
      method: 'POST', url: '/api/sessions/abc12345/open-terminal', headers: ALLOWED,
    });
    const argv = h.runner.spawnDetached.mock.calls[0]!;
    expect((argv[1] as string[]).slice(-3)).toEqual(['/work', '/opt/claude', 'abc12345']);
  });

  it('uses the CLI named in config.json', async () => {
    h = await harness({ platform: 'darwin', configSessions: { claudeCommand: '/opt/claude' } });
    await open('abc12345');
    expect(h.runner.spawnDetached.mock.calls[0]?.[0]).toBe('/opt/claude');
  });
});

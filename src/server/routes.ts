import { execFile, spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { NO_SESSION_ACTIONS, type Board, type Poller } from './poller.js';
import type { Store } from '../store/db.js';
import type { SetupService } from '../setup/service.js';
import { prKey } from '../pr-key.js';
import { attachSessions, findRepoPath } from '../sessions/match.js';
import type { SessionService } from '../sessions/service.js';
import { fillArgv, shellQuote } from '../sessions/template.js';
import { startPreview } from '../sessions/start.js';
import { requireDashboardRequest } from './csrf.js';
import { isGithubName, parsePrNumber } from './params.js';

const START_SESSION_TIMEOUT_MS = 30_000;
const START_SESSION_COOLDOWN_MS = 60_000;
const OUTPUT_MAX_CHARS = 2048;

/** Process launching, injectable so tests can assert the exact argv without running anything. */
export interface Runner {
  /** Runs a program without a shell; resolves with its stdout, rejects on failure or timeout. */
  exec(file: string, args: string[], options: { cwd?: string; timeout: number }): Promise<string>;
  /** Starts a program without a shell, detached from the server; resolves once it has started. */
  spawnDetached(file: string, args: string[]): Promise<void>;
}

export const defaultRunner: Runner = {
  exec: (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }),
  spawnDetached: (file, args) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  }),
};

export interface RoutesOptions {
  /** The session listing; sessions are off on the board without it. */
  sessions?: SessionService;
  /** Detection, saved choices and the effective sessions configuration. */
  setup?: SetupService;
  runner?: Runner;
  webPort?: number;
  /** Epoch milliseconds; injectable for the start-session cooldown. */
  now?: () => number;
}

/** The `/api/setup` payload: what was detected, what is saved, and what is in effect. */
function setupResponse(setup: SetupService) {
  const effective = setup.effective();
  return {
    detected: setup.detected(),
    detecting: setup.detecting(),
    saved: setup.saved(),
    effective: {
      primaryAction: effective.primaryAction,
      terminalPreset: effective.terminalPreset,
      repoPaths: effective.repoPaths,
      startPrompt: effective.startPrompt,
      openTerminalSource: effective.openTerminalSource,
    },
    lockedByConfig: effective.lockedByConfig,
  };
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Only a CLI killed by the start timeout can have created a session without saying so. */
const wasKilled = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (('killed' in error && error.killed === true)
    || ('signal' in error && typeof error.signal === 'string' && error.signal !== ''));

/** Everything the failed CLI printed or the launcher reported, for matching known failures. */
function failureText(error: unknown): string {
  const parts = [errorMessage(error)];
  if (typeof error === 'object' && error !== null) {
    for (const key of ['stderr', 'stdout'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string') parts.push(value);
    }
  }
  return parts.join('\n');
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function registerRoutes(
  app: FastifyInstance, poller: Poller, store: Store, options: RoutesOptions = {},
): void {
  const { setup } = options;
  const runner = options.runner ?? defaultRunner;
  const now = options.now ?? Date.now;
  const guard = requireDashboardRequest(options.webPort);

  /** The sessions pieces when the feature is on, else null. */
  const active = () => {
    if (options.sessions === undefined || setup === undefined) return null;
    const effective = setup.effective();
    if (effective.sessions.enabled === false) return null;
    return { service: options.sessions, effective, config: effective.sessions };
  };

  const withSessions = (board: Board): Board => {
    const on = active();
    if (on === null) return board;
    const { config, effective } = on;
    const listing = on.service.snapshot();
    return {
      ...attachSessions(board, listing.sessions, {
        error: listing.error,
        repoPaths: config.repoPaths,
        startPrompt: config.startPrompt,
        actions: {
          openTerminal: config.openTerminalCommand !== undefined,
          openDesktop: effective.desktopResume,
          startSession: Object.keys(config.repoPaths ?? {}).length > 0,
        },
      }),
      primaryAction: effective.primaryAction,
    };
  };

  app.get('/api/board', async (_request, reply) => {
    const board = poller.snapshot();
    if (board === null) {
      return reply.send({
        items: [], reviewing: [], branches: [],
        yourCourtCount: 0, myCourtCount: 0, reviewCourtCount: 0,
        fetchedAt: null, stale: true, error: 'no data yet — retrying',
        notifications: [], epoch: '',
        sessionsError: null, sessionActions: NO_SESSION_ACTIONS, primaryAction: 'copy',
      } satisfies Board);
    }
    return reply.send(withSessions(board));
  });

  app.post<{ Params: { owner: string; name: string; number: string }; Body: { posted: boolean } }>(
    '/api/pr/:owner/:name/:number/discord',
    { preHandler: guard },
    async (request, reply) => {
      const { owner, name } = request.params;
      const number = parsePrNumber(request.params.number);
      if (number === null) {
        return reply.code(400).send({ error: 'bad PR number' });
      }
      if (!isGithubName(owner) || !isGithubName(name)) {
        return reply.code(400).send({ error: 'bad repo' });
      }
      store.setDiscordPostedAt(
        prKey(`${owner}/${name}`, number),
        request.body?.posted === false ? null : new Date().toISOString(),
      );
      await poller.refresh();
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/open-terminal',
    { preHandler: guard },
    async (request, reply) => {
      const on = active();
      const command = on?.config.openTerminalCommand;
      if (on === null || command === undefined) {
        return reply.code(404).send({ error: 'opening terminals is not available' });
      }
      // Only sessions in the current listing can be opened, and every value
      // substituted into the argv comes from that listing, never from the request.
      const session = on.service.findById(request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'unknown session' });

      // A line break or NUL in a folder name cannot be passed on safely.
      if (/[\r\n\0]/.test(session.cwd)) {
        return reply.code(400).send({
          error: "this session's folder name contains a line break or NUL character, so a terminal cannot be opened for it",
        });
      }

      const values = {
        id: session.id ?? '',
        sessionId: session.sessionId,
        cwd: session.cwd,
        name: session.name,
        claudeCommand: on.config.claudeCommand ?? 'claude',
      };
      const argv = fillArgv(command, values);
      try {
        await runner.spawnDetached(argv[0]!, argv.slice(1));
      } catch (error) {
        return reply.code(500).send({ error: errorMessage(error) });
      }
      return reply.code(202).send({ ok: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/open-desktop',
    { preHandler: guard },
    async (request, reply) => {
      const on = active();
      if (on === null || !on.effective.desktopResume) {
        return reply.code(404).send({ error: 'the desktop app is not available' });
      }
      // The id is a short id or a full session id; either must name a listed session.
      const session = on.service.findById(request.params.id)
        ?? on.service.findBySessionId(request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'unknown session' });
      try {
        await runner.spawnDetached(
          on.config.claudeCommand ?? 'claude', ['--desktop', '--resume', session.sessionId],
        );
      } catch (error) {
        return reply.code(500).send({ error: errorMessage(error) });
      }
      return reply.code(202).send({ ok: true });
    },
  );

  app.post(
    '/api/setup/redetect',
    { preHandler: guard },
    async (_request, reply) => {
      if (setup === undefined) return reply.code(404).send({ error: 'setup is not available' });
      await options.sessions?.refresh();
      await setup.redetect();
      return reply.send(setupResponse(setup));
    },
  );

  app.get('/api/setup', async (_request, reply) => {
    if (setup === undefined) return reply.code(404).send({ error: 'setup is not available' });
    return reply.send(setupResponse(setup));
  });

  app.put(
    '/api/setup',
    { preHandler: guard },
    async (request, reply) => {
      if (setup === undefined) return reply.code(404).send({ error: 'setup is not available' });
      const result = await setup.save(request.body);
      if (!result.ok) return reply.code(400).send({ errors: result.errors });
      return reply.send(setupResponse(setup));
    },
  );

  const lastStartedAt = new Map<string, number>();

  app.post<{ Params: { owner: string; name: string; number: string } }>(
    '/api/pr/:owner/:name/:number/start-session',
    { preHandler: guard },
    async (request, reply) => {
      const on = active();
      if (on === null) {
        return reply.code(404).send({ error: 'sessions are not available' });
      }
      const { owner, name } = request.params;
      const number = parsePrNumber(request.params.number);
      if (number === null) return reply.code(400).send({ error: 'bad PR number' });
      if (!isGithubName(owner) || !isGithubName(name)) {
        return reply.code(400).send({ error: 'bad repo' });
      }

      const board = poller.snapshot();
      const key = prKey(`${owner}/${name}`, number);
      const item = [...(board?.items ?? []), ...(board?.reviewing ?? [])]
        .find((candidate) => prKey(candidate.repo, candidate.number) === key);
      if (item === undefined) return reply.code(404).send({ error: 'PR is not on the board' });

      const repoPath = findRepoPath(on.config.repoPaths, item.repo);
      if (repoPath === null) {
        return reply.code(400).send({ error: `no local clone configured for ${item.repo}` });
      }

      const last = lastStartedAt.get(key);
      if (last !== undefined && now() - last < START_SESSION_COOLDOWN_MS) {
        return reply.code(429).send({ error: 'a session was just started for this PR' });
      }

      const { name: sessionName, prompt } = startPreview(item, on.config.startPrompt);

      lastStartedAt.set(key, now());
      try {
        const stdout = await runner.exec(
          on.config.claudeCommand ?? 'claude',
          // A leading space keeps a prompt that starts with "-" from being read as a flag.
          ['--bg', '--name', sessionName, prompt.startsWith('-') ? ` ${prompt}` : prompt],
          { cwd: repoPath, timeout: START_SESSION_TIMEOUT_MS },
        );
        await on.service.refresh();
        return reply.send({ ok: true, output: truncate(stdout.trim(), OUTPUT_MAX_CHARS) });
      } catch (error) {
        const text = failureText(error);
        const message = truncate(text, OUTPUT_MAX_CHARS);
        if (wasKilled(error)) {
          // A timeout may come after the session was created, so the cooldown
          // stays to keep a retry from starting a duplicate.
          return reply.code(500).send({
            error: `${message} — the session may still have started; check the board in a few seconds`,
          });
        }
        // The CLI could not start, or ran and reported that it started nothing.
        lastStartedAt.delete(key);
        if (/workspace not trusted/i.test(text)) {
          // Trust is the user's to grant; the server never edits Claude Code's settings.
          return reply.code(409).send({
            error: 'untrusted-workspace',
            folder: repoPath,
            command: `cd -- ${shellQuote(repoPath)} && claude`,
          });
        }
        return reply.code(500).send({ error: message });
      }
    },
  );
}

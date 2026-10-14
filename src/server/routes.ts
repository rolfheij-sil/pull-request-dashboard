import { execFile, spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { NO_SESSION_ACTIONS, type Board, type Poller } from './poller.js';
import type { Store } from '../store/db.js';
import type { SessionsConfig } from '../types.js';
import { prKey } from '../pr-key.js';
import { attachSessions, findRepoPath } from '../sessions/match.js';
import type { SessionService } from '../sessions/service.js';
import { fillTemplate } from '../sessions/template.js';
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
  /** Present when the sessions feature is on. */
  sessions?: { service: SessionService; config: SessionsConfig };
  runner?: Runner;
  webPort?: number;
  /** Epoch milliseconds; injectable for the start-session cooldown. */
  now?: () => number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function registerRoutes(
  app: FastifyInstance, poller: Poller, store: Store, options: RoutesOptions = {},
): void {
  const { sessions } = options;
  const runner = options.runner ?? defaultRunner;
  const now = options.now ?? Date.now;
  const guard = requireDashboardRequest(options.webPort);

  const withSessions = (board: Board): Board => {
    if (sessions === undefined) return board;
    const { config } = sessions;
    const listing = sessions.service.snapshot();
    return attachSessions(board, listing.sessions, {
      error: listing.error,
      repoPaths: config.repoPaths,
      startPrompt: config.startPrompt,
      actions: {
        openTerminal: config.openTerminalCommand !== undefined,
        startSession: Object.keys(config.repoPaths ?? {}).length > 0,
      },
    });
  };

  app.get('/api/board', async (_request, reply) => {
    const board = poller.snapshot();
    if (board === null) {
      return reply.send({
        items: [], reviewing: [], branches: [],
        yourCourtCount: 0, myCourtCount: 0, reviewCourtCount: 0,
        fetchedAt: null, stale: true, error: 'no data yet — retrying',
        notifications: [], epoch: '',
        sessionsError: null, sessionActions: NO_SESSION_ACTIONS,
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
      const command = sessions?.config.openTerminalCommand;
      if (sessions === undefined || command === undefined) {
        return reply.code(404).send({ error: 'opening terminals is not configured' });
      }
      // Only sessions in the current listing can be opened, and every value
      // substituted into the argv comes from that listing, never from the request.
      const session = sessions.service.findById(request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'unknown session' });

      const values = {
        id: session.id ?? '',
        sessionId: session.sessionId,
        cwd: session.cwd,
        name: session.name,
        claudeCommand: sessions.config.claudeCommand ?? 'claude',
      };
      const argv = command.map((element) => fillTemplate(element, values));
      try {
        await runner.spawnDetached(argv[0]!, argv.slice(1));
      } catch (error) {
        return reply.code(500).send({ error: errorMessage(error) });
      }
      return reply.code(202).send({ ok: true });
    },
  );

  const lastStartedAt = new Map<string, number>();

  app.post<{ Params: { owner: string; name: string; number: string } }>(
    '/api/pr/:owner/:name/:number/start-session',
    { preHandler: guard },
    async (request, reply) => {
      if (sessions === undefined) {
        return reply.code(404).send({ error: 'sessions are not configured' });
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

      const repoPath = findRepoPath(sessions.config.repoPaths, item.repo);
      if (repoPath === null) {
        return reply.code(400).send({ error: `no local clone configured for ${item.repo}` });
      }

      const last = lastStartedAt.get(key);
      if (last !== undefined && now() - last < START_SESSION_COOLDOWN_MS) {
        return reply.code(429).send({ error: 'a session was just started for this PR' });
      }

      const { name: sessionName, prompt } = startPreview(item, sessions.config.startPrompt);

      lastStartedAt.set(key, now());
      try {
        const stdout = await runner.exec(
          sessions.config.claudeCommand ?? 'claude',
          // A leading space keeps a prompt that starts with "-" from being read as a flag.
          ['--bg', '--name', sessionName, prompt.startsWith('-') ? ` ${prompt}` : prompt],
          { cwd: repoPath, timeout: START_SESSION_TIMEOUT_MS },
        );
        await sessions.service.refresh();
        return reply.send({ ok: true, output: truncate(stdout.trim(), OUTPUT_MAX_CHARS) });
      } catch (error) {
        lastStartedAt.delete(key);
        return reply.code(500).send({ error: truncate(errorMessage(error), OUTPUT_MAX_CHARS) });
      }
    },
  );
}

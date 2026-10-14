/**
 * A board built from the captured fixtures in tests/fixtures/, served without
 * touching GitHub, `gh`, a local clone, Claude, or your notification state.
 *
 * It exists so a teammate can see what the dashboard looks like before wiring
 * up a config of their own, and so the README screenshot is reproducible.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { buildBoard, type Board } from './poller.js';
import { openStore, type Store } from '../store/db.js';
import { prKey, repoFromUrl } from '../pr-key.js';
import { requireDashboardRequest } from './csrf.js';
import { isGithubName, parsePrNumber } from './params.js';
import type { BranchInput, Config, PrInput } from '../types.js';

/** The PRs captured by scripts/capture-fixtures.ts. */
const FIXTURES = [2717, 2720, 2664, 2742, 2795, 2796, 2687, 2635, 2180];

/**
 * The config the fixtures were captured against. `repoPath` is never read:
 * demo mode supplies its own branches rather than shelling into a clone.
 */
export const DEMO_CONFIG: Config = {
  repoPath: '/nonexistent',
  owner: 'paranext',
  name: 'paranext-core',
  me: 'jolierabideau',
  botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180_000,
  staleAfterHours: 48,
};

/**
 * Pinned so the board — and therefore the screenshot — is identical on every
 * run. The fixtures were captured around this moment, so relative ages read
 * sensibly against it. The client reads its ages off `fetchedAt` rather than
 * the wall clock, so the card ages stay pinned to this moment too.
 */
export const DEMO_NOW = new Date('2026-09-11T12:00:00Z');

const DEMO_BRANCHES: BranchInput[] = [
  { name: 'feature/paratext-sync', upstreamGone: false, aheadOfMain: 3, prNumber: null },
  { name: 'fix/menu-crash', upstreamGone: true, aheadOfMain: 1, prNumber: null },
];

const DEMO_HOME_REPO = `${DEMO_CONFIG.owner}/${DEMO_CONFIG.name}`;

/**
 * Fixtures captured before PRs carried a `repo`, `author` or review requests
 * get the repo from their URL; every fixture is one of the demo user's own PRs.
 */
const loadFixture = (n: number): PrInput => {
  const fixture = JSON.parse(
    readFileSync(new URL(`../../tests/fixtures/pr-${n}.json`, import.meta.url), 'utf8'),
  ) as Partial<PrInput> & Pick<PrInput, 'url'>;
  return {
    ...fixture,
    repo: fixture.repo ?? repoFromUrl(fixture.url),
    author: fixture.author ?? DEMO_CONFIG.me,
    updatedAt: fixture.updatedAt ?? DEMO_NOW.toISOString(),
    headRefName: fixture.headRefName ?? null,
  } as PrInput;
};

/**
 * Builds the demo board. Pass a `store` to keep the Discord state between
 * builds; without one, an in-memory store is opened and closed per call.
 * Either way demo mode never reads or writes the real notification and
 * Discord state in pr-dashboard.db.
 */
export function buildDemoBoard(store?: Store): Board {
  const scratch = store ?? openStore(':memory:', DEMO_HOME_REPO);
  try {
    return buildBoard(FIXTURES.map(loadFixture), DEMO_BRANCHES, scratch, DEMO_CONFIG, DEMO_NOW);
  } finally {
    if (store === undefined) scratch.close();
  }
}

export async function serveDemo(port: number): Promise<FastifyInstance> {
  // Held open for the life of the process so that clicking "Posted to
  // Discord" actually moves the card, as it does on the real board.
  const store = openStore(':memory:', DEMO_HOME_REPO);
  let board = buildDemoBoard(store);

  const app = Fastify({ logger: false });
  app.get('/api/board', async (_request, reply) => reply.send(board));

  // Demo mode never touches Claude Code or the machine's processes.
  const sessionsDisabled = async (_request: unknown, reply: FastifyReply) =>
    reply.code(404).send({ error: 'sessions are disabled in demo mode' });
  app.post('/api/sessions/:id/open-terminal', sessionsDisabled);
  app.post('/api/pr/:owner/:name/:number/start-session', sessionsDisabled);

  app.post<{ Params: { owner: string; name: string; number: string }; Body: { posted: boolean } }>(
    '/api/pr/:owner/:name/:number/discord',
    { preHandler: requireDashboardRequest() },
    async (request, reply) => {
      const number = parsePrNumber(request.params.number);
      if (number === null) {
        return reply.code(400).send({ error: 'bad PR number' });
      }
      if (!isGithubName(request.params.owner) || !isGithubName(request.params.name)) {
        return reply.code(400).send({ error: 'bad repo' });
      }
      // Stamped with the pinned clock, not the wall clock, so the receipt
      // ("posted to Discord Nh ago") stays reproducible.
      store.setDiscordPostedAt(
        prKey(`${request.params.owner}/${request.params.name}`, number),
        request.body?.posted === false ? null : DEMO_NOW.toISOString(),
      );
      board = buildDemoBoard(store);
      return reply.send({ ok: true });
    },
  );

  await app.listen({ port, host: '127.0.0.1' });
  return app;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 5174);
  await serveDemo(port);
  console.log(`Demo board (${FIXTURES.length} captured PRs) on http://127.0.0.1:${port}`);
  console.log('No GitHub access, no notifications, no writes to your database.');
}

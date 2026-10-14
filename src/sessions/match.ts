import { prKey } from '../pr-key.js';
import { startPreview } from './start.js';
import type { Board, BoardItem } from '../server/poller.js';
import type {
  LinkedSession, MatchedBy, SessionActions, SessionInfo,
} from './types.js';

/** Branches that many PRs and sessions share; never evidence that a session is about one PR. */
const SHARED_BRANCHES = new Set(['main', 'master']);

const STRENGTH: Record<MatchedBy, number> = { recorded: 4, url: 3, branch: 2, number: 1 };

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_]/.test(char);

/** True when `text` contains `url` and the URL does not continue (`/pull/28` inside `/pull/288`). */
function containsUrl(text: string, url: string): boolean {
  const haystack = text.toLowerCase();
  const needle = url.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (!isWordChar(haystack[at + needle.length])) return true;
    from = at + 1;
  }
}

/** Every `#123` written as a whole token (so `#28800` is 28800, never 288 or 2880). */
function hashNumbers(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.matchAll(/(?<![\w&])#(\d+)(?!\w)/g)) found.add(Number(match[1]));
  return found;
}

/** The `repoPaths` entry for a repo; GitHub repo names are case-insensitive. */
export function findRepoPath(
  repoPaths: Record<string, string> | undefined, repo: string,
): string | null {
  const wanted = repo.toLowerCase();
  for (const [key, path] of Object.entries(repoPaths ?? {})) {
    if (key.toLowerCase() === wanted) return path;
  }
  return null;
}

type Target = Pick<BoardItem, 'repo' | 'number' | 'url' | 'headRefName' | 'isCrossRepository'>;

/**
 * A branch name links a session to a PR only when the PR's head branch lives in
 * the PR's own repo (not a fork), and the session either is running now or had
 * its branch recorded by its job; a finished session's current checkout says
 * nothing about what it worked on.
 */
function branchMatches(session: SessionInfo, item: Target, repo: string): boolean {
  if (item.isCrossRepository || item.headRefName === null) return false;
  if (SHARED_BRANCHES.has(item.headRefName) || session.repo !== repo) return false;
  if (session.status === null && session.branchSource !== 'job') return false;
  return session.branch === item.headRefName;
}

/** The strongest way `session` is tied to the PR, or null when it is not. */
export function matchOne(
  session: SessionInfo,
  item: Target,
  /** How many board items, across both tabs, carry this PR number. */
  itemsWithNumber: number,
): MatchedBy | null {
  const repo = item.repo.toLowerCase();
  if (session.prLinks.includes(prKey(item.repo, item.number))) return 'recorded';

  const text = `${session.name}\n${session.intent}`;
  if (containsUrl(text, item.url)) return 'url';

  if (branchMatches(session, item, repo)) return 'branch';

  // A session in another repo never matches by number; one whose repo is unknown
  // matches only when no other board item carries the same number.
  if (
    hashNumbers(text).has(item.number)
    && (session.repo === repo || (session.repo === null && itemsWithNumber === 1))
  ) {
    return 'number';
  }
  return null;
}

/** 0 = live and active, 1 = live and idle, 2 = no live process. */
const rank = (session: SessionInfo): number => {
  if (session.status === null) return 2;
  return session.status === 'idle' ? 1 : 0;
};

const toLinked = (session: SessionInfo, matchedBy: MatchedBy): LinkedSession => ({
  id: session.id,
  sessionId: session.sessionId,
  name: session.name,
  kind: session.kind,
  status: session.status,
  state: session.state,
  cwd: session.cwd,
  matchedBy,
  claudeAiUrl: session.claudeAiUrl,
});

/** The sessions linked to one PR, strongest evidence kept per session, in display order. */
export function linkSessions(
  item: Target, sessions: SessionInfo[], itemsWithNumber: number,
): LinkedSession[] {
  const linked: { session: SessionInfo; matchedBy: MatchedBy }[] = [];
  for (const session of sessions) {
    const matchedBy = matchOne(session, item, itemsWithNumber);
    if (matchedBy !== null) linked.push({ session, matchedBy });
  }
  linked.sort((a, b) => (
    rank(a.session) - rank(b.session) || b.session.startedAt - a.session.startedAt
  ));
  return linked.map(({ session, matchedBy }) => toLinked(session, matchedBy));
}

export interface AttachContext {
  /** Why the session listing failed, or null. */
  error: string | null;
  actions: SessionActions;
  repoPaths?: Record<string, string>;
  startPrompt?: string;
}

/** A copy of `board` with each item's linked sessions and start-session availability filled in. */
export function attachSessions(
  board: Board, sessions: SessionInfo[], context: AttachContext,
): Board {
  const all = [...board.items, ...board.reviewing];
  const numberCounts = new Map<number, number>();
  for (const item of all) numberCounts.set(item.number, (numberCounts.get(item.number) ?? 0) + 1);

  const canStart = (item: BoardItem): boolean =>
    findRepoPath(context.repoPaths, item.repo) !== null;

  const withSessions = (item: BoardItem): BoardItem => ({
    ...item,
    sessions: linkSessions(item, sessions, numberCounts.get(item.number) ?? 0),
    canStartSession: canStart(item),
    startPreview: canStart(item) ? startPreview(item, context.startPrompt) : null,
  });

  return {
    ...board,
    items: board.items.map(withSessions),
    reviewing: board.reviewing.map(withSessions),
    sessionsError: context.error,
    sessionActions: context.actions,
  };
}

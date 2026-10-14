import { randomUUID } from 'node:crypto';
import { classify } from '../rules/classify.js';
import { classifyReviewing } from '../rules/reviewing.js';
import { checkDot } from '../rules/checks.js';
import { resolveEscalation } from '../claude/escalate.js';
import { fetchOpenPrs, fetchReviewingPrs } from '../github/client.js';
import { readBranches } from '../git/branches.js';
import { notifyKey } from '../rules/notify.js';
import { prKey } from '../pr-key.js';
import { notify } from '../notify/osascript.js';
import type { Store } from '../store/db.js';
import type { LinkedSession, PrimaryAction, SessionActions } from '../sessions/types.js';
import type { StartPreview } from '../sessions/start.js';
import type {
  BranchInput, Bucket, Classification, Config, PrInput,
} from '../types.js';

export interface BoardItem extends Classification {
  /** `owner/name` of the PR's repo; with `number` it identifies the PR. */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Login of the PR's author. */
  author: string;
  /** Whether the user wrote the PR or is reviewing someone else's. */
  role: 'author' | 'reviewer';
  isDraft: boolean;
  checkDot: 'fail' | 'pending' | 'pass' | 'none';
  /** The PR's head branch; null when unknown. Sessions on that branch are linked to the PR. */
  headRefName: string | null;
  /** Local Claude Code sessions working on this PR. Filled in by `attachSessions`. */
  sessions: LinkedSession[];
  /** A local clone is configured for this PR's repo, so a session can be started for it. */
  canStartSession: boolean;
  /** What "Start session" would create for this PR; null exactly when `canStartSession` is false. */
  startPreview: StartPreview | null;
  /** Carried so the notify key can be recomputed after a verdict moves a bucket. */
  discordPostedAt: string | null;
}

export interface BranchItem {
  name: string;
  bucket: Extract<Bucket, 'unsubmitted-branch' | 'dead-branch'>;
}

/** A notification the server decided to fire; browsers replay these. */
export interface NotificationEvent {
  /** Monotonic within one server process, starting at 1. */
  id: number;
  title: string;
  body: string;
  url: string;
  at: string;
}

const NOTIFICATION_LOG_SIZE = 50;

export interface Board {
  /** PRs the user wrote. */
  items: BoardItem[];
  /** Other people's PRs the user has reviewed or commented on. */
  reviewing: BoardItem[];
  branches: BranchItem[];
  /** Everything waiting on the user: `myCourtCount` + `reviewCourtCount`. */
  yourCourtCount: number;
  /** The user's own PRs that are in their court. */
  myCourtCount: number;
  /** Other people's PRs waiting on the user's review. */
  reviewCourtCount: number;
  /** Null only on the board shell served before the first poll lands. */
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  /** The last notifications fired, newest last. */
  notifications: NotificationEvent[];
  /** Identifies the server process; event ids restart when it changes. */
  epoch: string;
  /** Why Claude Code sessions could not be listed; null when they could or the feature is off. */
  sessionsError: string | null;
  /** Which session buttons the client may offer. */
  sessionActions: SessionActions;
  /** The session button each card puts first. */
  primaryAction: PrimaryAction;
}

export const NO_SESSION_ACTIONS: SessionActions = {
  openTerminal: false, openDesktop: false, startSession: false,
};

const ORDER: Bucket[] = [
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
  'waiting-on-reviewer', 'asked-no-looks', 'not-asked', 'draft',
  'unsubmitted-branch', 'dead-branch',
];

const REVIEW_ORDER: Bucket[] = [
  'review-needs-you', 'review-waiting-on-author', 'review-approved', 'review-quiet',
];

const YOUR_COURT: Set<Bucket> = new Set([
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
]);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function sortItems(board: Board): void {
  board.items.sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket));
  board.reviewing.sort(
    (a, b) => REVIEW_ORDER.indexOf(a.bucket) - REVIEW_ORDER.indexOf(b.bucket),
  );
}

function countCourts(board: Board): void {
  board.myCourtCount = board.items.filter((i) => YOUR_COURT.has(i.bucket)).length;
  board.reviewCourtCount = board.reviewing.filter((i) => i.bucket === 'review-needs-you').length;
  board.yourCourtCount = board.myCourtCount + board.reviewCourtCount;
}

export function buildBoard(
  prs: PrInput[],
  branches: BranchInput[],
  store: Store,
  cfg: Config,
  now: Date,
  reviewingPrs: PrInput[] = [],
): Board {
  const boardFields = (pr: PrInput, role: BoardItem['role']) => ({
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    role,
    isDraft: pr.isDraft,
    checkDot: checkDot(pr.checks),
    headRefName: pr.headRefName ?? null,
    sessions: [],
    canStartSession: false,
    startPreview: null,
  });

  const items: BoardItem[] = prs.map((pr) => {
    const local = { discordPostedAt: store.getDiscordPostedAt(prKey(pr.repo, pr.number)) };
    return {
      ...classify(pr, local, cfg, now),
      ...boardFields(pr, 'author'),
      discordPostedAt: local.discordPostedAt,
    };
  });

  // A PR that somehow turns up on both sides stays on the author side only.
  const mine = new Set(prs.map((pr) => prKey(pr.repo, pr.number)));
  const reviewing: BoardItem[] = reviewingPrs
    .filter((pr) => !mine.has(prKey(pr.repo, pr.number)))
    .map((pr) => ({
      ...classifyReviewing(pr, cfg, now),
      ...boardFields(pr, 'reviewer'),
      discordPostedAt: null,
    }));

  const board: Board = {
    items,
    reviewing,
    branches: branches.map((b) => ({
      name: b.name,
      bucket: b.upstreamGone ? ('dead-branch' as const) : ('unsubmitted-branch' as const),
    })),
    yourCourtCount: 0,
    myCourtCount: 0,
    reviewCourtCount: 0,
    fetchedAt: now.toISOString(),
    stale: false,
    error: null,
    notifications: [],
    epoch: '',
    sessionsError: null,
    sessionActions: NO_SESSION_ACTIONS,
    primaryAction: 'copy',
  };
  sortItems(board);
  countCourts(board);
  return board;
}

export interface Poller {
  snapshot(): Board | null;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

export function createPoller(cfg: Config, store: Store): Poller {
  let board: Board | null = null;
  let timer: NodeJS.Timeout | null = null;
  let generation = 0;
  let stopped = false;
  const epoch = randomUUID();
  const log: NotificationEvent[] = [];
  let nextEventId = 1;
  const record = (event: Omit<NotificationEvent, 'id' | 'at'>): void => {
    log.push({ ...event, id: nextEventId++, at: new Date().toISOString() });
    if (log.length > NOTIFICATION_LOG_SIZE) log.splice(0, log.length - NOTIFICATION_LOG_SIZE);
  };

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    const superseded = () => stopped || mine !== generation;
    const commit = (next: Board): void => {
      // A slower earlier refresh must never overwrite a newer snapshot,
      // and nothing may land after stop().
      if (superseded()) return;
      board = next;
    };

    try {
      const [ownResult, reviewingResult] = await Promise.allSettled([
        fetchOpenPrs(cfg), fetchReviewingPrs(cfg),
      ]);
      // Without the user's own PRs there is no board to build.
      if (ownResult.status === 'rejected') throw ownResult.reason;
      const prs = ownResult.value;
      // No branch-to-PR correlation is asserted for the local branch list;
      // `headRefName` is carried on each item for session matching only.
      const branches = readBranches(cfg.repoPath, new Set<string>());
      const next = buildBoard(
        prs, branches, store, cfg, new Date(),
        reviewingResult.status === 'fulfilled' ? reviewingResult.value : [],
      );
      if (reviewingResult.status === 'rejected') {
        // The Others' PRs list is kept from the previous board rather than
        // blanked, and the board says so.
        next.reviewing = board?.reviewing ?? [];
        next.error = `Others' PRs not refreshed — ${errorMessage(reviewingResult.reason)}`;
        sortItems(next);
        countCourts(next);
      }

      await attachVerdicts(next, prs, store);
      if (superseded()) return;
      sendNotifications(next, store, cfg, record);
      next.notifications = [...log];
      next.epoch = epoch;
      commit(next);
    } catch (error) {
      const message = errorMessage(error);
      const staleBoard: Board = board === null
        ? {
            items: [],
            reviewing: [],
            branches: [],
            yourCourtCount: 0,
            myCourtCount: 0,
            reviewCourtCount: 0,
            fetchedAt: new Date().toISOString(),
            stale: true,
            error: message,
            notifications: [...log],
            epoch,
            sessionsError: null,
            sessionActions: NO_SESSION_ACTIONS,
            primaryAction: 'copy',
          }
        : { ...board, stale: true, error: message };
      commit(staleBoard);
    }
  };

  return {
    snapshot: () => board,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), cfg.pollIntervalMs);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
    },
    refresh,
  };
}

async function attachVerdicts(
  board: Board, prs: PrInput[], store: Store,
): Promise<void> {
  for (const item of board.items) {
    if (item.escalate === null || item.escalateReviewId === null) continue;
    const pr = prs.find((p) => prKey(p.repo, p.number) === prKey(item.repo, item.number));
    // Resolve the exact review classify escalated on, not merely the newest.
    const review = pr?.reviews.find((r) => r.id === item.escalateReviewId);
    if (!review) continue;

    const verdict = await resolveEscalation(review, item.escalate, store);
    if (verdict === null) {
      item.receipts.push('tie-break unavailable — showing the rules-only result');
      continue;
    }
    item.verdict = verdict;
    item.receipts.push(`Claude: ball is in ${verdict.court === 'me' ? 'your' : 'their'} court`);

    // A red build or a conflict is the user's court whatever a review says.
    if (item.bucket === 'blocked-mechanically') continue;

    const from = item.bucket;
    const to: Bucket = verdict.court === 'me' ? 'needs-your-response' : 'waiting-on-reviewer';
    if (from !== to) {
      item.bucket = to;
      item.receipts.push(`Claude's verdict moved this from ${from} to ${to}`);
    }
  }
  sortItems(board);
  countCourts(board);
}

function sendNotifications(
  board: Board,
  store: Store,
  cfg: Config,
  record: (event: Omit<NotificationEvent, 'id' | 'at'>) => void,
): void {
  const now = new Date();
  for (const item of [...board.items, ...board.reviewing]) {
    const key = notifyKey(item, cfg, now);
    const id = prKey(item.repo, item.number);
    if (store.shouldNotify(id, key, now)) {
      const repoName = item.repo.split('/')[1] ?? item.repo;
      const body = item.role === 'reviewer'
        ? `review needed: ${item.title}`
        : `${key}: ${item.title}`;
      const title = `${repoName} #${item.number}`;
      notify(title, body, item.url);
      record({ title, body, url: item.url });
      store.recordNotified(id, key, now);
      continue;
    }
    // Record what we saw even when nothing fired, so leaving and re-entering
    // a notify-worthy key notifies again.
    store.recordObserved(id, key);
  }
}

export type SessionKind = 'background' | 'interactive';
export type SessionStatus = 'busy' | 'waiting' | 'idle';
export type SessionState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';

/** How strongly a session is tied to a PR, strongest first. */
export type MatchedBy = 'recorded' | 'url' | 'branch' | 'number';

/** `job`: the background job recorded its worktree branch; `git`: read from `cwd`'s checkout. */
export type BranchSource = 'job' | 'git' | null;

/** One local Claude Code session, as listed by `claude agents` and enriched from its on-disk records. */
export interface SessionInfo {
  /** Short id used by `claude attach`; null for interactive sessions. */
  id: string | null;
  sessionId: string;
  name: string;
  kind: SessionKind;
  /** Only present while the process is alive. */
  status: SessionStatus | null;
  state: SessionState | null;
  cwd: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** The checked-out branch of `cwd` (or the job's worktree branch); null when unknown. */
  branch: string | null;
  /** Where `branch` came from: the job's own record, or `cwd`'s current checkout. */
  branchSource: BranchSource;
  /** Lowercased `owner/name` of `cwd`'s origin remote; null when unknown. */
  repo: string | null;
  /** PRs the session recorded as its own, as lowercased `owner/name#n` keys. */
  prLinks: string[];
  /** The session's first prompt, when recorded. */
  intent: string;
  claudeAiUrl: string | null;
}

/** The part of a session the board and client need. */
export interface LinkedSession {
  id: string | null;
  sessionId: string;
  name: string;
  kind: SessionKind;
  status: SessionStatus | null;
  state: SessionState | null;
  cwd: string;
  matchedBy: MatchedBy;
  claudeAiUrl: string | null;
}

/** The button each card puts first. */
export type PrimaryAction = 'claudeAi' | 'terminal' | 'desktop' | 'copy';

export interface SessionActions {
  /** A terminal command is available (configured or detected). */
  openTerminal: boolean;
  /** The Claude desktop app can resume a session on this machine. */
  openDesktop: boolean;
  /** At least one repo has a `repoPaths` entry. */
  startSession: boolean;
}

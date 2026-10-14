import type {
  LinkedSession, PrimaryAction, SessionStatus, SetupPatch, SetupResponse,
} from './api';

/** Sessions shown on a card before the rest fold behind "+N more". */
export const VISIBLE_SESSIONS = 3;

/** Single-quotes `value` for a POSIX shell, escaping any single quote inside it. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The shell command that brings a session back: attaching to a background
 * session, or resuming an interactive one from the directory it ran in. Every
 * value is quoted, and `cd --` keeps a directory starting with `-` from being
 * read as an option.
 */
export function copyCommand(session: Pick<LinkedSession, 'kind' | 'id' | 'sessionId' | 'cwd'>): string {
  if (session.kind === 'background' && session.id !== null) {
    return `claude attach ${shellQuote(session.id)}`;
  }
  return `cd -- ${shellQuote(session.cwd)} && claude --resume ${shellQuote(session.sessionId)}`;
}

/** What a session is called on screen: its name, or its id when it has none. */
export const sessionDisplayName = (session: Pick<LinkedSession, 'name' | 'sessionId'>): string =>
  session.name || session.sessionId;

/** The accessible name of a session button, which says which session it acts on. */
export function actionAriaLabel(id: SessionActionId, sessionName: string): string {
  switch (id) {
    case 'claudeAi': return `Open ${sessionName} on claude.ai`;
    case 'terminal': return `Open ${sessionName} in a terminal`;
    case 'desktop': return `Open ${sessionName} in the desktop app`;
    default: return `Copy command for ${sessionName}`;
  }
}

/** The accessible name of the button that starts a session for a PR. */
export const startSessionAriaLabel = (repo: string, number: number): string =>
  `Start a session for ${repo} #${number}`;

/** What a status dot looks like: busy, waiting (needs attention) and idle are alive; 'ended' has no process. */
export type DotKind = 'busy' | 'waiting' | 'idle' | 'ended';

export const dotKind = (status: SessionStatus | null): DotKind => status ?? 'ended';

export function statusLabel(session: Pick<LinkedSession, 'status' | 'state'>): string {
  switch (session.status) {
    case 'busy': return 'working';
    case 'waiting': return 'waiting for you';
    case 'idle': return 'idle';
    default: break;
  }
  switch (session.state) {
    case 'done': return 'finished';
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    case 'blocked': return 'blocked';
    case 'working': return 'working';
    default: return 'not running';
  }
}

export const MATCH_HINT: Record<LinkedSession['matchedBy'], string> = {
  recorded: 'Linked: the session recorded this PR',
  url: "Linked: the session's name or first prompt mentions this PR's URL",
  branch: "Linked: the session is on this PR's branch",
  number: "Linked: the session's name or first prompt mentions this PR's number",
};

/** The sessions to show now and how many are folded away. */
export function splitSessions<T>(
  sessions: T[], expanded: boolean, limit: number = VISIBLE_SESSIONS,
): { shown: T[]; hidden: number } {
  if (expanded || sessions.length <= limit) return { shown: sessions, hidden: 0 };
  return { shown: sessions.slice(0, limit), hidden: sessions.length - limit };
}

export type SessionActionId = PrimaryAction;

/**
 * The buttons a session row shows, in order. The primary action comes first and
 * is marked as the main one; the rest follow in a fixed order. An action that is
 * unavailable for the session is left out, so the primary may be absent.
 */
export function orderActions(
  primary: PrimaryAction, available: readonly SessionActionId[],
): { id: SessionActionId; primary: boolean }[] {
  const fixed: SessionActionId[] = ['claudeAi', 'terminal', 'desktop', 'copy'];
  const present = fixed.filter((id) => available.includes(id));
  const sorted = present.includes(primary)
    ? [primary, ...present.filter((id) => id !== primary)]
    : present;
  return sorted.map((id) => ({ id, primary: id === primary }));
}

export function platformLabel(
  platform: 'wsl' | 'linux' | 'darwin' | 'win32', wslDistro: string | null,
): string {
  switch (platform) {
    case 'wsl': return wslDistro === null ? 'WSL' : `WSL (${wslDistro})`;
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    default: return 'Linux';
  }
}

export interface PrimaryActionChoice {
  id: PrimaryAction;
  label: string;
  /** Why the choice cannot be picked; null when it can. */
  disabledReason: string | null;
}

/** The radio choices for the main session button, with a reason for each unavailable one. */
export function primaryActionChoices(
  hasTerminal: boolean, desktopResume: boolean,
): PrimaryActionChoice[] {
  return [
    { id: 'claudeAi', label: 'Open on claude.ai', disabledReason: null },
    {
      id: 'terminal',
      label: 'Open in a terminal',
      disabledReason: hasTerminal ? null : 'No terminal was detected and none is set in config.json',
    },
    {
      id: 'desktop',
      label: 'Open in the desktop app',
      disabledReason: desktopResume ? null : 'The desktop app can only be opened on macOS and Windows',
    },
    { id: 'copy', label: 'Copy the command', disabledReason: null },
  ];
}

export interface SettingsDraft {
  primaryAction: PrimaryAction;
  terminalPreset: string;
  startPrompt: string;
  repoPaths: Record<string, string>;
}

/** Whether two drafts hold the same choices. */
export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  const keys = (paths: Record<string, string>) => Object.keys(paths).sort();
  const pathsA = keys(a.repoPaths);
  const pathsB = keys(b.repoPaths);
  return a.primaryAction === b.primaryAction && a.terminalPreset === b.terminalPreset
    && a.startPrompt === b.startPrompt && pathsA.length === pathsB.length
    && pathsA.every((repo, i) => repo === pathsB[i] && a.repoPaths[repo] === b.repoPaths[repo]);
}

export function draftFrom(setup: SetupResponse): SettingsDraft {
  return {
    primaryAction: setup.effective.primaryAction,
    terminalPreset: setup.effective.terminalPreset ?? '',
    startPrompt: setup.effective.startPrompt,
    repoPaths: { ...setup.effective.repoPaths },
  };
}

/** One folder row of the settings panel. */
export interface RepoRow {
  repo: string;
  /** False for a saved folder whose repo has no PR on the board right now. */
  onBoard: boolean;
}

/** Every repo on the board, then the saved folders for repos that are not, so those can be changed or cleared. */
export function repoRows(boardRepos: readonly string[], setup: SetupResponse): RepoRow[] {
  const onBoard = new Set(boardRepos);
  const offBoard = Object.keys(setup.saved.repoPaths ?? {})
    .filter((repo) => !onBoard.has(repo)).sort();
  return [
    ...boardRepos.map((repo) => ({ repo, onBoard: true })),
    ...offBoard.map((repo) => ({ repo, onBoard: false })),
  ];
}

/**
 * Errors from a rejected save that no field of the panel shows by itself,
 * as `<field>: <message>` lines, so no rejection goes unseen.
 */
export function unownedErrors(
  errors: Record<string, string>, shownFields: readonly string[],
): string[] {
  return Object.entries(errors)
    .filter(([field]) => !shownFields.includes(field))
    .map(([field, message]) => `${field}: ${message}`);
}

/**
 * Only what the user changed (or had already saved) is sent, so opening the
 * panel and saving does not pin detected defaults as if they were choices.
 * Folders for repos that config.json sets are never sent: the server owns them.
 */
export function buildPatch(setup: SetupResponse, draft: SettingsDraft, repos: string[]): SetupPatch {
  const { saved, effective, lockedByConfig } = setup;
  const patch: SetupPatch = {};
  if (draft.primaryAction !== effective.primaryAction || saved.primaryAction !== undefined) {
    patch.primaryAction = draft.primaryAction;
  }
  if (
    !lockedByConfig.includes('terminalPreset') && draft.terminalPreset !== ''
    && (draft.terminalPreset !== effective.terminalPreset || saved.terminalPreset !== undefined)
  ) {
    patch.terminalPreset = draft.terminalPreset;
  }
  if (
    !lockedByConfig.includes('startPrompt')
    && (draft.startPrompt !== effective.startPrompt || saved.startPrompt !== undefined)
  ) {
    patch.startPrompt = draft.startPrompt;
  }
  // The server replaces the saved folders wholesale, so start from what is saved
  // (including repos not on the board right now) and apply the rows' changes.
  const paths: Record<string, string> = { ...saved.repoPaths };
  for (const repo of Object.keys(paths)) {
    if (lockedByConfig.includes(`repoPaths.${repo}`)) delete paths[repo];
  }
  for (const repo of repos) {
    if (lockedByConfig.includes(`repoPaths.${repo}`)) continue;
    const value = (draft.repoPaths[repo] ?? '').trim();
    if (value === '') delete paths[repo];
    else if (value !== effective.repoPaths[repo] || paths[repo] !== undefined) paths[repo] = value;
  }
  if (Object.keys(paths).length > 0 || Object.keys(saved.repoPaths ?? {}).length > 0) {
    patch.repoPaths = paths;
  }
  return patch;
}

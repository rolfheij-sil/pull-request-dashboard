export type PrimaryAction = 'claudeAi' | 'terminal' | 'desktop' | 'copy';

export type SessionStatus = 'busy' | 'waiting' | 'idle';

export interface LinkedSession {
  /** Short id for `claude attach`; null for interactive sessions. */
  id: string | null;
  sessionId: string;
  name: string;
  kind: 'background' | 'interactive';
  /** Null when the session has no live process. */
  status: SessionStatus | null;
  state: 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | null;
  cwd: string;
  matchedBy: 'recorded' | 'url' | 'branch' | 'number';
  claudeAiUrl: string | null;
}

export interface BoardItem {
  /** `owner/name`; with `number` it identifies the PR. */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Login of the PR's author. */
  author: string;
  /** 'author' for the user's own PRs, 'reviewer' for other people's. */
  role: 'author' | 'reviewer';
  bucket: string;
  receipts: string[];
  displayTime: string | null;
  checkDot: 'fail' | 'pending' | 'pass' | 'none';
  verdict: { asks: string[] } | null;
  /** Local Claude Code sessions working on this PR. */
  sessions: LinkedSession[];
  /** A local clone is configured for this PR's repo. */
  canStartSession: boolean;
  /** What "Start session" would create; null when it cannot be started. */
  startPreview: { name: string; prompt: string } | null;
}

export interface NotificationEvent {
  id: number;
  title: string;
  body: string;
  url: string;
  at: string;
}

export interface Board {
  items: BoardItem[];
  reviewing: BoardItem[];
  branches: { name: string; bucket: string }[];
  yourCourtCount: number;
  myCourtCount: number;
  reviewCourtCount: number;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  notifications: NotificationEvent[];
  epoch: string;
  /** Why Claude Code sessions are unavailable; null when they are available or the feature is off. */
  sessionsError: string | null;
  sessionActions: { openTerminal: boolean; openDesktop: boolean; startSession: boolean };
  /** The session button each card puts first. */
  primaryAction: PrimaryAction;
}

export const fetchBoard = async (): Promise<Board> => {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return (await response.json()) as Board;
};

/**
 * Every state-changing request carries this header. A web page on another
 * origin cannot add it without a CORS preflight the API refuses, so only the
 * board (and local tools that send it) can change anything.
 */
const WRITE_HEADERS = { 'x-pr-dashboard': '1' };

export const markPostedToDiscord = async (
  repo: string, number: number, posted: boolean,
): Promise<void> => {
  await fetch(`/api/pr/${repo}/${number}/discord`, {
    method: 'POST',
    headers: { ...WRITE_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ posted }),
  });
};

export const openSessionTerminal = async (id: string): Promise<void> => {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/open-terminal`, {
    method: 'POST',
    headers: WRITE_HEADERS,
  });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
};

/** Resolves with the CLI's output; rejects with the server's error message. */
export const startSession = async (repo: string, number: number): Promise<string> => {
  const response = await fetch(`/api/pr/${repo}/${number}/start-session`, {
    method: 'POST',
    headers: WRITE_HEADERS,
  });
  const body = (await response.json().catch(() => ({}))) as { output?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `API returned ${response.status}`);
  return body.output ?? '';
};

export interface TerminalPreset { id: string; label: string }

export interface DetectedSetup {
  platform: 'wsl' | 'linux' | 'darwin' | 'win32';
  wslDistro: string | null;
  claude: { path: string | null; version: string | null; reason: string | null };
  terminals: TerminalPreset[];
  desktopResume: boolean;
  /** Lowercased `owner/name` to candidate clone folders, best first. */
  repoClones: Record<string, string[]>;
}

export interface SetupResponse {
  detected: DetectedSetup;
  saved: {
    primaryAction?: PrimaryAction;
    terminalPreset?: string;
    repoPaths?: Record<string, string>;
    startPrompt?: string;
  };
  effective: {
    primaryAction: PrimaryAction;
    terminalPreset: string | null;
    repoPaths: Record<string, string>;
    startPrompt: string;
    openTerminalSource: 'config' | 'panel' | 'detected' | 'none';
  };
  /** `terminalPreset`, `startPrompt` and `repoPaths.<owner/name>` set in config.json. */
  lockedByConfig: string[];
}

export interface SetupPatch {
  primaryAction?: PrimaryAction;
  terminalPreset?: string | null;
  repoPaths?: Record<string, string>;
  startPrompt?: string;
}

export const fetchSetup = async (): Promise<SetupResponse> => {
  const response = await fetch('/api/setup');
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return (await response.json()) as SetupResponse;
};

export const redetectSetup = async (): Promise<SetupResponse> => {
  const response = await fetch('/api/setup/redetect', { method: 'POST', headers: WRITE_HEADERS });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return (await response.json()) as SetupResponse;
};

/** Per-field errors from a rejected save, keyed by field (`repoPaths.owner/name` for a folder). */
export class SetupSaveError extends Error {
  constructor(readonly errors: Record<string, string>) {
    super('Settings were not saved');
  }
}

export const saveSetup = async (patch: SetupPatch): Promise<SetupResponse> => {
  const response = await fetch('/api/setup', {
    method: 'PUT',
    headers: { ...WRITE_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as { errors?: Record<string, string> };
    throw new SetupSaveError(body.errors ?? { body: 'was rejected' });
  }
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return (await response.json()) as SetupResponse;
};

export const openSessionDesktop = async (sessionId: string): Promise<void> => {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/open-desktop`, {
    method: 'POST',
    headers: WRITE_HEADERS,
  });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
};

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prKey } from '../pr-key.js';
import type { SessionsConfig } from '../types.js';
import type {
  SessionInfo, SessionKind, SessionState, SessionStatus,
} from './types.js';

const AGENTS_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 3_000;
const AGENTS_MAX_BUFFER = 16 * 1024 * 1024;

/** The I/O the listing needs, injectable so tests need no real CLI or files. */
export interface ListDeps {
  /** Runs a program without a shell and resolves with its stdout; rejects on failure or timeout. */
  exec(file: string, args: string[], options: { timeout: number }): Promise<string>;
  /** A file's text, or null when it cannot be read. */
  readText(path: string): string | null;
  env: Record<string, string | undefined>;
  homeDir: string;
}

export const defaultListDeps: ListDeps = {
  exec: (file, args, options) => new Promise((resolve, reject) => {
    execFile(
      file, args, { timeout: options.timeout, maxBuffer: AGENTS_MAX_BUFFER },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  }),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  env: process.env,
  homeDir: homedir(),
};

export interface SessionListing {
  sessions: SessionInfo[];
  /** Why the listing is empty or incomplete, for the board to show; null when it worked. */
  error: string | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Parses JSON text into an object; anything else (bad JSON, arrays, null) is null. */
function parseObject(text: string | null): Json | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function resolveClaudeDir(cfg: SessionsConfig, deps: ListDeps): string {
  const configured = cfg.claudeDir ?? deps.env.CLAUDE_CONFIG_DIR;
  if (configured === undefined || configured === '') return join(deps.homeDir, '.claude');
  if (configured === '~') return deps.homeDir;
  if (configured.startsWith('~/')) return join(deps.homeDir, configured.slice(2));
  return configured;
}

const PR_URL = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i;

/** The `owner/name#n` key of a GitHub pull request URL, or null. */
export function prKeyFromUrl(url: string): string | null {
  const match = PR_URL.exec(url);
  return match === null ? null : prKey(match[1]!, Number(match[2]));
}

/** `owner/name`, lowercased, from a GitHub remote URL (https, ssh or scp-style); null otherwise. */
export function repoFromRemote(remote: string): string | null {
  const match = /github\.com[:/]([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
}

/** The claude.ai URL for a Remote Control id; `cse_X` and `session_X` name the same session. */
export function claudeAiUrl(bridgeId: string | null): string | null {
  if (bridgeId === null) return null;
  const suffix = /^(?:cse|session)_(.+)$/.exec(bridgeId)?.[1];
  return suffix === undefined ? null : `https://claude.ai/code/session_${suffix}`;
}

const STATUSES: readonly string[] = ['busy', 'waiting', 'idle'];
const STATES: readonly string[] = ['working', 'blocked', 'done', 'failed', 'stopped'];

interface JobRecord {
  prLinks: string[];
  intent: string;
  worktreeBranch: string | null;
  bridgeSessionId: string | null;
}

/** Best-effort read of `jobs/<id>/state.json`; every field is optional and a bad file yields nothing. */
function readJob(deps: ListDeps, claudeDir: string, id: string): JobRecord | null {
  const state = parseObject(deps.readText(join(claudeDir, 'jobs', id, 'state.json')));
  if (state === null) return null;
  const prLinks: string[] = [];
  if (Array.isArray(state.children)) {
    for (const child of state.children) {
      if (!isObject(child) || child.kind !== 'pr') continue;
      const href = str(child.href);
      const key = href === null ? null : prKeyFromUrl(href);
      if (key !== null && !prLinks.includes(key)) prLinks.push(key);
    }
  }
  return {
    prLinks,
    intent: str(state.intent) ?? '',
    worktreeBranch: str(state.worktreeBranch),
    bridgeSessionId: str(state.bridgeSessionId),
  };
}

/** Best-effort read of `sessions/<pid>.json`. */
function readProcessRecord(
  deps: ListDeps, claudeDir: string, pid: number | null,
): { bridgeSessionId: string | null } | null {
  if (pid === null) return null;
  const record = parseObject(deps.readText(join(claudeDir, 'sessions', `${pid}.json`)));
  return record === null ? null : { bridgeSessionId: str(record.bridgeSessionId) };
}

interface GitInfo { branch: string | null; repo: string | null }

async function readGit(deps: ListDeps, cwd: string): Promise<GitInfo> {
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const out = (await deps.exec('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS })).trim();
      return out === '' ? null : out;
    } catch {
      return null;
    }
  };
  const [branch, remote] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['remote', 'get-url', 'origin']),
  ]);
  return {
    // A detached HEAD prints "HEAD", which is not a branch.
    branch: branch === 'HEAD' ? null : branch,
    repo: remote === null ? null : repoFromRemote(remote),
  };
}

/**
 * Lists local Claude Code sessions. The CLI listing is the supported source;
 * the job and process records on disk are an internal format, so each is read
 * defensively and a missing or odd file only costs the fields it would have given.
 */
export async function listSessions(
  cfg: SessionsConfig, deps: ListDeps = defaultListDeps,
): Promise<SessionListing> {
  const claudeCommand = cfg.claudeCommand ?? 'claude';
  let entries: unknown;
  try {
    const stdout = await deps.exec(
      claudeCommand, ['agents', '--json', '--all'], { timeout: AGENTS_TIMEOUT_MS },
    );
    entries = JSON.parse(stdout);
  } catch (error) {
    return { sessions: [], error: errorMessage(error) };
  }
  if (!Array.isArray(entries)) {
    return { sessions: [], error: 'unexpected output from `claude agents --json`' };
  }

  const claudeDir = resolveClaudeDir(cfg, deps);
  const gitByCwd = new Map<string, Promise<GitInfo>>();
  const gitFor = (cwd: string): Promise<GitInfo> => {
    let pending = gitByCwd.get(cwd);
    if (pending === undefined) {
      pending = readGit(deps, cwd);
      gitByCwd.set(cwd, pending);
    }
    return pending;
  };

  const sessions = await Promise.all(entries.filter(isObject).map(async (entry) => {
    const sessionId = str(entry.sessionId);
    if (sessionId === null) return null;
    const id = str(entry.id);
    const pid = typeof entry.pid === 'number' ? entry.pid : null;
    const cwd = str(entry.cwd) ?? '';
    const job = id === null ? null : readJob(deps, claudeDir, id);
    const processRecord = readProcessRecord(deps, claudeDir, pid);
    const git = cwd === '' ? { branch: null, repo: null } : await gitFor(cwd);
    const session: SessionInfo = {
      id,
      sessionId,
      name: str(entry.name) ?? '',
      kind: (entry.kind === 'background' ? 'background' : 'interactive') satisfies SessionKind,
      status: STATUSES.includes(entry.status as string) ? (entry.status as SessionStatus) : null,
      state: STATES.includes(entry.state as string) ? (entry.state as SessionState) : null,
      cwd,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : 0,
      branch: job?.worktreeBranch ?? git.branch,
      repo: git.repo,
      prLinks: job?.prLinks ?? [],
      intent: job?.intent ?? '',
      claudeAiUrl: claudeAiUrl(processRecord?.bridgeSessionId ?? job?.bridgeSessionId ?? null),
    };
    return session;
  }));

  return { sessions: sessions.filter((s): s is SessionInfo => s !== null), error: null };
}

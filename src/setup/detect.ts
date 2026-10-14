import { execFile } from 'node:child_process';
import {
  accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createLimiter, GIT_CONCURRENCY } from '../concurrency.js';
import { repoFromRemote } from '../sessions/list.js';

const VERSION_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 2_000;
/** The most directories the clone search looks inside. */
export const MAX_DIRS_SCANNED = 200;

export type Platform = 'wsl' | 'linux' | 'darwin' | 'win32';

/** A way to open a terminal attached to a session, in the `openTerminalCommand` placeholder language. */
export interface TerminalPreset {
  id: string;
  label: string;
  /**
   * argv with `{id}` `{cwd}` `{name}` `{claudeCommand}` placeholders; the distro is baked in,
   * and `{claudeCommand}` resolves to config.json's CLI path when set, else the detected one.
   */
  argv: string[];
}

export interface DetectedSetup {
  platform: Platform;
  /** The WSL distribution name, when running under WSL. */
  wslDistro: string | null;
  claude: {
    /** The newest working CLI; null when none was found. */
    path: string | null;
    version: string | null;
    /** Why no CLI was chosen. */
    reason: string | null;
    /** Every distinct CLI that answered `--version`, in search order. */
    candidates: { path: string; version: string }[];
  };
  terminals: TerminalPreset[];
  /** `claude --desktop --resume` can open the Claude desktop app on this machine. */
  desktopResume: boolean;
  /** Lowercased `owner/name` to candidate clone folders, best first. */
  repoClones: Record<string, string[]>;
}

/** The I/O detection needs, injectable so tests need no real machine. */
export interface DetectDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  readText(file: string): string | null;
  isExecutable(file: string): boolean;
  /** Resolves symlinks; defaults to the path itself. */
  realPath?(file: string): string;
  exists(file: string): boolean;
  isDirectory(file: string): boolean;
  /** Absolute paths of the immediate subdirectories of `dir`; empty when unreadable. */
  listDirs(dir: string): string[];
  /** Runs a program without a shell; resolves with stdout, rejects on failure or timeout. */
  exec(file: string, args: string[], options: { timeout: number }): Promise<string>;
}

export const defaultDetectDeps: DetectDeps = {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  homeDir: homedir(),
  readText: (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  isExecutable: (file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
  realPath: (file) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  },
  exists: (file) => existsSync(file),
  isDirectory: (file) => {
    try {
      return statSync(file).isDirectory();
    } catch {
      return false;
    }
  },
  listDirs: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  },
  exec: (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout }, (error, stdout) => (
      error ? reject(error) : resolve(stdout)
    ));
  }),
};

/** WSL is Linux with `WSL_DISTRO_NAME` set or a kernel version string that names Microsoft. */
export function detectPlatform(
  platform: NodeJS.Platform, env: Record<string, string | undefined>, procVersion: string | null,
): Platform {
  if (platform === 'darwin' || platform === 'win32') return platform;
  const wsl = (env.WSL_DISTRO_NAME ?? '') !== '' || /microsoft/i.test(procVersion ?? '');
  return wsl ? 'wsl' : 'linux';
}

/** Every executable called `name` on `PATH`, in PATH order. */
export function findAllOnPath(name: string, deps: DetectDeps): string[] {
  const windows = deps.platform === 'win32';
  const flavor = windows ? path.win32 : path.posix;
  const dirs = (deps.env.PATH ?? deps.env.Path ?? '')
    .split(windows ? ';' : ':').filter((dir) => dir !== '');
  return dirs.map((dir) => flavor.join(dir, name)).filter((file) => deps.isExecutable(file));
}

/** The first executable called `name` on `PATH`, or null. */
export function findOnPath(name: string, deps: DetectDeps): string | null {
  return findAllOnPath(name, deps)[0] ?? null;
}

/**
 * Every distinct `claude` binary: those on `PATH` (in order), then the usual
 * install locations. `npm run` and version managers put old copies early on
 * `PATH`, so the first hit is not necessarily the one the user runs.
 */
export function claudeCandidates(deps: DetectDeps): string[] {
  const names = deps.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const found = names.flatMap((name) => findAllOnPath(name, deps));
  for (const known of [
    path.posix.join(deps.homeDir, '.local', 'bin', 'claude'),
    path.posix.join(deps.homeDir, '.claude', 'local', 'claude'),
  ]) {
    if (deps.isExecutable(known)) found.push(known);
  }
  const seen = new Set<string>();
  return found.filter((file) => {
    const real = deps.realPath?.(file) ?? file;
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** `[major, minor, patch]` from output such as `2.1.299 (Claude Code)`; null when absent. */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

const compareVersions = (a: number[], b: number[]): number =>
  a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Terminal presets for this machine. The distro is baked into the argv; the
 * CLI path and the session's directory and id stay `{placeholders}`. The
 * Windows Terminal presets leave out `--title`: the session's name is
 * untrusted text and Windows Terminal reads `;` in any argument as a command
 * separator. On macOS the values are passed to AppleScript as separate
 * arguments after the script, so nothing session-derived is ever part of
 * script text.
 */
export function terminalPresets(
  platform: Platform, claudePath: string | null, wslDistro: string | null, deps: DetectDeps,
): TerminalPreset[] {
  if (claudePath === null) return [];
  const presets: TerminalPreset[] = [];
  const wt = platform === 'wsl' || platform === 'win32' ? findOnPath('wt.exe', deps) : null;

  if (platform === 'wsl' && wt !== null) {
    presets.push({
      id: 'wt-wsl',
      label: 'Windows Terminal (into WSL)',
      argv: [
        'wt.exe', '-w', '0', 'new-tab',
        'wsl.exe', ...(wslDistro === null ? [] : ['-d', wslDistro]),
        '--cd', '{cwd}', '--', '{claudeCommand}', 'attach', '{id}',
      ],
    });
  }
  if (platform === 'win32' && wt !== null) {
    presets.push({
      id: 'wt',
      label: 'Windows Terminal',
      argv: [
        'wt.exe', '-w', '0', 'new-tab', '-d', '{cwd}',
        '{claudeCommand}', 'attach', '{id}',
      ],
    });
  }
  if (platform === 'darwin') {
    const attachLine = (
      '"cd " & quoted form of item 1 of argv & " && " & quoted form of item 2 of argv'
      + ' & " attach " & quoted form of item 3 of argv'
    );
    if (
      deps.exists('/System/Applications/Utilities/Terminal.app')
      || deps.exists('/Applications/Utilities/Terminal.app')
    ) {
      presets.push({
        id: 'macos-terminal',
        label: 'Terminal',
        argv: [
          'osascript',
          '-e', 'on run argv',
          '-e', 'tell application "Terminal" to activate',
          '-e', `tell application "Terminal" to do script ${attachLine}`,
          '-e', 'end run',
          '{cwd}', '{claudeCommand}', '{id}',
        ],
      });
    }
    if (deps.exists('/Applications/iTerm.app')) {
      presets.push({
        id: 'iterm',
        label: 'iTerm',
        argv: [
          'osascript',
          '-e', 'on run argv',
          '-e', 'tell application "iTerm"',
          '-e', 'activate',
          '-e', 'set newWindow to (create window with default profile)',
          '-e', `tell current session of newWindow to write text (${attachLine})`,
          '-e', 'end tell',
          '-e', 'end run',
          '{cwd}', '{claudeCommand}', '{id}',
        ],
      });
    }
  }
  if (platform === 'linux') {
    const fromEnv = deps.env.TERMINAL;
    const envTerminal = fromEnv !== undefined && fromEnv !== '' && !/\s/.test(fromEnv)
      ? findOnPath(fromEnv, deps) : null;
    if (envTerminal !== null) {
      presets.push({
        id: 'terminal-env',
        label: `$TERMINAL (${fromEnv})`,
        argv: [envTerminal, '-e', '{claudeCommand}', 'attach', '{id}'],
      });
    }
    const generic = findOnPath('x-terminal-emulator', deps);
    if (generic !== null && generic !== envTerminal) {
      presets.push({
        id: 'x-terminal-emulator',
        label: 'x-terminal-emulator',
        argv: [generic, '-e', '{claudeCommand}', 'attach', '{id}'],
      });
    }
  }
  return presets;
}

interface GitInfo {
  /** Folder of the main working tree. */
  mainRoot: string;
  /** The folder asked about is a linked worktree rather than the main working tree. */
  isWorktree: boolean;
  /** Lowercased `owner/name` of the origin remote; null when it has none or is not on GitHub. */
  repo: string | null;
}

async function git(deps: DetectDeps, dir: string, args: string[]): Promise<string | null> {
  try {
    const out = (await deps.exec('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS })).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** The origin remote's `owner/name` for a folder, or null. */
export async function originRepo(deps: DetectDeps, dir: string): Promise<string | null> {
  const remote = await git(deps, dir, ['remote', 'get-url', 'origin']);
  return remote === null ? null : repoFromRemote(remote);
}

async function gitInfo(deps: DetectDeps, dir: string): Promise<GitInfo | null> {
  const [toplevel, commonDir, repo] = await Promise.all([
    git(deps, dir, ['rev-parse', '--show-toplevel']),
    git(deps, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    originRepo(deps, dir),
  ]);
  if (toplevel === null || commonDir === null) return null;
  // The common dir is `<main working tree>/.git` for a normal clone and its worktrees.
  const mainRoot = path.posix.basename(commonDir) === '.git' ? path.posix.dirname(commonDir) : toplevel;
  return { mainRoot, isWorktree: mainRoot !== toplevel, repo };
}

/** Lower is better: the configured path, then main clones, then worktrees. */
type Rank = 0 | 1 | 2;

export interface CloneSearch {
  /** The home repo's configured clone. */
  repoPath: string;
  /** Working directories of live sessions. */
  sessionCwds: string[];
}

/** Finds local clones of GitHub repos: the configured one, the sessions' own, and its siblings. */
export async function findRepoClones(
  deps: DetectDeps, search: CloneSearch,
): Promise<Record<string, string[]>> {
  const found = new Map<string, Map<string, Rank>>();
  const record = (repo: string | null, folder: string, rank: Rank): void => {
    if (repo === null) return;
    const folders = found.get(repo) ?? new Map<string, Rank>();
    folders.set(folder, Math.min(folders.get(folder) ?? rank, rank) as Rank);
    found.set(repo, folders);
  };

  const scanned = new Set<string>();
  const claim = (dir: string): boolean => {
    if (scanned.has(dir) || scanned.size >= MAX_DIRS_SCANNED) return false;
    scanned.add(dir);
    return true;
  };

  // (a) the configured clone, kept under the exact path the user gave.
  const jobs: { dir: string; apply: (info: GitInfo) => void }[] = [];
  if (claim(search.repoPath)) {
    jobs.push({ dir: search.repoPath, apply: (info) => record(info.repo, search.repoPath, 0) });
  }
  // (b) the main working tree of each live session's directory.
  for (const cwd of search.sessionCwds) {
    if (cwd === '' || !claim(cwd)) continue;
    jobs.push({ dir: cwd, apply: (info) => record(info.repo, info.mainRoot, 1) });
  }
  // (c) git repos next to the configured clone.
  for (const dir of deps.listDirs(path.dirname(search.repoPath))) {
    if (!deps.exists(path.posix.join(dir, '.git')) || !claim(dir)) continue;
    jobs.push({
      dir,
      apply: (info) => record(info.repo, info.isWorktree ? dir : info.mainRoot, info.isWorktree ? 2 : 1),
    });
  }

  const limit = createLimiter(GIT_CONCURRENCY);
  await Promise.all(jobs.map((job) => limit(async () => {
    const info = await gitInfo(deps, job.dir);
    if (info !== null) job.apply(info);
  })));

  const result: Record<string, string[]> = {};
  for (const [repo, folders] of found) {
    result[repo] = [...folders.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([folder]) => folder);
  }
  return result;
}

/** Why `folder` cannot be the clone of `repo`, or null when it can. */
export async function checkRepoFolder(
  deps: DetectDeps, repo: string, folder: string,
): Promise<string | null> {
  if (!path.isAbsolute(folder)) return 'must be an absolute path';
  if (!deps.isDirectory(folder)) return 'is not a folder that exists';
  const actual = await originRepo(deps, folder);
  if (actual === null) return 'is not a git clone with a GitHub origin remote';
  if (actual !== repo.toLowerCase()) return `is a clone of ${actual}, not ${repo.toLowerCase()}`;
  return null;
}

export async function detectSetup(
  deps: DetectDeps, search: CloneSearch,
): Promise<DetectedSetup> {
  const platform = detectPlatform(
    deps.platform, deps.env, deps.platform === 'linux' ? deps.readText('/proc/version') : null,
  );
  const wslDistro = platform === 'wsl' ? (deps.env.WSL_DISTRO_NAME ?? null) : null;

  const probed = await Promise.all(claudeCandidates(deps).map(async (file) => {
    try {
      const line = (await deps.exec(file, ['--version'], { timeout: VERSION_TIMEOUT_MS }))
        .trim().split('\n')[0] ?? '';
      const parsed = parseVersion(line);
      return parsed === null ? null : { path: file, version: line, parsed };
    } catch {
      return null;
    }
  }));
  const working = probed.filter((c): c is NonNullable<typeof c> => c !== null);
  // The highest version wins; on a tie the earlier candidate does.
  let best: (typeof working)[number] | undefined;
  for (const candidate of working) {
    if (best === undefined || compareVersions(candidate.parsed, best.parsed) > 0) best = candidate;
  }
  const claudePath = best?.path ?? null;
  const reason = best !== undefined ? null
    : probed.length === 0 ? 'claude was not found on PATH or in ~/.local/bin'
    : 'claude was found but `claude --version` failed for every copy';

  return {
    platform,
    wslDistro,
    claude: {
      path: claudePath,
      version: best?.version ?? null,
      reason,
      candidates: working.map(({ path: file, version }) => ({ path: file, version })),
    },
    terminals: terminalPresets(platform, claudePath, wslDistro, deps),
    desktopResume: platform === 'darwin' || (platform === 'win32' && deps.arch === 'x64'),
    repoClones: await findRepoClones(deps, search),
  };
}

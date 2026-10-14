import { describe, expect, it } from 'vitest';
import {
  checkRepoFolder, detectPlatform, detectSetup, findOnPath, findRepoClones, MAX_DIRS_SCANNED,
  resolveClaudePath, terminalPresets, type DetectDeps,
} from '../src/setup/detect.js';

interface World {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string>;
  files?: Record<string, string>;
  /** Executable files. */
  executables?: string[];
  /** Other paths that exist (apps, `.git` entries). */
  paths?: string[];
  /** Folders that are directories. */
  directories?: string[];
  /** Subdirectories by parent. */
  children?: Record<string, string[]>;
  /** Git answers per folder. */
  repos?: Record<string, { toplevel?: string; common?: string; remote?: string }>;
  claudeVersion?: string | Error;
}

const world = (w: World = {}) => {
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const deps: DetectDeps = {
    platform: w.platform ?? 'linux',
    arch: w.arch ?? 'x64',
    env: w.env ?? {},
    homeDir: '/home/me',
    readText: (file) => w.files?.[file] ?? null,
    isExecutable: (file) => w.executables?.includes(file) ?? false,
    exists: (file) => (w.paths ?? []).includes(file) || (w.executables ?? []).includes(file),
    isDirectory: (file) => (w.directories ?? []).includes(file),
    listDirs: (dir) => w.children?.[dir] ?? [],
    exec: async (file, args, options) => {
      calls.push({ file, args, timeout: options.timeout });
      if (file === 'git') {
        const dir = args[1]!;
        const repo = w.repos?.[dir];
        const answer = args.includes('--show-toplevel') ? repo?.toplevel
          : args.includes('--git-common-dir') ? repo?.common
          : args[2] === 'remote' ? repo?.remote : undefined;
        if (answer === undefined) throw new Error('git: not answered');
        return `${answer}\n`;
      }
      if (w.claudeVersion instanceof Error) throw w.claudeVersion;
      return `${w.claudeVersion ?? '2.1.299 (Claude Code)'}\n`;
    },
  };
  return { deps, calls };
};

const CLAUDE = '/home/me/.local/bin/claude';

describe('detectPlatform', () => {
  it.each([
    ['linux', { WSL_DISTRO_NAME: 'Ubuntu' }, null, 'wsl'],
    ['linux', {}, 'Linux version 5.15.90.1-microsoft-standard-WSL2', 'wsl'],
    ['linux', {}, 'Linux version 6.1 MICROSOFT', 'wsl'],
    ['linux', {}, 'Linux version 6.8.0-generic (buildd@ubuntu)', 'linux'],
    ['linux', {}, null, 'linux'],
    ['darwin', { WSL_DISTRO_NAME: 'x' }, 'microsoft', 'darwin'],
    ['win32', {}, null, 'win32'],
  ] as const)('%s with %j and /proc/version %j is %s', (platform, env, procVersion, expected) => {
    expect(detectPlatform(platform, env, procVersion)).toBe(expected);
  });

  it('reads /proc/version and WSL_DISTRO_NAME in detectSetup', async () => {
    const fromKernel = world({ files: { '/proc/version': 'Linux ... microsoft-standard-WSL2' } });
    expect((await detectSetup(fromKernel.deps, { repoPath: '/g/core', sessionCwds: [] })).platform)
      .toBe('wsl');
    const fromEnv = world({ env: { WSL_DISTRO_NAME: 'Ubuntu' } });
    const detected = await detectSetup(fromEnv.deps, { repoPath: '/g/core', sessionCwds: [] });
    expect(detected.platform).toBe('wsl');
    expect(detected.wslDistro).toBe('Ubuntu');
    const plain = world({ files: { '/proc/version': 'Linux version 6.8' } });
    expect((await detectSetup(plain.deps, { repoPath: '/g/core', sessionCwds: [] })).wslDistro)
      .toBeNull();
  });
});

describe('claude resolution', () => {
  it('takes the first executable on PATH, in PATH order', () => {
    const { deps } = world({
      env: { PATH: '/nope:/opt/a:/opt/b' },
      executables: ['/opt/b/claude', '/opt/a/claude', CLAUDE],
    });
    expect(resolveClaudePath(deps)).toBe('/opt/a/claude');
  });

  it('falls back to ~/.local/bin/claude when PATH has none', () => {
    const { deps } = world({ env: { PATH: '/opt/a' }, executables: [CLAUDE] });
    expect(resolveClaudePath(deps)).toBe(CLAUDE);
  });

  it('finds nothing when it is nowhere, ignoring a non-executable file', () => {
    const { deps } = world({ env: { PATH: '/opt/a' }, paths: ['/opt/a/claude', CLAUDE] });
    expect(resolveClaudePath(deps)).toBeNull();
  });

  it('splits PATH with semicolons on Windows', () => {
    const { deps } = world({ platform: 'win32', env: { PATH: 'C:\\a;C:\\b' }, executables: ['C:\\b\\claude.exe'] });
    expect(resolveClaudePath(deps)).toBe('C:\\b\\claude.exe');
    expect(findOnPath('wt.exe', deps)).toBeNull();
  });

  it('reports the version from claude --version, with a 5 s timeout', async () => {
    const { deps, calls } = world({ executables: [CLAUDE], claudeVersion: '2.1.299 (Claude Code)' });
    const detected = await detectSetup(deps, { repoPath: '/g/core', sessionCwds: [] });
    expect(detected.claude).toEqual({ path: CLAUDE, version: '2.1.299 (Claude Code)', reason: null });
    expect(calls.find((c) => c.file === CLAUDE)).toMatchObject({ args: ['--version'], timeout: 5000 });
  });

  it('says why when claude is missing', async () => {
    const detected = await detectSetup(world().deps, { repoPath: '/g/core', sessionCwds: [] });
    expect(detected.claude.path).toBeNull();
    expect(detected.claude.reason).toMatch(/not found/);
    expect(detected.terminals).toEqual([]);
  });

  it('keeps the path but reports the reason when --version fails', async () => {
    const { deps } = world({ executables: [CLAUDE], claudeVersion: new Error('boom') });
    const detected = await detectSetup(deps, { repoPath: '/g/core', sessionCwds: [] });
    expect(detected.claude.path).toBe(CLAUDE);
    expect(detected.claude.version).toBeNull();
    expect(detected.claude.reason).toMatch(/boom/);
  });
});

describe('terminal presets', () => {
  it('offers Windows Terminal into WSL with the distro and CLI path baked in', () => {
    const { deps } = world({ env: { PATH: '/mnt/c/wt' }, executables: ['/mnt/c/wt/wt.exe'] });
    expect(terminalPresets('wsl', CLAUDE, 'Ubuntu', deps)).toEqual([{
      id: 'wt-wsl',
      label: 'Windows Terminal (into WSL)',
      argv: [
        'wt.exe', '-w', '0', 'new-tab', '--title', '{name}', 'wsl.exe', '-d', 'Ubuntu',
        '--cd', '{cwd}', '--', CLAUDE, 'attach', '{id}',
      ],
    }]);
  });

  it('offers nothing on WSL without wt.exe, or without a claude path', () => {
    expect(terminalPresets('wsl', CLAUDE, 'Ubuntu', world().deps)).toEqual([]);
    const { deps } = world({ env: { PATH: '/w' }, executables: ['/w/wt.exe'] });
    expect(terminalPresets('wsl', null, 'Ubuntu', deps)).toEqual([]);
  });

  it('offers Windows Terminal natively on Windows only', () => {
    const win = world({ platform: 'win32', env: { PATH: 'C:\\w' }, executables: ['C:\\w\\wt.exe'] });
    expect(terminalPresets('win32', 'C:\\claude.exe', null, win.deps).map((p) => p.id)).toEqual(['wt']);
    expect(terminalPresets('win32', 'C:\\claude.exe', null, win.deps)[0]?.argv).toEqual([
      'wt.exe', '-w', '0', 'new-tab', '--title', '{name}', '-d', '{cwd}', 'C:\\claude.exe', 'attach', '{id}',
    ]);
    const linux = world({ env: { PATH: '/w' }, executables: ['/w/wt.exe'] });
    expect(terminalPresets('linux', CLAUDE, null, linux.deps)).toEqual([]);
  });

  it('offers $TERMINAL and x-terminal-emulator on Linux', () => {
    const { deps } = world({
      env: { PATH: '/usr/bin', TERMINAL: 'kitty' },
      executables: ['/usr/bin/kitty', '/usr/bin/x-terminal-emulator'],
    });
    expect(terminalPresets('linux', CLAUDE, null, deps)).toEqual([
      { id: 'terminal-env', label: '$TERMINAL (kitty)', argv: ['/usr/bin/kitty', '-e', CLAUDE, 'attach', '{id}'] },
      { id: 'x-terminal-emulator', label: 'x-terminal-emulator', argv: ['/usr/bin/x-terminal-emulator', '-e', CLAUDE, 'attach', '{id}'] },
    ]);
  });

  it('ignores a $TERMINAL that is a command line or not installed, and WSL gets no Linux terminals', () => {
    const odd = world({ env: { PATH: '/usr/bin', TERMINAL: 'kitty --single-instance' }, executables: ['/usr/bin/kitty'] });
    expect(terminalPresets('linux', CLAUDE, null, odd.deps)).toEqual([]);
    const wsl = world({ env: { PATH: '/usr/bin' }, executables: ['/usr/bin/x-terminal-emulator'] });
    expect(terminalPresets('wsl', CLAUDE, 'Ubuntu', wsl.deps)).toEqual([]);
  });

  const mac = (paths: string[]) => terminalPresets('darwin', CLAUDE, null, world({ platform: 'darwin', paths }).deps);

  it('offers Terminal and iTerm on macOS when the apps exist', () => {
    expect(mac([]).map((p) => p.id)).toEqual([]);
    expect(mac(['/System/Applications/Utilities/Terminal.app']).map((p) => p.id)).toEqual(['macos-terminal']);
    expect(mac(['/Applications/Utilities/Terminal.app']).map((p) => p.id)).toEqual(['macos-terminal']);
    expect(mac([
      '/Applications/Utilities/Terminal.app', '/Applications/iTerm.app',
    ]).map((p) => p.id)).toEqual(['macos-terminal', 'iterm']);
  });

  it('passes the session values to AppleScript as arguments, never inside script text', () => {
    const presets = mac(['/Applications/Utilities/Terminal.app', '/Applications/iTerm.app']);
    expect(presets).toHaveLength(2);
    for (const { argv } of presets) {
      expect(argv[0]).toBe('osascript');
      const scripts = argv.flatMap((arg, i) => (argv[i - 1] === '-e' ? [arg] : []));
      expect(scripts.length).toBeGreaterThan(2);
      expect(scripts[0]).toBe('on run argv');
      expect(scripts.at(-1)).toBe('end run');
      for (const script of scripts) {
        expect(script).not.toMatch(/[{}]/);
        expect(script).not.toContain(CLAUDE);
      }
      // The values follow the last script, as separate arguments.
      expect(argv.slice(-3)).toEqual(['{cwd}', CLAUDE, '{id}']);
      expect(scripts.join('\n')).toContain('quoted form of item 1 of argv');
    }
  });
});

describe('desktop app', () => {
  it.each([
    ['darwin', 'arm64', true],
    ['darwin', 'x64', true],
    ['win32', 'x64', true],
    ['win32', 'arm64', false],
    ['linux', 'x64', false],
  ] as const)('on %s/%s it is %s', async (platform, arch, expected) => {
    const detected = await detectSetup(world({ platform, arch }).deps, { repoPath: '/g/core', sessionCwds: [] });
    expect(detected.desktopResume).toBe(expected);
  });

  it('is off on WSL', async () => {
    const { deps } = world({ env: { WSL_DISTRO_NAME: 'Ubuntu' } });
    expect((await detectSetup(deps, { repoPath: '/g/core', sessionCwds: [] })).desktopResume).toBe(false);
  });
});

describe('repo clone discovery', () => {
  const CORE = 'git@github.com:paranext/paranext-core.git';
  const STUDIO = 'https://github.com/paranext/paratext-10-studio.git';
  const main = (dir: string, remote: string | undefined) => ({ toplevel: dir, common: `${dir}/.git`, remote });
  const worktree = (dir: string, mainDir: string, remote: string) => ({ toplevel: dir, common: `${mainDir}/.git`, remote });

  const clones = {
    children: { '/g': ['/g/aaa-core', '/g/core', '/g/core-wt', '/g/notes', '/g/studio', '/g/bare'] },
    paths: ['/g/aaa-core/.git', '/g/core/.git', '/g/core-wt/.git', '/g/studio/.git', '/g/bare/.git'],
    repos: {
      '/g/core': main('/g/core', CORE),
      '/g/aaa-core': main('/g/aaa-core', CORE),
      '/g/core-wt': worktree('/g/core-wt', '/g/core', CORE),
      '/g/studio': main('/g/studio', STUDIO),
      '/g/bare': main('/g/bare', undefined),
      '/g/core/.claude/worktrees/x': worktree('/g/core/.claude/worktrees/x', '/g/core', CORE),
    },
  };

  it('finds clones by repo, preferring repoPath, then main clones, then worktrees', async () => {
    const { deps } = world(clones);
    const found = await findRepoClones(deps, {
      repoPath: '/g/core', sessionCwds: ['/g/core/.claude/worktrees/x'],
    });
    expect(found['paranext/paranext-core']).toEqual(['/g/core', '/g/aaa-core', '/g/core-wt']);
    expect(found['paranext/paratext-10-studio']).toEqual(['/g/studio']);
    expect(Object.keys(found).sort()).toEqual(['paranext/paranext-core', 'paranext/paratext-10-studio']);
  });

  it('turns a session running in a worktree into its main clone', async () => {
    const { deps } = world({ ...clones, children: {} });
    const found = await findRepoClones(deps, {
      repoPath: '/elsewhere/core', sessionCwds: ['/g/core/.claude/worktrees/x', '/g/studio'],
    });
    expect(found['paranext/paranext-core']).toEqual(['/g/core']);
    expect(found['paranext/paratext-10-studio']).toEqual(['/g/studio']);
  });

  it('skips directories that are not git repos or whose git calls fail', async () => {
    const { deps } = world({
      children: { '/g': ['/g/notes'] }, paths: [], repos: {},
    });
    expect(await findRepoClones(deps, { repoPath: '/g/core', sessionCwds: ['/nowhere'] })).toEqual({});
  });

  it('scans at most 200 directories and gives each git call 2 seconds', async () => {
    const dirs = Array.from({ length: 500 }, (_, i) => `/g/r${i}`);
    const { deps, calls } = world({
      children: { '/g': dirs },
      paths: dirs.map((d) => `${d}/.git`),
      repos: Object.fromEntries(dirs.map((d, i) => [d, main(d, `git@github.com:o/r${i}.git`)])),
    });
    const found = await findRepoClones(deps, {
      repoPath: '/g/core', sessionCwds: Array.from({ length: 300 }, (_, i) => `/s/${i}`),
    });
    const scanned = new Set(calls.filter((c) => c.file === 'git').map((c) => c.args[1]));
    expect(scanned.size).toBeLessThanOrEqual(MAX_DIRS_SCANNED);
    expect(MAX_DIRS_SCANNED).toBe(200);
    expect(calls.every((c) => c.file !== 'git' || c.timeout === 2000)).toBe(true);
    expect(Object.keys(found).length).toBeLessThanOrEqual(200);
  });
});

describe('checkRepoFolder', () => {
  const ok = world({
    directories: ['/g/core'],
    repos: { '/g/core': { remote: 'git@github.com:Paranext/Paranext-Core.git' } },
  });

  it('accepts an existing clone of the repo, ignoring case', async () => {
    expect(await checkRepoFolder(ok.deps, 'paranext/paranext-core', '/g/core')).toBeNull();
  });

  it('rejects a relative path, a missing folder and a clone of another repo', async () => {
    expect(await checkRepoFolder(ok.deps, 'paranext/paranext-core', 'g/core')).toMatch(/absolute/);
    expect(await checkRepoFolder(ok.deps, 'paranext/paranext-core', '/g/missing')).toMatch(/exists/);
    expect(await checkRepoFolder(ok.deps, 'paranext/other', '/g/core')).toMatch(/paranext\/paranext-core, not paranext\/other/);
  });

  it('rejects a folder with no GitHub origin', async () => {
    const bare = world({ directories: ['/g/x'] });
    expect(await checkRepoFolder(bare.deps, 'o/n', '/g/x')).toMatch(/origin/);
  });
});

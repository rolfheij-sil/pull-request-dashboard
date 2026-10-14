import { describe, expect, it } from 'vitest';
import {
  claudeAiUrl, listSessions, prKeyFromUrl, repoFromRemote, resolveClaudeDir, type ListDeps,
} from '../src/sessions/list.js';
import { createSessionService } from '../src/sessions/service.js';

interface FakeOptions {
  /** What `claude agents --json --all` prints; an Error rejects. */
  agents: unknown;
  /** Files by absolute path. */
  files?: Record<string, string>;
  /** Git answers by `<cwd> <subcommand>`. */
  git?: Record<string, string | Error>;
}

const fakeDeps = (options: FakeOptions) => {
  const calls: { file: string; args: string[] }[] = [];
  const deps: ListDeps = {
    exec: async (file, args) => {
      calls.push({ file, args });
      if (file === 'git') {
        const cwd = args[1]!;
        const key = `${cwd} ${args[2] === 'rev-parse' ? 'branch' : 'remote'}`;
        const answer = options.git?.[key];
        if (answer === undefined || answer instanceof Error) throw answer ?? new Error('not a repo');
        return `${answer}\n`;
      }
      if (options.agents instanceof Error) throw options.agents;
      return typeof options.agents === 'string' ? options.agents : JSON.stringify(options.agents);
    },
    readText: (path) => options.files?.[path] ?? null,
    env: {},
    homeDir: '/home/me',
  };
  return { deps, calls };
};

const agent = (over: Record<string, unknown> = {}) => ({
  pid: 100, id: 'abc12345', cwd: '/repo', kind: 'background', startedAt: 5000,
  sessionId: 'uuid-1', name: 'work on #12', status: 'busy', state: 'working', ...over,
});

const CLAUDE_DIR = '/home/me/.claude';

describe('listSessions', () => {
  it('lists sessions from the CLI without a shell', async () => {
    const { deps, calls } = fakeDeps({ agents: [agent()] });
    const { sessions, error } = await listSessions({}, deps);
    expect(error).toBeNull();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'abc12345', sessionId: 'uuid-1', name: 'work on #12', kind: 'background',
      status: 'busy', state: 'working', cwd: '/repo', startedAt: 5000,
    });
    expect(calls[0]).toEqual({ file: 'claude', args: ['agents', '--json', '--all'] });
  });

  it('uses the configured CLI path', async () => {
    const { deps, calls } = fakeDeps({ agents: [] });
    await listSessions({ claudeCommand: '/opt/claude' }, deps);
    expect(calls[0]?.file).toBe('/opt/claude');
  });

  it('returns no sessions and the message when the CLI fails', async () => {
    const { deps } = fakeDeps({ agents: new Error('spawn claude ENOENT') });
    expect(await listSessions({}, deps)).toEqual({ sessions: [], error: 'spawn claude ENOENT' });
  });

  it('returns no sessions and an error when the CLI prints something that is not JSON', async () => {
    const { deps } = fakeDeps({ agents: 'Welcome to Claude' });
    const { sessions, error } = await listSessions({}, deps);
    expect(sessions).toEqual([]);
    expect(error).not.toBeNull();
  });

  it('returns an error when the JSON is not an array', async () => {
    const { deps } = fakeDeps({ agents: { sessions: [] } });
    const { sessions, error } = await listSessions({}, deps);
    expect(sessions).toEqual([]);
    expect(error).toMatch(/unexpected output/);
  });

  it('skips entries without a session id and tolerates odd field values', async () => {
    const { deps } = fakeDeps({
      agents: [
        null, 'x', { name: 'no session id' },
        { sessionId: 'uuid-2', kind: 'weird', status: 'sleeping', state: 7, startedAt: 'soon', cwd: 4 },
      ],
    });
    const { sessions } = await listSessions({}, deps);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: null, kind: 'interactive', status: null, state: null, startedAt: 0, cwd: '', name: '',
    });
  });

  it('enriches a background session from its job state, found by id', async () => {
    const { deps } = fakeDeps({
      agents: [agent()],
      files: {
        [`${CLAUDE_DIR}/jobs/abc12345/state.json`]: JSON.stringify({
          children: [
            { id: 'c1', kind: 'pr', href: 'https://github.com/Paranext/Paranext-Core/pull/2880' },
            { id: 'c2', kind: 'file', href: 'https://github.com/x/y/pull/1' },
            { id: 'c3', kind: 'pr', href: 'not a url' },
          ],
          intent: 'review #12 please',
          worktreeBranch: 'pt-12-thing',
        }),
      },
    });
    const [session] = (await listSessions({}, deps)).sessions;
    expect(session?.prLinks).toEqual(['paranext/paranext-core#2880']);
    expect(session?.intent).toBe('review #12 please');
    expect(session?.branch).toBe('pt-12-thing');
  });

  it('ignores a job state that is malformed or has the wrong shape', async () => {
    for (const text of ['{not json', '[]', 'null', '{"children": "nope", "intent": 5}']) {
      const { deps } = fakeDeps({
        agents: [agent()],
        files: { [`${CLAUDE_DIR}/jobs/abc12345/state.json`]: text },
      });
      const { sessions, error } = await listSessions({}, deps);
      expect(error).toBeNull();
      expect(sessions[0]).toMatchObject({ prLinks: [], intent: '', claudeAiUrl: null });
    }
  });

  it('does not read job state for a session with no short id', async () => {
    const { deps } = fakeDeps({
      agents: [agent({ id: undefined, kind: 'interactive' })],
      files: { [`${CLAUDE_DIR}/jobs/undefined/state.json`]: '{"intent":"wrong"}' },
    });
    expect((await listSessions({}, deps)).sessions[0]?.intent).toBe('');
  });

  it('builds the claude.ai url from the process record', async () => {
    const { deps } = fakeDeps({
      agents: [agent()],
      files: { [`${CLAUDE_DIR}/sessions/100.json`]: JSON.stringify({ bridgeSessionId: 'session_01AB' }) },
    });
    expect((await listSessions({}, deps)).sessions[0]?.claudeAiUrl)
      .toBe('https://claude.ai/code/session_01AB');
  });

  it('turns the job cse_ bridge id into the session_ form', async () => {
    const { deps } = fakeDeps({
      agents: [agent()],
      files: { [`${CLAUDE_DIR}/jobs/abc12345/state.json`]: JSON.stringify({ bridgeSessionId: 'cse_01AB' }) },
    });
    expect((await listSessions({}, deps)).sessions[0]?.claudeAiUrl)
      .toBe('https://claude.ai/code/session_01AB');
  });

  it('reads an interactive session from its process record alone', async () => {
    const { deps } = fakeDeps({
      agents: [agent({ id: undefined, kind: 'interactive', pid: 55 })],
      files: { [`${CLAUDE_DIR}/sessions/55.json`]: JSON.stringify({ bridgeSessionId: 'session_ZZ' }) },
    });
    expect((await listSessions({}, deps)).sessions[0]?.claudeAiUrl)
      .toBe('https://claude.ai/code/session_ZZ');
  });

  it('reads the data directory from the config, then CLAUDE_CONFIG_DIR, then ~/.claude', async () => {
    expect(resolveClaudeDir({ claudeDir: '~/elsewhere' }, fakeDeps({ agents: [] }).deps))
      .toBe('/home/me/elsewhere');
    const withEnv = { ...fakeDeps({ agents: [] }).deps, env: { CLAUDE_CONFIG_DIR: '/env/claude' } };
    expect(resolveClaudeDir({}, withEnv)).toBe('/env/claude');
    expect(resolveClaudeDir({ claudeDir: '/cfg' }, withEnv)).toBe('/cfg');
    expect(resolveClaudeDir({}, fakeDeps({ agents: [] }).deps)).toBe('/home/me/.claude');
  });

  it('finds the branch and repo from git, asking once per directory', async () => {
    const { deps, calls } = fakeDeps({
      agents: [agent(), agent({ id: 'def', sessionId: 'uuid-3' })],
      git: {
        '/repo branch': 'pt-9-fix',
        '/repo remote': 'git@github.com:Paranext/Paranext-Core.git',
      },
    });
    const { sessions } = await listSessions({}, deps);
    expect(sessions.map((s) => [s.branch, s.repo])).toEqual([
      ['pt-9-fix', 'paranext/paranext-core'], ['pt-9-fix', 'paranext/paranext-core'],
    ]);
    expect(calls.filter((c) => c.file === 'git')).toHaveLength(2);
    expect(calls.find((c) => c.file === 'git')?.args.slice(0, 2)).toEqual(['-C', '/repo']);
  });

  it('leaves branch and repo null when git fails or HEAD is detached', async () => {
    const failing = fakeDeps({ agents: [agent()] });
    expect((await listSessions({}, failing.deps)).sessions[0]).toMatchObject({ branch: null, repo: null });
    const detached = fakeDeps({ agents: [agent()], git: { '/repo branch': 'HEAD' } });
    expect((await listSessions({}, detached.deps)).sessions[0]?.branch).toBeNull();
  });

  it('prefers the job worktree branch over git', async () => {
    const { deps } = fakeDeps({
      agents: [agent()],
      files: { [`${CLAUDE_DIR}/jobs/abc12345/state.json`]: '{"worktreeBranch":"wt-branch"}' },
      git: { '/repo branch': 'main' },
    });
    expect((await listSessions({}, deps)).sessions[0]?.branch).toBe('wt-branch');
  });
});

describe('parsing helpers', () => {
  it.each([
    ['https://github.com/o/n.git', 'o/n'],
    ['https://github.com/O/N', 'o/n'],
    ['git@github.com:o/n.git', 'o/n'],
    ['ssh://git@github.com/o/n.git', 'o/n'],
    ['https://github.com/o/n/', 'o/n'],
  ])('reads the repo from %s', (remote, repo) => {
    expect(repoFromRemote(remote)).toBe(repo);
  });

  it('gives no repo for a non-GitHub remote', () => {
    expect(repoFromRemote('https://example.com/o/n.git')).toBeNull();
  });

  it('keys a PR url by lowercased repo and number', () => {
    expect(prKeyFromUrl('https://github.com/Paranext/X/pull/9')).toBe('paranext/x#9');
    expect(prKeyFromUrl('https://github.com/paranext/x/issues/9')).toBeNull();
  });

  it('maps both bridge id forms to the session_ url and rejects others', () => {
    expect(claudeAiUrl('cse_X1')).toBe('https://claude.ai/code/session_X1');
    expect(claudeAiUrl('session_X1')).toBe('https://claude.ai/code/session_X1');
    expect(claudeAiUrl('other')).toBeNull();
    expect(claudeAiUrl(null)).toBeNull();
  });
});

describe('createSessionService', () => {
  it('keeps the latest listing, finds sessions by short id and shares concurrent refreshes', async () => {
    const { deps, calls } = fakeDeps({ agents: [agent()] });
    const service = createSessionService({}, deps);
    expect(service.snapshot()).toEqual({ sessions: [], error: null });
    await Promise.all([service.refresh(), service.refresh()]);
    expect(calls.filter((c) => c.file === 'claude')).toHaveLength(1);
    expect(service.findById('abc12345')?.sessionId).toBe('uuid-1');
    expect(service.findById('nope')).toBeUndefined();
  });
});

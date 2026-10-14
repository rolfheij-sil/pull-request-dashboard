import { describe, expect, it } from 'vitest';
import { attachSessions, linkSessions, matchOne } from '../src/sessions/match.js';
import type { SessionInfo } from '../src/sessions/types.js';
import { buildBoard } from '../src/server/poller.js';
import { openStore } from '../src/store/db.js';
import type { Config, PrInput } from '../src/types.js';

const HOME = 'paranext/paranext-core';
const STUDIO = 'paranext/paratext-10-studio';
const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'me', botLogins: [], pollIntervalMs: 180000, staleAfterHours: 48,
};
const NOW = new Date('2026-09-11T12:00:00Z');

const pr = (over: Partial<PrInput>): PrInput => ({
  repo: HOME, number: 1, title: 't', url: `https://github.com/${HOME}/pull/1`,
  author: 'me', updatedAt: '2026-09-10T00:00:00Z', isDraft: false, headOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviews: [], comments: [],
  commits: [{
    oid: 'abc', committedDate: '2026-09-01T00:00:00Z', authorLogin: 'me',
    authorEmail: null, messageHeadline: 'work', parentCount: 1,
  }],
  threads: [], checks: [], ...over,
});

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'aaaa1111', sessionId: 'sess-1', name: 'unrelated', kind: 'background',
  status: 'idle', state: 'done', cwd: '/work', startedAt: 1000, branch: null, repo: null,
  prLinks: [], intent: '', claudeAiUrl: null, ...over,
});

const target = (over: Partial<Parameters<typeof matchOne>[1]> = {}) => ({
  repo: HOME, number: 2880, url: `https://github.com/${HOME}/pull/2880`,
  headRefName: 'pt-1-feature' as string | null, ...over,
});

const ctx = { error: null, actions: { openTerminal: false, openDesktop: false, startSession: false } };

describe('matchOne', () => {
  it('matches a PR the session recorded, whatever its name says', () => {
    const s = session({ prLinks: [`${HOME}#2880`] });
    expect(matchOne(s, target(), 1)).toBe('recorded');
  });

  it('matches the PR url in the name or the first prompt, case-insensitively', () => {
    const url = `https://GitHub.com/${HOME}/pull/2880`;
    expect(matchOne(session({ name: `look at ${url}` }), target(), 1)).toBe('url');
    expect(matchOne(session({ intent: `please review ${url} now` }), target(), 1)).toBe('url');
  });

  it('does not take a longer PR number in a url for a shorter one', () => {
    const s = session({ name: `https://github.com/${HOME}/pull/28800` });
    expect(matchOne(s, target(), 2)).toBeNull();
  });

  it('matches a url at the end of a sentence', () => {
    const s = session({ intent: `fix https://github.com/${HOME}/pull/2880.` });
    expect(matchOne(s, target(), 1)).toBe('url');
  });

  it('matches the PR head branch in the same repo', () => {
    const s = session({ branch: 'pt-1-feature', repo: HOME });
    expect(matchOne(s, target(), 1)).toBe('branch');
  });

  it('does not match the same branch name in another repo', () => {
    const s = session({ branch: 'pt-1-feature', repo: STUDIO });
    expect(matchOne(s, target(), 2)).toBeNull();
  });

  it('does not match when the session repo is unknown', () => {
    expect(matchOne(session({ branch: 'pt-1-feature', repo: null }), target(), 1)).toBeNull();
  });

  it.each(['main', 'master'])('never matches on %s', (branch) => {
    const s = session({ branch, repo: HOME });
    expect(matchOne(s, target({ headRefName: branch }), 1)).toBeNull();
  });

  it('does not match a branch when the PR head branch is unknown', () => {
    expect(matchOne(session({ branch: 'x', repo: HOME }), target({ headRefName: null }), 1)).toBeNull();
  });

  it('matches #<number> in the name or first prompt when the session repo is the PR repo', () => {
    expect(matchOne(session({ name: 'fix #2880', repo: HOME }), target(), 2)).toBe('number');
    expect(matchOne(session({ intent: 'see (#2880)', repo: HOME }), target(), 2)).toBe('number');
  });

  it('matches #<number> from an unknown repo only when the number is unique on the board', () => {
    const s = session({ name: 'fix #2880', repo: null });
    expect(matchOne(s, target(), 1)).toBe('number');
    expect(matchOne(s, target(), 2)).toBeNull();
  });

  it('lets the session repo settle a number shared across repos', () => {
    const s = session({ name: 'fix #2880', repo: STUDIO });
    expect(matchOne(s, target({ repo: STUDIO }), 2)).toBe('number');
    expect(matchOne(s, target({ repo: HOME }), 2)).toBeNull();
  });

  it('does not match #2880 against #28800 or #288', () => {
    expect(matchOne(session({ name: 'fix #28800', repo: HOME }), target(), 1)).toBeNull();
    expect(matchOne(session({ name: 'fix #288', repo: HOME }), target(), 1)).toBeNull();
    expect(matchOne(session({ name: 'fix #28800', repo: HOME }), target({ number: 28800 }), 1))
      .toBe('number');
  });

  it('does not take a bare number for a PR reference', () => {
    expect(matchOne(session({ name: 'fix 2880', repo: HOME }), target(), 1)).toBeNull();
  });

  it('returns null for an unrelated session', () => {
    expect(matchOne(session(), target(), 1)).toBeNull();
  });
});

describe('linkSessions', () => {
  it('keeps the strongest evidence per session', () => {
    const s = session({
      prLinks: [`${HOME}#2880`], name: 'fix #2880', branch: 'pt-1-feature', repo: HOME,
    });
    expect(linkSessions(target(), [s], 1).map((l) => l.matchedBy)).toEqual(['recorded']);
  });

  it('ranks url above branch above number', () => {
    const url = `https://github.com/${HOME}/pull/2880`;
    const both = session({ name: `#2880 ${url}`, branch: 'pt-1-feature', repo: HOME });
    const branchAndNumber = session({ name: '#2880', branch: 'pt-1-feature', repo: HOME });
    expect(linkSessions(target(), [both], 1)[0]?.matchedBy).toBe('url');
    expect(linkSessions(target(), [branchAndNumber], 1)[0]?.matchedBy).toBe('branch');
  });

  it('puts live sessions before ended ones, busy or waiting before idle, then newest first', () => {
    const link = { prLinks: [`${HOME}#2880`] };
    const sessions = [
      session({ ...link, sessionId: 'ended-new', status: null, state: 'done', startedAt: 9000 }),
      session({ ...link, sessionId: 'idle-new', status: 'idle', startedAt: 8000 }),
      session({ ...link, sessionId: 'busy-old', status: 'busy', startedAt: 1000 }),
      session({ ...link, sessionId: 'waiting-new', status: 'waiting', startedAt: 5000 }),
      session({ ...link, sessionId: 'ended-old', status: null, state: 'stopped', startedAt: 100 }),
    ];
    expect(linkSessions(target(), sessions, 1).map((l) => l.sessionId)).toEqual([
      'waiting-new', 'busy-old', 'idle-new', 'ended-new', 'ended-old',
    ]);
  });

  it('carries the fields the board shows and nothing else', () => {
    const s = session({
      prLinks: [`${HOME}#2880`], claudeAiUrl: 'https://claude.ai/code/session_x', intent: 'secret',
    });
    expect(linkSessions(target(), [s], 1)[0]).toEqual({
      id: 'aaaa1111', sessionId: 'sess-1', name: 'unrelated', kind: 'background',
      status: 'idle', state: 'done', cwd: '/work', matchedBy: 'recorded',
      claudeAiUrl: 'https://claude.ai/code/session_x',
    });
  });
});

describe('attachSessions', () => {
  const board = () => buildBoard(
    [pr({ number: 2880, url: `https://github.com/${HOME}/pull/2880`, headRefName: 'pt-1-feature' })],
    [], openStore(':memory:', HOME), cfg, NOW,
    [pr({
      repo: STUDIO, number: 7, author: 'alice',
      url: `https://github.com/${STUDIO}/pull/7`, headRefName: 'alice-work',
    })],
  );

  it('links sessions to own and reviewing items', () => {
    const attached = attachSessions(board(), [
      session({ sessionId: 'a', prLinks: [`${HOME}#2880`] }),
      session({ sessionId: 'b', branch: 'alice-work', repo: STUDIO }),
    ], ctx);
    expect(attached.items[0]?.sessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(attached.reviewing[0]?.sessions.map((s) => s.sessionId)).toEqual(['b']);
  });

  it('settles a number that exists in both repos by the session repo', () => {
    const shared = buildBoard(
      [pr({ number: 7, url: `https://github.com/${HOME}/pull/7` })],
      [], openStore(':memory:', HOME), cfg, NOW,
      [pr({ repo: STUDIO, number: 7, author: 'alice', url: `https://github.com/${STUDIO}/pull/7` })],
    );
    const attached = attachSessions(shared, [session({ name: 'fix #7', repo: STUDIO })], ctx);
    expect(attached.items[0]?.sessions).toEqual([]);
    expect(attached.reviewing[0]?.sessions).toHaveLength(1);
  });

  it('does not change the board it was given', () => {
    const original = board();
    attachSessions(original, [session({ prLinks: [`${HOME}#2880`] })], ctx);
    expect(original.items[0]?.sessions).toEqual([]);
  });

  it('reports the listing error and which buttons the client may offer', () => {
    const attached = attachSessions(board(), [], {
      error: 'claude: not found', actions: { openTerminal: true, openDesktop: false, startSession: true },
    });
    expect(attached.sessionsError).toBe('claude: not found');
    expect(attached.sessionActions).toEqual({ openTerminal: true, openDesktop: false, startSession: true });
  });

  it('marks only items whose repo has a local clone as startable, with a preview', () => {
    const attached = attachSessions(board(), [], {
      ...ctx, repoPaths: { 'Paranext/Paranext-Core': '/home/me/core' },
    });
    expect(attached.items[0]?.canStartSession).toBe(true);
    expect(attached.items[0]?.startPreview?.name).toBe('paranext-core #2880 t');
    expect(attached.items[0]?.startPreview?.prompt).toContain('/pull/2880');
    expect(attached.reviewing[0]?.canStartSession).toBe(false);
    expect(attached.reviewing[0]?.startPreview).toBeNull();
  });

  it('carries the PR head branch through buildBoard', () => {
    expect(board().items[0]?.headRefName).toBe('pt-1-feature');
    expect(buildBoard([pr({})], [], openStore(':memory:', HOME), cfg, NOW).items[0]?.headRefName)
      .toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markPostedToDiscord, startSession, UntrustedWorkspaceError, type SetupResponse,
} from '../client/src/api.js';
import {
  actionAriaLabel, buildPatch, copyCommand, dotKind, draftFrom, orderActions, platformLabel,
  primaryActionChoices, repoRows, sameDraft, sessionDisplayName, shellQuote, splitSessions,
  startSessionAriaLabel, statusLabel, unownedErrors, VISIBLE_SESSIONS,
} from '../client/src/sessions.js';
import {
  fillArgv, fillTemplate, isWindowsTerminal, unknownPlaceholders,
} from '../src/sessions/template.js';

describe('copyCommand', () => {
  it('attaches to a background session by its short id', () => {
    expect(copyCommand({ kind: 'background', id: 'ce0b613c', sessionId: 'u', cwd: '/w' }))
      .toBe("claude attach 'ce0b613c'");
  });

  it('resumes an interactive session from its directory', () => {
    expect(copyCommand({ kind: 'interactive', id: null, sessionId: 'uuid-1', cwd: '/home/me/core' }))
      .toBe("cd -- '/home/me/core' && claude --resume 'uuid-1'");
  });

  it('resumes a background session that has no short id', () => {
    expect(copyCommand({ kind: 'background', id: null, sessionId: 'uuid-1', cwd: '/w' }))
      .toBe("cd -- '/w' && claude --resume 'uuid-1'");
  });

  it('quotes a directory containing a single quote so the shell reads it as one word', () => {
    expect(copyCommand({ kind: 'interactive', id: null, sessionId: 'u', cwd: "/home/me/it's mine" }))
      .toBe("cd -- '/home/me/it'\\''s mine' && claude --resume 'u'");
  });

  it.each([
    '; touch pwned', '$(touch pwned)', '`id`', 'a b', '-rf', "it's", '--help',
  ])('keeps %j inert in the id, the session id and the directory', (value) => {
    const quoted = shellQuote(value);
    expect(copyCommand({ kind: 'background', id: value, sessionId: 'u', cwd: '/w' }))
      .toBe(`claude attach ${quoted}`);
    expect(copyCommand({ kind: 'interactive', id: null, sessionId: value, cwd: value }))
      .toBe(`cd -- ${quoted} && claude --resume ${quoted}`);
    expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
  });

  it('keeps shell metacharacters in a directory inert', () => {
    expect(shellQuote('/a b/$(x);`y`')).toBe("'/a b/$(x);`y`'");
  });
});

describe('accessible names', () => {
  it('names each session button after its session', () => {
    expect(actionAriaLabel('copy', 'work on #12')).toBe('Copy command for work on #12');
    expect(actionAriaLabel('claudeAi', 'S')).toBe('Open S on claude.ai');
    expect(actionAriaLabel('terminal', 'S')).toBe('Open S in a terminal');
    expect(actionAriaLabel('desktop', 'S')).toBe('Open S in the desktop app');
    expect(startSessionAriaLabel('o/r', 7)).toBe('Start a session for o/r #7');
  });

  it('falls back to the session id when a session has no name', () => {
    expect(sessionDisplayName({ name: '', sessionId: 'uuid-1' })).toBe('uuid-1');
    expect(sessionDisplayName({ name: 'N', sessionId: 'uuid-1' })).toBe('N');
  });
});

describe('api calls', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const respond = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  })));

  it('markPostedToDiscord fails when the server refuses', async () => {
    respond(403, {});
    await expect(markPostedToDiscord('o/r', 1, true)).rejects.toThrow(/403/);
    respond(200, { ok: true });
    await expect(markPostedToDiscord('o/r', 1, true)).resolves.toBeUndefined();
  });

  it('startSession turns the untrusted-workspace answer into an error carrying the command', async () => {
    respond(409, { error: 'untrusted-workspace', folder: '/f', command: "cd -- '/f' && claude" });
    const error = await startSession('o/r', 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UntrustedWorkspaceError);
    expect(error).toMatchObject({ folder: '/f', command: "cd -- '/f' && claude" });
  });

  it('startSession reports other failures with the server message', async () => {
    respond(500, { error: 'boom' });
    await expect(startSession('o/r', 1)).rejects.toThrow('boom');
  });
});

describe('status helpers', () => {
  it('maps a live status to its own dot and no status to an ended dot', () => {
    expect(dotKind('busy')).toBe('busy');
    expect(dotKind('waiting')).toBe('waiting');
    expect(dotKind('idle')).toBe('idle');
    expect(dotKind(null)).toBe('ended');
  });

  it('labels live sessions by status and finished ones by state', () => {
    expect(statusLabel({ status: 'busy', state: 'working' })).toBe('working');
    expect(statusLabel({ status: 'waiting', state: 'blocked' })).toBe('waiting for you');
    expect(statusLabel({ status: 'idle', state: 'done' })).toBe('idle');
    expect(statusLabel({ status: null, state: 'done' })).toBe('finished');
    expect(statusLabel({ status: null, state: 'failed' })).toBe('failed');
    expect(statusLabel({ status: null, state: null })).toBe('not running');
  });
});

describe('splitSessions', () => {
  const five = [1, 2, 3, 4, 5];

  it('shows the first three and counts the rest', () => {
    expect(splitSessions(five, false)).toEqual({ shown: [1, 2, 3], hidden: 2 });
    expect(VISIBLE_SESSIONS).toBe(3);
  });

  it('shows everything when expanded or when there are few', () => {
    expect(splitSessions(five, true)).toEqual({ shown: five, hidden: 0 });
    expect(splitSessions([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], hidden: 0 });
  });
});

describe('templates', () => {
  it('fills only known placeholders, once', () => {
    expect(fillTemplate('{a} {b} {c}', { a: '{b}', b: 'x' })).toBe('{b} x {c}');
  });

  it('does not treat object prototype names as placeholders', () => {
    expect(fillTemplate('{constructor}', {})).toBe('{constructor}');
  });

  it('lists unknown placeholders once each', () => {
    expect(unknownPlaceholders('{id} {x} {x} {y}', ['id'])).toEqual(['x', 'y']);
  });
});

describe('fillArgv', () => {
  const values = { name: 'a;b', cwd: '/w;x', id: 'i' };

  it.each(['wt.exe', 'wt', 'WT.EXE', 'C:\\Windows\\wt.exe', '/mnt/c/Apps/wt.exe'])(
    'escapes each ; in substituted values for %s',
    (program) => {
      expect(isWindowsTerminal(program)).toBe(true);
      expect(fillArgv([program, 'a;b', '{name}', '--x={cwd}', '{id}'], values))
        .toEqual([program, 'a;b', 'a\\;b', '--x=/w\\;x', 'i']);
    },
  );

  it('leaves values untouched for any other program', () => {
    expect(isWindowsTerminal('/usr/bin/wt-like')).toBe(false);
    expect(fillArgv(['/usr/bin/xterm', '{name}', '{cwd}'], values))
      .toEqual(['/usr/bin/xterm', 'a;b', '/w;x']);
  });
});

describe('orderActions', () => {
  it('puts the primary action first and marks only it as main', () => {
    expect(orderActions('terminal', ['copy', 'claudeAi', 'terminal'])).toEqual([
      { id: 'terminal', primary: true },
      { id: 'claudeAi', primary: false },
      { id: 'copy', primary: false },
    ]);
  });

  it('keeps a fixed order for the rest, and has no main button when the primary is unavailable', () => {
    expect(orderActions('terminal', ['copy', 'desktop', 'claudeAi'])).toEqual([
      { id: 'claudeAi', primary: false },
      { id: 'desktop', primary: false },
      { id: 'copy', primary: false },
    ]);
  });
});

describe('settings panel helpers', () => {
  it('labels platforms', () => {
    expect(platformLabel('wsl', 'Ubuntu')).toBe('WSL (Ubuntu)');
    expect(platformLabel('wsl', null)).toBe('WSL');
    expect(platformLabel('darwin', null)).toBe('macOS');
    expect(platformLabel('win32', null)).toBe('Windows');
    expect(platformLabel('linux', null)).toBe('Linux');
  });

  it('disables unavailable choices with a reason', () => {
    const none = primaryActionChoices(false, false);
    expect(none.find((c) => c.id === 'terminal')?.disabledReason).toMatch(/terminal/i);
    expect(none.find((c) => c.id === 'desktop')?.disabledReason).toMatch(/macOS and Windows/);
    expect(none.find((c) => c.id === 'copy')?.disabledReason).toBeNull();
    expect(primaryActionChoices(true, true).every((c) => c.disabledReason === null)).toBe(true);
  });

  const setup = (over: Partial<SetupResponse> = {}): SetupResponse => ({
    detected: {
      platform: 'linux', wslDistro: null, desktopResume: false, repoClones: {},
      claude: { path: '/c', version: '1', reason: null, candidates: [] },
      terminals: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    },
    detecting: false,
    saved: {},
    effective: {
      primaryAction: 'terminal', terminalPreset: 'a', repoPaths: { 'o/x': '/d/x' },
      startPrompt: 'P', openTerminalSource: 'detected',
    },
    lockedByConfig: [],
    ...over,
  });

  it('sends nothing when the user changed nothing and nothing was saved', () => {
    const s = setup();
    expect(buildPatch(s, draftFrom(s), ['o/x'])).toEqual({});
  });

  it('sends only what changed', () => {
    const s = setup();
    const draft = { ...draftFrom(s), primaryAction: 'copy' as const, terminalPreset: 'b' };
    expect(buildPatch(s, draft, ['o/x'])).toEqual({ primaryAction: 'copy', terminalPreset: 'b' });
  });

  it('keeps saved folders for repos not on the board and applies the rows', () => {
    const s = setup({ saved: { repoPaths: { 'o/gone': '/g', 'o/x': '/old' } } });
    const draft = draftFrom(s);
    draft.repoPaths['o/x'] = '/new';
    expect(buildPatch(s, draft, ['o/x'])).toEqual({ repoPaths: { 'o/gone': '/g', 'o/x': '/new' } });
    draft.repoPaths['o/x'] = '';
    expect(buildPatch(s, draft, ['o/x'])).toEqual({ repoPaths: { 'o/gone': '/g' } });
  });

  it('never sends a saved folder for a repo config.json now sets', () => {
    const s = setup({
      saved: { repoPaths: { 'o/x': '/saved', 'o/other': '/o' } },
      lockedByConfig: ['repoPaths.o/x'],
    });
    const draft = draftFrom(s);
    draft.repoPaths['o/x'] = '/changed';
    expect(buildPatch(s, draft, ['o/x'])).toEqual({ repoPaths: { 'o/other': '/o' } });
  });

  it('can clear a stale folder for a repo that is not on the board', () => {
    const s = setup({ saved: { repoPaths: { 'o/gone': '/g' } } });
    const draft = draftFrom(s);
    const rows = repoRows(['o/x'], s).map((row) => row.repo);
    expect(rows).toEqual(['o/x', 'o/gone']);
    draft.repoPaths['o/gone'] = '';
    expect(buildPatch(s, draft, rows)).toEqual({ repoPaths: {} });
  });

  it('lists saved folders for repos off the board after the board repos', () => {
    const s = setup({ saved: { repoPaths: { 'o/zed': '/z', 'o/x': '/x', 'o/gone': '/g' } } });
    expect(repoRows(['o/x', 'o/y'], s)).toEqual([
      { repo: 'o/x', onBoard: true }, { repo: 'o/y', onBoard: true },
      { repo: 'o/gone', onBoard: false }, { repo: 'o/zed', onBoard: false },
    ]);
  });

  it('lists every error no field shows itself', () => {
    expect(unownedErrors(
      { primaryAction: 'bad', body: 'expected a JSON object', 'repoPaths.o/x': 'm', 'repoPaths.o/gone': 'g', argv: 'no' },
      ['primaryAction', 'repoPaths.o/x'],
    )).toEqual(['body: expected a JSON object', 'repoPaths.o/gone: g', 'argv: no']);
  });

  it('compares drafts by content', () => {
    const s = setup();
    expect(sameDraft(draftFrom(s), draftFrom(s))).toBe(true);
    const other = draftFrom(s);
    other.repoPaths['o/y'] = '/y';
    expect(sameDraft(draftFrom(s), other)).toBe(false);
    expect(sameDraft(draftFrom(s), { ...draftFrom(s), startPrompt: 'Q' })).toBe(false);
  });

  it('never sends fields config.json locks', () => {
    const s = setup({ lockedByConfig: ['terminalPreset', 'startPrompt', 'repoPaths.o/x'] });
    const draft = { ...draftFrom(s), terminalPreset: 'b', startPrompt: 'Q' };
    draft.repoPaths['o/x'] = '/changed';
    expect(buildPatch(s, draft, ['o/x'])).toEqual({});
  });
});

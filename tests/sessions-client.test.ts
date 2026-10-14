import { describe, expect, it } from 'vitest';
import type { SetupResponse } from '../client/src/api.js';
import {
  buildPatch, copyCommand, dotKind, draftFrom, orderActions, platformLabel,
  primaryActionChoices, shellQuote, splitSessions, statusLabel, VISIBLE_SESSIONS,
} from '../client/src/sessions.js';
import { fillTemplate, unknownPlaceholders } from '../src/sessions/template.js';

describe('copyCommand', () => {
  it('attaches to a background session by its short id', () => {
    expect(copyCommand({ kind: 'background', id: 'ce0b613c', sessionId: 'u', cwd: '/w' }))
      .toBe('claude attach ce0b613c');
  });

  it('resumes an interactive session from its directory', () => {
    expect(copyCommand({ kind: 'interactive', id: null, sessionId: 'uuid-1', cwd: '/home/me/core' }))
      .toBe("cd '/home/me/core' && claude --resume uuid-1");
  });

  it('resumes a background session that has no short id', () => {
    expect(copyCommand({ kind: 'background', id: null, sessionId: 'uuid-1', cwd: '/w' }))
      .toBe("cd '/w' && claude --resume uuid-1");
  });

  it('quotes a directory containing a single quote so the shell reads it as one word', () => {
    expect(copyCommand({ kind: 'interactive', id: null, sessionId: 'u', cwd: "/home/me/it's mine" }))
      .toBe("cd '/home/me/it'\\''s mine' && claude --resume u");
  });

  it('keeps shell metacharacters in a directory inert', () => {
    expect(shellQuote('/a b/$(x);`y`')).toBe("'/a b/$(x);`y`'");
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

  it('never sends fields config.json locks', () => {
    const s = setup({ lockedByConfig: ['terminalPreset', 'startPrompt', 'repoPaths.o/x'] });
    const draft = { ...draftFrom(s), terminalPreset: 'b', startPrompt: 'Q' };
    draft.repoPaths['o/x'] = '/changed';
    expect(buildPatch(s, draft, ['o/x'])).toEqual({});
  });
});

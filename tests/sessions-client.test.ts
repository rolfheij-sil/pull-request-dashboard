import { describe, expect, it } from 'vitest';
import {
  copyCommand, dotKind, shellQuote, splitSessions, statusLabel, VISIBLE_SESSIONS,
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

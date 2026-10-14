import type { LinkedSession, SessionStatus } from './api';

/** Sessions shown on a card before the rest fold behind "+N more". */
export const VISIBLE_SESSIONS = 3;

/** Single-quotes `value` for a POSIX shell, escaping any single quote inside it. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The shell command that brings a session back: attaching to a background
 * session, or resuming an interactive one from the directory it ran in.
 */
export function copyCommand(session: Pick<LinkedSession, 'kind' | 'id' | 'sessionId' | 'cwd'>): string {
  if (session.kind === 'background' && session.id !== null) return `claude attach ${session.id}`;
  return `cd ${shellQuote(session.cwd)} && claude --resume ${session.sessionId}`;
}

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

import { useEffect, useId, useRef, useState } from 'react';
import {
  openSessionDesktop, openSessionTerminal, startSession, UntrustedWorkspaceError,
  type Board, type BoardItem, type LinkedSession,
} from './api';
import { useAnnounce } from './announce';
import {
  actionAriaLabel, copyCommand, dotKind, MATCH_HINT, orderActions, sessionDisplayName,
  splitSessions, startSessionAriaLabel, statusLabel, type SessionActionId,
} from './sessions';

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The clipboard API needs a secure context and permission; fall back below.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'offscreen';
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy was refused');
  } finally {
    area.remove();
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The most of a failed start's output the card shows. */
const START_ERROR_MAX_CHARS = 300;

/** What a button announces to screen readers while it runs and when it ends. */
interface Announcements {
  pending?: string;
  done: string;
  /** The message for a failure, given the error's text. */
  failed: (reason: string) => string;
}

/**
 * Runs `action`, tracks its phase and announces the outcome; with `resetMs`, a
 * finished or failed phase returns to idle after that long.
 */
function useAction(action: () => Promise<void>, announcements: Announcements, resetMs?: number) {
  const announce = useAnnounce();
  const [phase, setPhase] = useState<'idle' | 'pending' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const run = async () => {
    setPhase('pending');
    if (announcements.pending !== undefined) announce(announcements.pending);
    let next: 'done' | 'failed' = 'done';
    try {
      await action();
      announce(announcements.done);
    } catch (error) {
      next = 'failed';
      announce(announcements.failed(errorText(error)));
    }
    setPhase(next);
    if (resetMs !== undefined) {
      timer.current = setTimeout(() => setPhase('idle'), resetMs);
    }
  };
  return { phase, run };
}

/** What the board lets a session row do, and which button leads. */
export interface RowOptions {
  actions: Board['sessionActions'];
  primaryAction: Board['primaryAction'];
}

function SessionRow({ session, options }: {
  session: LinkedSession;
  options: RowOptions;
}) {
  const name = sessionDisplayName(session);
  const whyId = useId();
  const copy = useAction(() => copyText(copyCommand(session)), {
    done: `Copied the command for ${name}`,
    failed: (reason) => `Failed: could not copy the command for ${name} — ${reason}`,
  }, 2000);
  const terminal = useAction(async () => {
    if (session.id !== null) await openSessionTerminal(session.id);
  }, {
    pending: `Opening ${name} in a terminal…`,
    done: `Opened ${name} in a terminal`,
    failed: (reason) => `Failed: could not open ${name} in a terminal — ${reason}`,
  }, 3000);
  const desktop = useAction(() => openSessionDesktop(session.sessionId), {
    pending: `Opening ${name} in the desktop app…`,
    done: `Opened ${name} in the desktop app`,
    failed: (reason) => `Failed: could not open ${name} in the desktop app — ${reason}`,
  }, 3000);
  const label = statusLabel(session);

  const available: SessionActionId[] = ['copy'];
  if (session.claudeAiUrl !== null) available.push('claudeAi');
  if (options.actions.openTerminal && session.id !== null) available.push('terminal');
  if (options.actions.openDesktop) available.push('desktop');

  const button = (id: SessionActionId, primary: boolean) => {
    const className = primary ? 'session-button session-button-primary' : 'session-button';
    const ariaLabel = actionAriaLabel(id, name);
    switch (id) {
      case 'claudeAi':
        return (
          <a
            key={id} className={className} aria-label={ariaLabel}
            href={session.claudeAiUrl ?? undefined} target="_blank" rel="noreferrer"
          >
            claude.ai
          </a>
        );
      case 'terminal':
        return (
          <button
            key={id} type="button" className={className} aria-label={ariaLabel}
            disabled={terminal.phase === 'pending'}
            onClick={() => void terminal.run()}
          >
            {terminal.phase === 'pending' ? 'Opening…'
              : terminal.phase === 'failed' ? 'Failed'
              : 'Terminal'}
          </button>
        );
      case 'desktop':
        return (
          <button
            key={id} type="button" className={className} aria-label={ariaLabel}
            disabled={desktop.phase === 'pending'}
            onClick={() => void desktop.run()}
          >
            {desktop.phase === 'pending' ? 'Opening…'
              : desktop.phase === 'failed' ? 'Failed'
              : 'Desktop app'}
          </button>
        );
      default:
        return (
          <button
            key={id} type="button" className={className} aria-label={ariaLabel}
            onClick={() => void copy.run()}
          >
            {copy.phase === 'done' ? 'Copied' : copy.phase === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
        );
    }
  };

  return (
    <li className="session" title={MATCH_HINT[session.matchedBy]} aria-describedby={whyId}>
      <span className={`session-dot session-dot-${dotKind(session.status)}`} aria-hidden="true" />
      <span className="session-name">{name}</span>
      <span className="session-status">{label}</span>
      <span id={whyId} className="visually-hidden">{MATCH_HINT[session.matchedBy]}</span>
      <span className="session-actions">
        {orderActions(options.primaryAction, available).map(({ id, primary }) => button(id, primary))}
      </span>
    </li>
  );
}

/** The one-time fix for a folder Claude Code has not been allowed to work in. */
function TrustHelp({ repo, error }: { repo: string; error: UntrustedWorkspaceError }) {
  const copy = useAction(() => copyText(error.command), {
    done: `Copied the trust command for ${repo}`,
    failed: (reason) => `Failed: could not copy the trust command for ${repo} — ${reason}`,
  }, 2000);
  return (
    <div className="session-message">
      <p>
        Claude Code hasn't been allowed to work in {error.folder} yet. Run this once in a
        terminal and accept the trust prompt, then try again:
      </p>
      <code>{error.command}</code>{' '}
      <button
        type="button" className="session-button" aria-label={`Copy trust command for ${repo}`}
        onClick={() => void copy.run()}
      >
        {copy.phase === 'done' ? 'Copied' : copy.phase === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
    </div>
  );
}

function StartSession({ item, onStarted }: { item: BoardItem; onStarted: () => void }) {
  const announce = useAnnounce();
  const [message, setMessage] = useState<string | null>(null);
  const [untrusted, setUntrusted] = useState<UntrustedWorkspaceError | null>(null);
  const [pending, setPending] = useState(false);
  const preview = item.startPreview;

  const start = async () => {
    const question = preview === null
      ? 'Start a Claude Code session for this PR?'
      : `Start a Claude Code session?\n\nName: ${preview.name}\n\nPrompt: ${preview.prompt}`;
    if (!window.confirm(question)) return;
    setPending(true);
    setMessage(null);
    setUntrusted(null);
    announce(`Starting a session for ${item.repo} #${item.number}…`);
    try {
      const output = await startSession(item.repo, item.number);
      const text = output === '' ? 'Session started.' : output;
      setMessage(text);
      announce(`Session started for ${item.repo} #${item.number}`);
      onStarted();
    } catch (error) {
      if (error instanceof UntrustedWorkspaceError) {
        setUntrusted(error);
        announce(
          `Claude Code hasn't been allowed to work in ${error.folder} yet. `
          + `Run ${error.command} once in a terminal and accept the trust prompt, then try again.`,
        );
      } else {
        const reason = errorText(error);
        const shown = reason.length <= START_ERROR_MAX_CHARS
          ? reason : `${reason.slice(0, START_ERROR_MAX_CHARS - 1)}…`;
        const text = `Could not start a session — ${shown}`;
        setMessage(text);
        announce(`Failed: ${text}`);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="start-session">
      <button
        type="button" className="session-button" disabled={pending}
        aria-label={startSessionAriaLabel(item.repo, item.number)}
        onClick={() => void start()}
      >
        {pending ? 'Starting…' : 'Start session'}
      </button>
      {message !== null && <span className="session-message">{message}</span>}
      {untrusted !== null && <TrustHelp repo={item.repo} error={untrusted} />}
    </div>
  );
}

/** The Claude Code sessions linked to a card, or a way to start one when there are none. */
export function SessionRows({ item, options, onChange }: {
  item: BoardItem;
  options: RowOptions;
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = splitSessions(item.sessions, expanded);

  if (item.sessions.length === 0) {
    return item.canStartSession ? <StartSession item={item} onStarted={onChange} /> : null;
  }
  return (
    <div className="sessions">
      <ul className="session-list" aria-label="Claude Code sessions">
        {shown.map((session) => (
          <SessionRow key={session.sessionId} session={session} options={options} />
        ))}
      </ul>
      {(hidden > 0 || expanded) && (
        <button type="button" className="session-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

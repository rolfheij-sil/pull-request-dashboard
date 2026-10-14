import { useEffect, useRef, useState } from 'react';
import {
  openSessionTerminal, startSession, type BoardItem, type LinkedSession,
} from './api';
import {
  copyCommand, dotKind, MATCH_HINT, splitSessions, statusLabel,
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

/** Runs `action` and tracks its phase; with `resetMs`, a finished or failed phase returns to idle after that long. */
function useAction(action: () => Promise<void>, resetMs?: number) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const run = async () => {
    setPhase('pending');
    let next: 'done' | 'failed' = 'done';
    try {
      await action();
    } catch {
      next = 'failed';
    }
    setPhase(next);
    if (resetMs !== undefined) {
      timer.current = setTimeout(() => setPhase('idle'), resetMs);
    }
  };
  return { phase, run };
}

function SessionRow({ session, canOpenTerminal }: {
  session: LinkedSession;
  canOpenTerminal: boolean;
}) {
  const copy = useAction(() => copyText(copyCommand(session)), 2000);
  const terminal = useAction(async () => {
    if (session.id !== null) await openSessionTerminal(session.id);
  }, 3000);
  const label = statusLabel(session);

  return (
    <li className="session" title={MATCH_HINT[session.matchedBy]}>
      <span
        className={`session-dot session-dot-${dotKind(session.status)}`}
        role="img"
        aria-label={label}
        title={label}
      />
      <span className="session-name">{session.name || session.sessionId}</span>
      <span className="session-status">{label}</span>
      <span className="session-actions">
        {session.claudeAiUrl !== null && (
          <a className="session-button" href={session.claudeAiUrl} target="_blank" rel="noreferrer">
            claude.ai
          </a>
        )}
        <button type="button" className="session-button" onClick={() => void copy.run()}>
          {copy.phase === 'done' ? 'Copied' : copy.phase === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
        {canOpenTerminal && session.id !== null && (
          <button
            type="button"
            className="session-button"
            disabled={terminal.phase === 'pending'}
            onClick={() => void terminal.run()}
          >
            {terminal.phase === 'pending' ? 'Opening…'
              : terminal.phase === 'failed' ? 'Failed'
              : 'Terminal'}
          </button>
        )}
      </span>
    </li>
  );
}

function StartSession({ item, onStarted }: { item: BoardItem; onStarted: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const preview = item.startPreview;

  const start = async () => {
    const question = preview === null
      ? 'Start a Claude Code session for this PR?'
      : `Start a Claude Code session?\n\nName: ${preview.name}\n\nPrompt: ${preview.prompt}`;
    if (!window.confirm(question)) return;
    setPending(true);
    setMessage(null);
    try {
      const output = await startSession(item.repo, item.number);
      setMessage(output === '' ? 'Session started.' : output);
      onStarted();
    } catch (error) {
      setMessage(`Could not start a session — ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="start-session">
      <button type="button" className="session-button" disabled={pending} onClick={() => void start()}>
        {pending ? 'Starting…' : 'Start session'}
      </button>
      {message !== null && <span className="session-message">{message}</span>}
    </div>
  );
}

/** The Claude Code sessions linked to a card, or a way to start one when there are none. */
export function SessionRows({ item, canOpenTerminal, onChange }: {
  item: BoardItem;
  canOpenTerminal: boolean;
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
          <SessionRow key={session.sessionId} session={session} canOpenTerminal={canOpenTerminal} />
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

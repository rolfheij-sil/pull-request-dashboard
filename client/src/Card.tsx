import type { BoardItem } from './api';
import { markPostedToDiscord } from './api';
import { SessionRows, type RowOptions } from './SessionRows';

const DOT: Record<BoardItem['checkDot'], string> = {
  fail: '#d64545', pending: '#c98a20', pass: '#3f9142', none: 'transparent',
};

/**
 * Ages are measured against the board's own `fetchedAt`, not the wall clock,
 * so that a card's age agrees with the verdict computed at that same moment —
 * and so the pinned demo board reads the same on every run.
 */
const ago = (iso: string | null, now: number): string => {
  if (iso === null) return '';
  const hours = (now - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
};

export function Card({ item, now, sessionOptions, onChange }: {
  item: BoardItem;
  /** Which session buttons the server offers, and which leads. */
  sessionOptions: RowOptions;
  /** The board's `fetchedAt`, as epoch ms — the reference point for ages. */
  now: number;
  onChange: () => void;
}) {
  const post = async () => {
    await markPostedToDiscord(item.repo, item.number, true);
    onChange();
  };

  return (
    <li className="card">
      <div className="card-head">
        <span className="dot" style={{ background: DOT[item.checkDot] }} />
        <a href={item.url} target="_blank" rel="noreferrer">
          <span className="repo">{item.repo.split('/')[1] ?? item.repo}</span>{' '}
          {item.role === 'reviewer' && <span className="repo">by {item.author}{' '}</span>}
          #{item.number} {item.title}
        </a>
        <span className="age">{ago(item.displayTime, now)}</span>
      </div>

      <ul className="receipts">
        {item.receipts.map((receipt) => <li key={receipt}>{receipt}</li>)}
      </ul>

      {item.verdict !== null && item.verdict.asks.length > 0 && (
        <ul className="asks">
          {item.verdict.asks.map((ask) => <li key={ask}>{ask}</li>)}
        </ul>
      )}

      <SessionRows item={item} options={sessionOptions} onChange={onChange} />

      {item.role === 'author' && (item.bucket === 'not-asked' || item.bucket === 'draft') && (
        <button type="button" onClick={post}>Posted to Discord</button>
      )}
    </li>
  );
}

import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { fetchBoard, type Board, type BoardItem } from './api';
import {
  BUCKET_LABEL, BUCKET_ORDER, EXPANDED, REVIEW_BUCKET_LABEL, REVIEW_BUCKET_ORDER,
} from './buckets';
import { Card } from './Card';
import { notificationPermission, showNewNotifications } from './notifications';

type Tab = 'mine' | 'others';
const TABS: { id: Tab; label: string }[] = [
  { id: 'mine', label: 'My PRs' },
  { id: 'others', label: "Others' PRs" },
];
const TAB_STORAGE_KEY = 'pr-dashboard.tab';

const readStoredTab = (): Tab => {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) === 'others' ? 'others' : 'mine';
  } catch {
    return 'mine';
  }
};

const storeTab = (tab: Tab): void => {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // Storage can be blocked; the tab just isn't remembered.
  }
};

const summaryLine = (board: Board): string => {
  const parts: string[] = [];
  if (board.myCourtCount > 0) parts.push(`${board.myCourtCount} on your PRs`);
  if (board.reviewCourtCount > 0) {
    const noun = board.reviewCourtCount === 1 ? 'review' : 'reviews';
    parts.push(`${board.reviewCourtCount} ${noun} waiting on you`);
  }
  return parts.length === 0 ? 'Nothing waiting on you' : parts.join(' · ');
};

function NotificationControl() {
  const [permission, setPermission] = useState(notificationPermission);
  if (permission === null) return null;
  if (permission === 'default') {
    return (
      <button
        type="button"
        className="notify-toggle"
        onClick={() => void Notification.requestPermission().then(setPermission)}
      >
        Enable notifications
      </button>
    );
  }
  return (
    <p className="notify-status">
      {permission === 'granted' ? 'Notifications on' : 'Notifications blocked in browser settings'}
    </p>
  );
}

function BucketSections({ order, labels, items, asOf, canOpenTerminal, onChange }: {
  order: readonly string[];
  labels: Record<string, string>;
  items: BoardItem[];
  asOf: number;
  canOpenTerminal: boolean;
  onChange: () => void;
}) {
  return (
    <>
      {order.map((bucket) => {
        const inBucket = items.filter((i) => i.bucket === bucket);
        if (inBucket.length === 0) return null;
        const cards = (
          <ul className="cards">
            {inBucket.map((item) => (
              <Card
                key={`${item.repo}#${item.number}`}
                item={item}
                now={asOf}
                canOpenTerminal={canOpenTerminal}
                onChange={onChange}
              />
            ))}
          </ul>
        );
        return (
          <section key={bucket}>
            <h2>{labels[bucket]} ({inBucket.length})</h2>
            {EXPANDED.has(bucket) ? cards : (
              <details>
                <summary>{inBucket.length} hidden</summary>
                {cards}
              </details>
            )}
          </section>
        );
      })}
    </>
  );
}

const formatFetchedAt = (iso: string | null): string => {
  if (iso === null) return 'an unknown time';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>(readStoredTab);

  const selectTab = (next: Tab) => {
    setTab(next);
    storeTab(next);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: Tab = tab === 'mine' ? 'others' : 'mine';
    selectTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  const load = useCallback(async () => {
    try {
      const next = await fetchBoard();
      setBoard(next);
      setFailed(false);
      try {
        showNewNotifications(next).catch(() => {});
      } catch {
        // Showing notifications is best-effort; it must never mark a good board as failed.
      }
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const n = board?.yourCourtCount ?? 0;
    const base = n > 0 ? `(${n}) PR Dashboard` : 'PR Dashboard';
    document.title = failed ? `⚠ ${base}` : base;
  }, [board?.yourCourtCount, failed]);

  if (board === null) return <main><p>{failed ? 'API unreachable.' : 'Loading…'}</p></main>;

  // Cards age against the moment the board was built, so their ages agree with
  // the verdicts computed at that moment. Only the pre-first-poll shell has no
  // `fetchedAt`, and it has no cards to age.
  const asOf = board.fetchedAt === null ? Date.now() : Date.parse(board.fetchedAt);

  return (
    <main>
      <h1>{board.yourCourtCount} in your court</h1>
      <p className="summary">{summaryLine(board)}</p>
      <NotificationControl />
      {board.sessionsError !== null && (
        <p className="sessions-error">Claude Code sessions unavailable — {board.sessionsError}</p>
      )}

      {failed && (
        <p className="banner">
          Cannot reach the dashboard API — showing last-known data from{' '}
          {formatFetchedAt(board.fetchedAt)}. Will keep retrying every 30s.
        </p>
      )}

      {board.stale && (
        <p className="banner">
          Showing the last good data{board.error === null ? '' : ` — ${board.error}`}
        </p>
      )}

      {/* A fresh board can still carry a warning, e.g. the Others' PRs list not refreshing. */}
      {!board.stale && board.error !== null && <p className="banner">{board.error}</p>}

      <div role="tablist" aria-label="Pull requests" className="tabs">
        {TABS.map(({ id, label }) => {
          const count = id === 'mine' ? board.myCourtCount : board.reviewCourtCount;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className="tab"
              onClick={() => selectTab(id)}
              onKeyDown={onTabKeyDown}
            >
              {label}
              {count > 0 && <span className="badge">{count}</span>}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="panel-mine" aria-labelledby="tab-mine" hidden={tab !== 'mine'}>
        <BucketSections
          order={BUCKET_ORDER}
          labels={BUCKET_LABEL}
          items={board.items}
          asOf={asOf}
          canOpenTerminal={board.sessionActions.openTerminal}
          onChange={() => void load()}
        />

        {board.branches.length > 0 && (
          <details>
            <summary>Local branches ({board.branches.length})</summary>
            {/*
              A plain list of local branches, not a claim about unsubmitted work:
              the list is not correlated with PRs, so the only distinction it
              draws is a gone upstream.
            */}
            <ul>
              {board.branches.map((b) => (
                <li key={b.name}>
                  {b.name}
                  {b.bucket === 'dead-branch' && ' — upstream gone'}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div role="tabpanel" id="panel-others" aria-labelledby="tab-others" hidden={tab !== 'others'}>
        {board.reviewing.length === 0 ? (
          <p className="empty">
            No open PRs by others that you've reviewed or commented on.
          </p>
        ) : (
          <BucketSections
            order={REVIEW_BUCKET_ORDER}
            labels={REVIEW_BUCKET_LABEL}
            items={board.reviewing}
            asOf={asOf}
            canOpenTerminal={board.sessionActions.openTerminal}
            onChange={() => void load()}
          />
        )}
      </div>
    </main>
  );
}

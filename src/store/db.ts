import Database from 'better-sqlite3';
import { NOTIFY_KEYS, type NotifyKey } from '../rules/notify.js';
import { prKey } from '../pr-key.js';
import type { ClaudeVerdict } from '../types.js';

const DEBOUNCE_MS = 15 * 60 * 1000;

/**
 * Per-PR methods take a `prKey(repo, number)` string, so the same number in two
 * repos never shares state.
 */
export interface Store {
  getDiscordPostedAt(pr: string): string | null;
  setDiscordPostedAt(pr: string, at: string | null): void;
  getVerdict(reviewId: string, lastEditedAt: string | null): ClaudeVerdict | null;
  putVerdict(reviewId: string, lastEditedAt: string | null, v: ClaudeVerdict): void;
  /**
   * True only when `key` is notify-worthy, the PR has been observed before,
   * `key` differs from the last key we OBSERVED for it, and the debounce since
   * the last notification that actually fired has elapsed.
   */
  shouldNotify(pr: string, key: NotifyKey, now: Date): boolean;
  /** Called for every item on every poll, notification or not. */
  recordObserved(pr: string, key: NotifyKey): void;
  /** Called only when a notification actually fired. */
  recordNotified(pr: string, key: NotifyKey, now: Date): void;
  /** A saved settings value (JSON), or null when never saved. */
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
  /** Forgets a saved setting. */
  deleteSetting(key: string): void;
  close(): void;
}

/**
 * `homeRepo` is `owner/name` of the configured home repo. Databases written
 * before PRs were keyed by repo hold bare PR numbers, which could only have come
 * from that repo, so they are carried over under its key.
 */
export function openStore(path: string, homeRepo: string): Store {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_v2 (pr_key TEXT PRIMARY KEY, posted_at TEXT);
    CREATE TABLE IF NOT EXISTS verdicts (
      key TEXT PRIMARY KEY, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notify_state_v2 (
      pr_key TEXT PRIMARY KEY,
      last_key TEXT NOT NULL,
      last_notified_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  migrateLegacyTables(db, homeRepo);

  const key = (id: string, edited: string | null) => `${id}@${edited ?? 'never'}`;

  return {
    getDiscordPostedAt(pr) {
      const row = db.prepare('SELECT posted_at FROM discord_v2 WHERE pr_key = ?').get(pr) as
        | { posted_at: string | null } | undefined;
      return row?.posted_at ?? null;
    },
    setDiscordPostedAt(pr, at) {
      db.prepare(
        `INSERT INTO discord_v2 (pr_key, posted_at) VALUES (?, ?)
         ON CONFLICT(pr_key) DO UPDATE SET posted_at = excluded.posted_at`,
      ).run(pr, at);
    },
    getVerdict(reviewId, lastEditedAt) {
      const row = db.prepare('SELECT payload FROM verdicts WHERE key = ?')
        .get(key(reviewId, lastEditedAt)) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as ClaudeVerdict) : null;
    },
    putVerdict(reviewId, lastEditedAt, v) {
      db.prepare(
        `INSERT INTO verdicts (key, payload) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload`,
      ).run(key(reviewId, lastEditedAt), JSON.stringify(v));
    },
    shouldNotify(pr, key, now) {
      if (!NOTIFY_KEYS.has(key)) return false;
      const row = db.prepare(
        'SELECT last_key, last_notified_at FROM notify_state_v2 WHERE pr_key = ?',
      ).get(pr) as { last_key: string; last_notified_at: string | null } | undefined;
      // A PR seen for the first time is recorded, not announced, so a freshly
      // tracked board does not fire a burst for everything already waiting.
      if (row === undefined) return false;
      // The PR has not actually moved since we last looked at it.
      if (row.last_key === key) return false;
      if (row.last_notified_at === null) return true;
      return now.getTime() - Date.parse(row.last_notified_at) >= DEBOUNCE_MS;
    },
    recordObserved(pr, key) {
      db.prepare(
        `INSERT INTO notify_state_v2 (pr_key, last_key, last_notified_at) VALUES (?, ?, NULL)
         ON CONFLICT(pr_key) DO UPDATE SET last_key = excluded.last_key`,
      ).run(pr, key);
    },
    recordNotified(pr, key, now) {
      db.prepare(
        `INSERT INTO notify_state_v2 (pr_key, last_key, last_notified_at) VALUES (?, ?, ?)
         ON CONFLICT(pr_key) DO UPDATE SET
           last_key = excluded.last_key,
           last_notified_at = excluded.last_notified_at`,
      ).run(pr, key, now.toISOString());
    },
    getSetting(name) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(name) as
        | { value: string } | undefined;
      if (row === undefined) return null;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        return null;
      }
    },
    setSetting(name, value) {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(name, JSON.stringify(value));
    },
    deleteSetting(name) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(name);
    },
    close() { db.close(); },
  };
}

const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Copies the integer-keyed tables into the text-keyed ones, then drops them. */
function migrateLegacyTables(db: Database.Database, homeRepo: string): void {
  const migrate = db.transaction(() => {
    if (tableExists(db, 'discord')) {
      const rows = db.prepare('SELECT pr, posted_at FROM discord').all() as
        { pr: number; posted_at: string | null }[];
      const insert = db.prepare(
        'INSERT OR IGNORE INTO discord_v2 (pr_key, posted_at) VALUES (?, ?)',
      );
      for (const row of rows) insert.run(prKey(homeRepo, row.pr), row.posted_at);
      db.exec('DROP TABLE discord');
    }
    if (tableExists(db, 'notify_state')) {
      const rows = db.prepare('SELECT pr, last_key, last_notified_at FROM notify_state').all() as
        { pr: number; last_key: string; last_notified_at: string | null }[];
      const insert = db.prepare(
        `INSERT OR IGNORE INTO notify_state_v2 (pr_key, last_key, last_notified_at)
         VALUES (?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(prKey(homeRepo, row.pr), row.last_key, row.last_notified_at);
      }
      db.exec('DROP TABLE notify_state');
    }
  });
  migrate();
}

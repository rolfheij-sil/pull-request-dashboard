import type { SessionsConfig } from '../types.js';
import { defaultListDeps, listSessions, type ListDeps, type SessionListing } from './list.js';
import type { SessionInfo } from './types.js';

export const SESSION_REFRESH_MS = 20_000;

/** The latest session listing, refreshed on its own timer, independent of the GitHub poll. */
export interface SessionService {
  snapshot(): SessionListing;
  /** Finds a listed session by its short id (the `claude attach` id). */
  findById(id: string): SessionInfo | undefined;
  /** Finds a listed session by its full session id (interactive sessions have no short id). */
  findBySessionId(sessionId: string): SessionInfo | undefined;
  /** Re-lists now; concurrent calls share one run. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * `config` may be a function, read on every refresh, so settings changed in the
 * panel and a late-detected CLI path take effect without a restart. A config
 * with `enabled: false` lists nothing and runs nothing.
 */
export function createSessionService(
  config: SessionsConfig | (() => SessionsConfig), deps: ListDeps = defaultListDeps,
): SessionService {
  let listing: SessionListing = { sessions: [], error: null };
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const refresh = (): Promise<void> => {
    const cfg = typeof config === 'function' ? config() : config;
    inFlight ??= (cfg.enabled === false
      ? Promise.resolve<SessionListing>({ sessions: [], error: null })
      : listSessions(cfg, deps))
      .then((next) => { if (!stopped) listing = next; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    snapshot: () => listing,
    findById: (id) => listing.sessions.find((s) => s.id === id),
    findBySessionId: (sessionId) => listing.sessions.find((s) => s.sessionId === sessionId),
    refresh,
    start() {
      const refreshQuietly = (): void => {
        refresh().catch((error: unknown) => {
          console.error('Could not refresh the Claude Code session list:', error);
        });
      };
      refreshQuietly();
      timer = setInterval(refreshQuietly, SESSION_REFRESH_MS);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
    },
  };
}

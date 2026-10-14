import type { SessionsConfig } from '../types.js';
import { defaultListDeps, listSessions, type ListDeps, type SessionListing } from './list.js';
import type { SessionInfo } from './types.js';

export const SESSION_REFRESH_MS = 20_000;

/** The latest session listing, refreshed on its own timer, independent of the GitHub poll. */
export interface SessionService {
  snapshot(): SessionListing;
  /** Finds a listed session by its short id (the `claude attach` id). */
  findById(id: string): SessionInfo | undefined;
  /** Re-lists now; concurrent calls share one run. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createSessionService(
  cfg: SessionsConfig, deps: ListDeps = defaultListDeps,
): SessionService {
  let listing: SessionListing = { sessions: [], error: null };
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const refresh = (): Promise<void> => {
    inFlight ??= listSessions(cfg, deps)
      .then((next) => { if (!stopped) listing = next; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    snapshot: () => listing,
    findById: (id) => listing.sessions.find((s) => s.id === id),
    refresh,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), SESSION_REFRESH_MS);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
    },
  };
}

/** The most git (or other child-process) calls the server runs at once. */
export const GIT_CONCURRENCY = 8;

/**
 * Returns a function that runs tasks with at most `max` in flight; the rest
 * wait their turn in submission order. A finishing task hands its slot
 * straight to the next waiting one, so the count never overshoots.
 */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => { waiting.push(resolve); });
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

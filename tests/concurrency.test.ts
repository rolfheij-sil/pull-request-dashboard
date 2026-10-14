import { describe, expect, it } from 'vitest';
import { createLimiter } from '../src/concurrency.js';

describe('createLimiter', () => {
  it('never runs more than the limit at once, and runs every task', async () => {
    const limit = createLimiter(3);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => limit(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      running -= 1;
      return i;
    })));
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('frees the slot when a task fails', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await limit(async () => 'next')).toBe('next');
  });
});

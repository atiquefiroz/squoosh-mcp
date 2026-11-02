import { describe, expect, it } from 'vitest';
import { JobStore, PixelPool } from '../src/core/jobs.js';
import { UserError } from '../src/core/paths.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Runs tasks through the pool and reports the most that were ever in flight at once. */
async function maxInFlight(pool: PixelPool, weights: number[], signal = new AbortController().signal): Promise<number> {
  let now = 0;
  let max = 0;
  await Promise.all(
    weights.map(async (w) => {
      const release = await pool.acquire(w, signal);
      now++;
      max = Math.max(max, now);
      await tick();
      now--;
      release();
    }),
  );
  return max;
}

describe('PixelPool', () => {
  it('never admits more than its slots (regression: a release used to wake every waiter)', async () => {
    expect(await maxInFlight(new PixelPool(1, 1e9), [1, 1, 1, 1, 1])).toBe(1);
    expect(await maxInFlight(new PixelPool(2, 1e9), [1, 1, 1, 1, 1, 1, 1])).toBe(2);
  });

  it('limits total pixels, and lets an oversized image run alone', async () => {
    expect(await maxInFlight(new PixelPool(4, 10), [6, 6, 6, 6])).toBe(1);
    expect(await maxInFlight(new PixelPool(4, 10), [5, 5, 5, 5])).toBe(2);
    expect(await maxInFlight(new PixelPool(4, 10), [50, 1])).toBe(1);
  });

  it('rejects a waiter on abort and keeps serving others', async () => {
    const pool = new PixelPool(1, 1e9);
    const first = await pool.acquire(1, new AbortController().signal);
    const ac = new AbortController();
    const waiting = pool.acquire(1, ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow('cancelled');
    first();
    const next = await pool.acquire(1, new AbortController().signal);
    next();
  });
});

describe('JobStore', () => {
  it('attaches identical calls, refuses overlapping output folders, and reports unknown ids', async () => {
    const store = new JobStore();
    let finish!: () => void;
    const running = new Promise<void>((r) => (finish = r));
    const a = store.start('k1', ['/out'], () => running);
    expect(a.attached).toBe(false);
    expect(store.start('k1', ['/out'], () => running)).toMatchObject({ attached: true, job: a.job });
    expect(() => store.start('k2', ['/out'], async () => {})).toThrow(UserError);
    expect(() => store.get('nope')).toThrow(UserError);
    finish();
    await a.job.finished;
    expect(a.job.status).toBe('completed');
  });

  it('cancels a running job', async () => {
    const store = new JobStore();
    const { job } = store.start('k', ['/o'], (j) => new Promise<void>((r) => j.controller.signal.addEventListener('abort', () => r())));
    store.cancel(job.id);
    await job.finished;
    expect(job.status).toBe('cancelled');
  });
});

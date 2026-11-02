import { describe, expect, it } from 'vitest';
import { pick, searchQuality, type Point } from '../src/core/search.js';

/** A synthetic codec: score and size both rise with quality. */
function codec(score: (q: number) => number) {
  const calls: number[] = [];
  const evaluate = async (q: number): Promise<Point> => {
    calls.push(q);
    return { q, score: score(q), bytes: q * 100, buf: Buffer.alloc(0) };
  };
  return { evaluate, calls };
}

describe('searchQuality', () => {
  it('finds (nearly) the lowest quality that meets the target within the encode budget', async () => {
    const { evaluate, calls } = codec((q) => 40 + 0.5 * q); // meets 75 from q = 70
    const r = await searchQuality(evaluate, { target: 75, lo: 20, hi: 99, q0: 55, maxEvals: 6 });
    expect(r.met).toBe(true);
    expect(r.best.score).toBeGreaterThanOrEqual(75);
    expect(r.best.q).toBeLessThanOrEqual(72);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('handles a non-linear curve', async () => {
    const { evaluate } = codec((q) => 100 - 60 * Math.exp(-q / 25)); // meets 85 from about q = 34
    const r = await searchQuality(evaluate, { target: 85, lo: 10, hi: 100, q0: 70 });
    expect(r.met).toBe(true);
    expect(r.best.q).toBeLessThanOrEqual(38);
  });

  it('returns the best effort when the target is unreachable', async () => {
    const { evaluate } = codec((q) => 50 + 0.1 * q);
    const r = await searchQuality(evaluate, { target: 90, lo: 20, hi: 99, q0: 60 });
    expect(r.met).toBe(false);
    expect(r.best.q).toBe(99);
  });

  it('goes low when even the lowest quality passes', async () => {
    const { evaluate } = codec(() => 95);
    const r = await searchQuality(evaluate, { target: 75, lo: 20, hi: 99, q0: 60 });
    expect(r.met).toBe(true);
    expect(r.best.q).toBeLessThanOrEqual(30);
  });

  it('stops when asked', async () => {
    const { evaluate, calls } = codec((q) => q);
    await searchQuality(evaluate, { target: 75, lo: 20, hi: 99, q0: 40, shouldStop: () => true });
    expect(calls.length).toBe(1);
  });
});

describe('pick', () => {
  it('prefers the smallest passing point, else the highest score', () => {
    const p = (q: number, score: number): Point => ({ q, score, bytes: q, buf: Buffer.alloc(0) });
    expect(pick([p(80, 90), p(60, 76), p(50, 70)], 75)).toMatchObject({ best: { q: 60 }, met: true });
    expect(pick([p(80, 70), p(60, 60)], 75)).toMatchObject({ best: { q: 80 }, met: false });
  });
});

export interface Point {
  q: number;
  score: number;
  bytes: number;
  buf: Buffer;
}

export interface SearchOptions {
  target: number;
  lo: number;
  hi: number;
  /** Predicted starting quality. */
  q0: number;
  maxEvals?: number;
  /** Stop when the pass/fail bracket is this narrow. */
  minStep?: number;
  /** Checked between encodes: stop early (time budget, cancellation). */
  shouldStop?: () => boolean;
}

export interface SearchResult {
  best: Point;
  met: boolean;
  points: Point[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The smallest point meeting the target; otherwise the highest-scoring point. */
export function pick(points: readonly Point[], target: number): { best: Point; met: boolean } {
  const passing = points.filter((p) => p.score >= target);
  if (passing.length) return { best: passing.reduce((a, b) => (b.bytes < a.bytes ? b : a)), met: true };
  return { best: points.reduce((a, b) => (b.score > a.score ? b : a)), met: false };
}

/**
 * Finds the lowest quality whose score meets `target` in few encodes (plan A.5): secant
 * interpolation inside the pass/fail bracket, bisection when the curve misbehaves, and
 * half-range jumps while only one side is known. The bracket is recomputed from every
 * measured point, so a non-monotonic score cannot trap the search.
 */
export async function searchQuality(evaluate: (q: number) => Promise<Point>, o: SearchOptions): Promise<SearchResult> {
  const maxEvals = o.maxEvals ?? 6;
  const minStep = o.minStep ?? 2;
  const points: Point[] = [];
  const tried = new Set<number>();
  const run = async (q: number) => {
    tried.add(q);
    points.push(await evaluate(q));
  };

  await run(clamp(Math.round(o.q0), o.lo, o.hi));
  while (points.length < maxEvals && !o.shouldStop?.()) {
    const pass = points.filter((p) => p.score >= o.target).reduce<Point | undefined>((a, b) => (!a || b.q < a.q ? b : a), undefined);
    const fail = points
      .filter((p) => p.score < o.target && (!pass || p.q < pass.q))
      .reduce<Point | undefined>((a, b) => (!a || b.q > a.q ? b : a), undefined);

    let next: number;
    if (pass && fail) {
      if (pass.q - fail.q <= minStep) break;
      const slope = (pass.score - fail.score) / (pass.q - fail.q);
      next = slope > 0 ? fail.q + (o.target - fail.score) / slope : (fail.q + pass.q) / 2;
      next = Math.round(clamp(next, fail.q + 1, pass.q - 1));
      if (tried.has(next)) next = Math.round((fail.q + pass.q) / 2);
    } else if (pass) {
      if (pass.q <= o.lo) break;
      next = Math.round(Math.max(o.lo, pass.q - Math.max(minStep * 2, (pass.q - o.lo) / 2)));
    } else {
      if (fail!.q >= o.hi) break;
      next = Math.round(Math.min(o.hi, fail!.q + Math.max(minStep * 2, (o.hi - fail!.q) / 2)));
    }
    if (tried.has(next)) break;
    await run(next);
  }
  return { ...pick(points, o.target), points };
}

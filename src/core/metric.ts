import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface Pixels {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 3 | 4;
}

interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Above this size, scoring uses two full-resolution 1024px tiles (centre + most detailed): bounded
 * time and WASM memory (risk R2). On 36 real encodes the tile minimum was 1.4 points stricter than
 * the whole-image score on average and at most 0.6 points more lenient (measured on 36 encodes).
 */
const TILE_THRESHOLD = 2_300_000;
const TILE_SIDE = 1024;
const TILE_COUNT = 2;
/** A worker whose WASM memory grew past this is replaced once idle (WASM memory never shrinks). */
const RECYCLE_BYTES = 512 * 1024 * 1024;

const here = import.meta.url;
const WORKER_URL = new URL(here.endsWith('.ts') ? './metric-worker.ts' : './metric-worker.js', here);
const WASM_CANDIDATES = [new URL('./ssim2.wasm', here), new URL('../../wasm/ssim2.wasm', here)];

/** SSIMULACRA 2 quality bands (cloudinary/ssimulacra2 README). */
export function band(score: number): string {
  if (score >= 90) return 'visually-lossless';
  if (score >= 85) return 'excellent';
  if (score >= 80) return 'very-high';
  if (score >= 70) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

/** Copies a tile into a fresh ArrayBuffer: sharp's output buffers are external memory and cannot be transferred. */
function crop(px: Pixels, t: Tile): Uint8Array {
  if (t.width === px.width && t.height === px.height) return new Uint8Array(px.data);
  const out = new Uint8Array(t.width * t.height * px.channels);
  const rowBytes = t.width * px.channels;
  for (let y = 0; y < t.height; y++) {
    const start = ((t.y + y) * px.width + t.x) * px.channels;
    out.set(px.data.subarray(start, start + rowBytes), y * rowBytes);
  }
  return out;
}

/** Mean horizontal luma change, sampled sparsely: a cheap "where would artefacts show" measure. */
function detail(px: Pixels, t: Tile): number {
  let sum = 0;
  let n = 0;
  const c = px.channels;
  for (let y = t.y; y < t.y + t.height; y += 4) {
    for (let x = t.x; x < t.x + t.width - 1; x += 4) {
      const i = (y * px.width + x) * c;
      sum += Math.abs(px.data[i]! + px.data[i + 1]! - px.data[i + c]! - px.data[i + c + 1]!);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** Whole image when small; otherwise the centre tile plus the most detailed tiles of an overlapping grid covering the image. */
export function pickTiles(px: Pixels): Tile[] {
  if (px.width * px.height <= TILE_THRESHOLD) return [{ x: 0, y: 0, width: px.width, height: px.height }];
  const width = Math.min(px.width, TILE_SIDE);
  const height = Math.min(px.height, TILE_SIDE);
  const cols = Math.ceil(px.width / width);
  const rows = Math.ceil(px.height / height);
  const at = (i: number, count: number, size: number, full: number) => (count === 1 ? Math.floor((full - size) / 2) : Math.round((i * (full - size)) / (count - 1)));
  const grid: Tile[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grid.push({ x: at(c, cols, width, px.width), y: at(r, rows, height, px.height), width, height });
  const centre: Tile = { x: Math.floor((px.width - width) / 2), y: Math.floor((px.height - height) / 2), width, height };
  const ranked = grid.map((t) => ({ t, d: detail(px, t) })).sort((a, b) => b.d - a.d).map((r) => r.t);
  return [centre, ...ranked.filter((t) => t.x !== centre.x || t.y !== centre.y).slice(0, TILE_COUNT - 1)];
}

class MetricWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (v: number) => void; reject: (e: Error) => void }>();
  private seq = 0;
  sessions = 0;
  dead = false;
  memoryBytes = 0;

  constructor(module: WebAssembly.Module) {
    this.worker = new Worker(WORKER_URL, { workerData: { module } });
    this.worker.unref();
    this.worker.on('message', (m: { seq: number; value?: number; error?: string }) => {
      const p = this.pending.get(m.seq);
      this.pending.delete(m.seq);
      if (m.error) p?.reject(new Error(m.error));
      else p?.resolve(m.value ?? 0);
    });
    const fail = (error: Error) => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', () => fail(new Error('SSIMULACRA 2 worker exited.')));
  }

  get load(): number {
    return this.pending.size + this.sessions;
  }

  request(op: 'ref' | 'cmp' | 'free', id: number, data?: Uint8Array, px?: Omit<Pixels, 'data'>): Promise<number> {
    if (this.dead) return Promise.reject(new Error('SSIMULACRA 2 worker is not running.'));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.worker.postMessage({ seq, op, id, data, ...px }, data ? [data.buffer as ArrayBuffer] : []);
    });
  }

  terminate(): Promise<number> {
    this.dead = true;
    return this.worker.terminate();
  }
}

let nextId = 0;

/** A cached reference image living in one worker; score candidates of the same size against it. */
export class MetricSession {
  private readonly worker: MetricWorker;
  private readonly pool: MetricPool;
  private readonly tiles: Tile[];
  private readonly ids: number[];
  private readonly ref: Omit<Pixels, 'data'>;

  private constructor(worker: MetricWorker, pool: MetricPool, tiles: Tile[], ids: number[], ref: Omit<Pixels, 'data'>) {
    this.worker = worker;
    this.pool = pool;
    this.tiles = tiles;
    this.ids = ids;
    this.ref = ref;
  }

  static async open(worker: MetricWorker, pool: MetricPool, ref: Pixels): Promise<MetricSession> {
    const tiles = pickTiles(ref);
    const ids = tiles.map(() => ++nextId);
    worker.sessions++;
    const session = new MetricSession(worker, pool, tiles, ids, { width: ref.width, height: ref.height, channels: ref.channels });
    try {
      await Promise.all(tiles.map((t, i) => worker.request('ref', ids[i]!, crop(ref, t), { width: t.width, height: t.height, channels: ref.channels })));
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  /** SSIMULACRA 2 score of `candidate` (same size and channels as the reference); the lowest tile wins. */
  async score(candidate: Uint8Array): Promise<number> {
    const px = { ...this.ref, data: candidate };
    const scores = await Promise.all(
      this.tiles.map((t, i) => this.worker.request('cmp', this.ids[i]!, crop(px, t), { width: t.width, height: t.height, channels: this.ref.channels })),
    );
    return Math.min(...scores);
  }

  async close(): Promise<void> {
    this.worker.sessions--;
    const sizes = await Promise.all(this.ids.map((id) => this.worker.request('free', id).catch(() => 0)));
    this.worker.memoryBytes = Math.max(0, ...sizes);
    this.pool.release(this.worker);
  }
}

/** Lazily started SSIMULACRA 2 workers; one compiled WASM module shared by all. */
export class MetricPool {
  private module?: Promise<WebAssembly.Module>;
  private workers: MetricWorker[] = [];

  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  private compile(): Promise<WebAssembly.Module> {
    this.module ??= (async () => {
      for (const url of WASM_CANDIDATES) {
        const bytes = await fs.readFile(fileURLToPath(url)).catch(() => undefined);
        if (bytes) return WebAssembly.compile(bytes);
      }
      throw new Error('ssim2.wasm not found. Run `npm run build` (or `npm run build:wasm`).');
    })();
    return this.module;
  }

  async open(ref: Pixels): Promise<MetricSession> {
    const module = await this.compile();
    this.workers = this.workers.filter((w) => !w.dead);
    // One open session per worker keeps each worker's WASM memory to one reference plus scratch.
    // A closing session's frees are queued ahead of the new reference, so its worker is reusable.
    let worker = this.workers.find((w) => w.sessions === 0);
    if (!worker && this.workers.length < this.size) this.workers.push((worker = new MetricWorker(module)));
    worker ??= this.workers.reduce((a, b) => (a.load <= b.load ? a : b));
    return MetricSession.open(worker, this, ref);
  }

  /** Recycles an idle worker whose WASM memory has grown large. */
  release(worker: MetricWorker): void {
    if (worker.load === 0 && worker.memoryBytes > RECYCLE_BYTES) {
      this.workers = this.workers.filter((w) => w !== worker);
      void worker.terminate();
    }
  }

  async score(a: Pixels, b: Uint8Array): Promise<number> {
    const session = await this.open(a);
    try {
      return await session.score(b);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}

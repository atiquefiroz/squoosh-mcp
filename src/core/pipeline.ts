import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { config } from '../config.js';
import { classify, measure, readHeader, type Classification, type Header } from './analyze.js';
import { CODECS, decodeLike, encode, type CodecId, type Frame } from './codecs.js';
import type { DiscoveredFile } from './discover.js';
import type { MetricPool, MetricSession } from './metric.js';
import { markup, type Entry, type OutputRecord, type OutputStore } from './output.js';
import { toPosix } from './paths.js';
import { candidateGroups, predictQuality, sizesFor, targetScore, type Settings, type Size } from './planner.js';
import { pick, searchQuality, type Point } from './search.js';

export type ImageStatus = 'optimized' | 'kept' | 'unchanged' | 'skipped' | 'failed';

export interface ImageResult {
  source: string;
  status: ImageStatus;
  bytesBefore: number;
  bytesAfter: number;
  outputs: (OutputRecord & { file: string })[];
  class?: string | undefined;
  /** Short human-readable account of the decision. */
  decision?: string | undefined;
  targetNotMet?: boolean | undefined;
  markup?: string | undefined;
  error?: string | undefined;
  ms: number;
}

export interface ImageTask {
  file: DiscoveredFile;
  settings: Settings;
  stem: string;
  store: OutputStore;
  urlBase?: string | undefined;
}

export interface PipelineDeps {
  metric: MetricPool;
  signal: AbortSignal;
  engineKey: string;
}

export class AbortError extends Error {
  override name = 'AbortError';
}

/**
 * Bump when decision rules change what the same settings produce (candidate tables, targets,
 * search), so earlier outputs are redone. 2: `auto` became WebP only (D3).
 */
export const PIPELINE_REVISION = 2;

/** Hash of everything that changes outputs: a re-run with a different hash redoes the file (D15). */
export function settingsKey(s: Settings, engineKey: string): string {
  const { priority: _priority, ...relevant } = s;
  return createHash('sha256').update(JSON.stringify([relevant, engineKey, PIPELINE_REVISION])).digest('hex').slice(0, 16);
}

async function fileHash(abs: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(abs)).digest('hex');
}

/** The source pipeline for one output size: orient, crop/resize in linear light, colour, metadata. */
function sourcePipeline(abs: string, header: Header, size: Size, settings: Settings): Sharp {
  let s = sharp(abs, { autoOrient: true, limitInputPixels: config.maxInputPixels });
  const resizing = size.width !== header.width || size.height !== header.height;
  if (size.crop) {
    const position = size.crop.strategy === 'center' ? 'centre' : sharp.strategy[size.crop.strategy];
    s = s.resize({ width: size.width, height: size.height, fit: 'cover', position, kernel: 'lanczos3' });
  } else if (resizing) {
    s = s.resize({ width: size.width, height: size.height, fit: 'fill', kernel: 'lanczos3' });
  }
  // Squoosh resizes in linear light (linearRGB: true); gamma() is sharp's equivalent.
  if (resizing || size.crop) s = s.gamma();
  if (settings.metadata === 'all') s = s.keepMetadata();
  return header.wideGamut ? s.withIccProfile('p3') : s.toColourspace('srgb');
}

async function makeFrame(abs: string, header: Header, size: Size, alpha: boolean, settings: Settings): Promise<Frame> {
  const base = () => {
    const s = sourcePipeline(abs, header, size, settings);
    return alpha ? s.ensureAlpha() : s.removeAlpha();
  };
  const { data, info } = await base().raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels === 4 ? 4 : 3,
    wide: header.wideGamut,
    ...(header.wideGamut || settings.metadata === 'all' ? { source: base } : {}),
  };
}

interface Chosen {
  codec: CodecId;
  point: Point;
  met: boolean;
}

const FINAL_DIFFERS: ReadonlySet<CodecId> = new Set(['avif', 'png-palette', 'png-quant']);

/** Encodes and scores candidates for one output size. */
class SizeSearch {
  private readonly memo = new Map<string, Promise<Point>>();

  private readonly frame: Frame;
  private readonly session: MetricSession;
  private readonly target: number;
  private readonly shouldStop: () => boolean;

  constructor(frame: Frame, session: MetricSession, target: number, shouldStop: () => boolean) {
    this.frame = frame;
    this.session = session;
    this.target = target;
    this.shouldStop = shouldStop;
  }

  evaluate(codec: CodecId, q: number, final = false, dither = 1): Promise<Point> {
    // Only these encoders do more work when final; for the rest a "final" encode is the same bytes.
    const key = `${codec}|${q}|${final && FINAL_DIFFERS.has(codec)}|${dither}`;
    let p = this.memo.get(key);
    if (!p) {
      p = (async () => {
        const buf = await encode(this.frame, codec, { quality: q, final, dither, chroma: this.chroma });
        const score = await this.session.score(await decodeLike(this.frame, buf));
        return { q, score, bytes: buf.length, buf };
      })();
      this.memo.set(key, p);
    }
    return p;
  }

  chroma: '4:2:0' | '4:4:4' = '4:2:0';

  async search(codec: CodecId, q0: number, maxEvals = 6): Promise<Chosen> {
    const spec = CODECS[codec];
    if (!spec.lossy) {
      const point = await this.evaluate(codec, 100, true);
      return { codec, point, met: point.score >= this.target };
    }
    const r = await searchQuality((q) => this.evaluate(codec, q), {
      target: this.target,
      lo: spec.range[0],
      hi: spec.range[1],
      q0,
      maxEvals,
      shouldStop: this.shouldStop,
    });
    return { codec, point: r.best, met: r.met };
  }

  /** Re-encodes a winner at final effort (AVIF effort 4, palette dither 0 vs 1, OxiPNG) and re-checks it. */
  async finalize(c: Chosen): Promise<Chosen> {
    const spec = CODECS[c.codec];
    if (!spec.lossy) return c;
    const variants: Point[] = [await this.evaluate(c.codec, c.point.q, true)];
    if (c.codec === 'png-palette' || c.codec === 'webp-palette') variants.push(await this.evaluate(c.codec, c.point.q, true, 0));
    let { best, met } = pick(variants, this.target);
    if (!met && c.met && c.point.q < spec.range[1] && !this.shouldStop()) {
      const bumped = await this.evaluate(c.codec, Math.min(spec.range[1], c.point.q + 3), true);
      ({ best, met } = pick([...variants, bumped], this.target));
    }
    return { codec: c.codec, point: best, met };
  }
}

/** Runner-up formats are searched only if their probe estimate is within this factor of the best result so far. */
const RUNNER_UP_MARGIN = 1.15;

/**
 * Picks the codec for one candidate group at the largest size: encode lossless candidates once,
 * probe the lossy ones, then search the best two, skipping one that cannot plausibly win.
 */
async function chooseCodec(search: SizeSearch, group: CodecId[], target: number): Promise<Chosen> {
  const lossless = group.filter((id) => !CODECS[id].lossy);
  const lossy = group.filter((id) => CODECS[id].lossy);
  const results: Chosen[] = [];
  const bestMetBytes = () => Math.min(...results.filter((r) => r.met).map((r) => r.point.bytes));
  for (const id of lossless) results.push(await search.search(id, 100));
  const probes = await Promise.all(
    lossy.map(async (id) => {
      const [lo, hi] = CODECS[id].range;
      const q0 = Math.min(hi, Math.max(lo, Math.round(predictQuality(id, target))));
      const p = await search.evaluate(id, q0);
      // Rough bytes-at-target estimate; palette PNG probes skip OxiPNG (about 10% smaller after).
      const shrink = id === 'png-palette' ? 0.9 : 1;
      const estimate = p.bytes * shrink * (p.score >= target ? 1 : 1 + 0.06 * (target - p.score));
      return { id, q0, estimate };
    }),
  );
  probes.sort((a, b) => a.estimate - b.estimate);
  for (const probe of probes.slice(0, 2)) {
    if (probe.estimate > bestMetBytes() * RUNNER_UP_MARGIN) continue;
    results.push(await search.search(probe.id, probe.q0));
  }
  const met = results.filter((r) => r.met);
  const best = met.length
    ? met.reduce((a, b) => (b.point.bytes < a.point.bytes ? b : a))
    : results.reduce((a, b) => (b.point.score > a.point.score ? b : a));
  return search.finalize(best);
}

const describe = (c: Chosen) => `${c.codec} q${c.point.q} → ${c.point.score.toFixed(1)}`;

/** Optimises one source image end to end. Never throws: failures come back as `failed` results. */
export async function processImage(task: ImageTask, deps: PipelineDeps): Promise<ImageResult> {
  const started = Date.now();
  const { file, settings, store } = task;
  const result: ImageResult = { source: file.abs, status: 'failed', bytesBefore: 0, bytesAfter: 0, outputs: [], ms: 0 };
  const sourceKey = toPosix(path.relative(store.dir, file.abs));
  const key = settingsKey(settings, deps.engineKey);
  const checkAbort = () => {
    if (deps.signal.aborted) throw new AbortError('cancelled');
  };

  try {
    const header = await readHeader(file.abs);
    result.bytesBefore = header.bytes;
    if (header.unsupported) {
      return Object.assign(result, { status: 'skipped' as const, bytesAfter: header.bytes, decision: header.unsupported });
    }

    // Skip unchanged: same settings and engine, and the same source (size + mtime, else content hash).
    const previous = store.lookup(sourceKey);
    if (previous && previous.key === key && previous.sourceBytes === header.bytes && (await store.outputsExist(previous))) {
      const same = previous.sourceMtimeMs === header.mtimeMs || previous.sourceHash === (await fileHash(file.abs));
      if (same) {
        // urlBase and priority only affect markup: rebuild it rather than re-encoding.
        const groups: OutputRecord[][] = [];
        for (const o of previous.outputs) (groups[o.group ?? 0] ??= []).push(o);
        const html = markup(groups, { urlBase: task.urlBase, priority: settings.priority });
        if (html !== previous.markup) await store.record({ ...previous, markup: html, updatedAt: new Date().toISOString() });
        return Object.assign(result, {
          status: 'unchanged' as const,
          bytesAfter: previous.outputs[0]?.bytes ?? header.bytes,
          outputs: previous.outputs.map((o) => ({ ...o, file: store.abs(o.path) })),
          class: previous.class,
          decision: 'Unchanged since the last run with the same settings.',
          markup: html,
        });
      }
    }

    const outputs: OutputRecord[] = [];
    const groupsOut: OutputRecord[][] = [];
    const notes: string[] = [];
    const writes: { rel: string; buf?: Buffer; copyOriginal?: boolean }[] = [];
    let classification: Classification | undefined;

    if (header.animated) {
      classification = { cls: 'animated', confidence: 1, needsFullChroma: false };
      const keepGif = settings.policy === 'keep' && header.format === 'gif';
      const resizeTo = sizesFor(header.width, header.height, { resize: settings.resize })[0]!;
      let s = sharp(file.abs, { animated: true, limitInputPixels: false });
      if (resizeTo.width < header.width) s = s.resize({ width: resizeTo.width });
      const buf = await (keepGif ? s.gif({ effort: 10 }) : s.webp({ quality: 75, effort: 4 })).toBuffer();
      const format = keepGif ? 'gif' : 'webp';
      const resized = resizeTo.width < header.width;
      if (!resized && buf.length >= header.bytes) {
        const rel = `${task.stem}${path.extname(file.abs).toLowerCase()}`;
        writes.push({ rel, copyOriginal: true });
        outputs.push({ path: rel, format: header.format, width: header.width, height: header.height, bytes: header.bytes, original: true });
        notes.push('Animated: the re-encode was not smaller, original kept');
      } else {
        const rel = `${task.stem}.${format}`;
        writes.push({ rel, buf });
        outputs.push({ path: rel, format, width: resizeTo.width, height: resizeTo.height, bytes: buf.length, quality: keepGif ? undefined : 75 });
        notes.push(`Animated → ${format}${keepGif ? '' : ' q75'}`);
      }
      groupsOut.push(outputs.slice());
    } else {
      const features = await measure(file.abs, header);
      classification = classify(header, features);
      const sizes = sizesFor(header.width, header.height, settings);
      const target = targetScore(settings.target, classification.cls);
      const groups = candidateGroups(settings.policy, {
        cls: classification.cls,
        confidence: classification.confidence,
        features,
        sourceFormat: header.format,
        wideGamut: header.wideGamut,
        lossless: target >= 100,
        maxSide: Math.max(sizes[0]!.width, sizes[0]!.height),
      });
      const largestMp = (sizes[0]!.width * sizes[0]!.height) / 1e6;
      const deadline = started + config.imageBudgetBaseMs + config.imageBudgetPerMpMs * largestMp;
      let timedOut = false;
      const shouldStop = () => {
        if (deps.signal.aborted) return true;
        if (Date.now() > deadline) timedOut = true;
        return timedOut;
      };

      const winners: (Chosen | undefined)[] = groups.map(() => undefined);
      const perGroup: OutputRecord[][] = groups.map(() => []);
      for (const size of sizes) {
        checkAbort();
        const frame = await makeFrame(file.abs, header, size, features.alphaUsed, settings);
        const session = await deps.metric.open(frame);
        try {
          for (const [g, group] of groups.entries()) {
            checkAbort();
            const search = new SizeSearch(frame, session, target, shouldStop);
            search.chroma = classification.needsFullChroma ? '4:4:4' : '4:2:0';
            const previousWinner = winners[g];
            const chosen = previousWinner
              ? await search.finalize(await search.search(previousWinner.codec, previousWinner.point.q, 4))
              : await chooseCodec(search, group, target);
            winners[g] ??= chosen;
            if (!chosen.met) result.targetNotMet = true;
            const codec = CODECS[chosen.codec];
            const rel = `${task.stem}${size.suffix}${codec.ext}`;
            const record: OutputRecord = {
              path: rel,
              format: codec.format,
              width: frame.width,
              height: frame.height,
              bytes: chosen.point.bytes,
              quality: codec.lossy ? chosen.point.q : undefined,
              score: Number(chosen.point.score.toFixed(2)),
              group: g,
            };
            // Keep-original guard: same dimensions and nothing smaller than the source.
            const sameSize = !size.crop && frame.width === header.width && frame.height === header.height;
            if (sameSize && chosen.point.bytes >= header.bytes && groups.length === 1) {
              const original = `${task.stem}${size.suffix}${path.extname(file.abs).toLowerCase()}`;
              writes.push({ rel: original, copyOriginal: true });
              Object.assign(record, { path: original, format: header.format, bytes: header.bytes, quality: undefined, score: 100, original: true });
              const meta = header.hasMetadata && settings.metadata === 'strip' ? ' (as is, so its EXIF/XMP metadata is kept)' : '';
              notes.push(`${size.width}px: no re-encode beat the original (${describe(chosen)}), original kept${meta}`);
            } else {
              writes.push({ rel, buf: chosen.point.buf });
              notes.push(`${size.width}px: ${describe(chosen)}`);
            }
            perGroup[g]!.push(record);
            outputs.push(record);
          }
        } finally {
          await session.close();
        }
      }
      groupsOut.push(...perGroup);
      if (timedOut) notes.push('Time budget reached: best result so far used');
    }

    // Write everything only after all encodes succeeded, then record it in the journal.
    const seen = new Set<string>();
    for (const w of writes) {
      const lower = w.rel.toLowerCase();
      if (seen.has(lower)) throw new Error(`Two outputs map to the same file name: ${w.rel}`);
      seen.add(lower);
    }
    await store.claim(sourceKey, writes.map((w) => w.rel));
    for (const w of writes) {
      checkAbort();
      if (w.copyOriginal) await store.copy(w.rel, file.abs);
      else await store.write(w.rel, w.buf!);
    }
    const html = markup(groupsOut, { urlBase: task.urlBase, priority: settings.priority });
    const entry: Entry = {
      source: sourceKey,
      sourceBytes: header.bytes,
      sourceMtimeMs: header.mtimeMs,
      sourceHash: await fileHash(file.abs),
      key,
      class: classification?.cls,
      outputs,
      markup: html,
      note: notes.join('; '),
      updatedAt: new Date().toISOString(),
    };
    await store.record(entry);

    const allOriginal = outputs.every((o) => o.original);
    return Object.assign(result, {
      status: allOriginal ? ('kept' as const) : ('optimized' as const),
      // The primary (largest, first-format) output is what a page would serve.
      bytesAfter: groupsOut[0]?.[0]?.bytes ?? header.bytes,
      outputs: outputs.map((o) => ({ ...o, file: store.abs(o.path) })),
      class: classification?.cls,
      decision: notes.join('; '),
      markup: html,
    });
  } catch (error) {
    result.error = error instanceof AbortError ? 'Cancelled before this image finished.' : error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    result.ms = Date.now() - started;
  }
}

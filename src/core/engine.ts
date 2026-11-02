import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { classify, measure, readHeader } from './analyze.js';
import { CODECS, oxipngAvailable } from './codecs.js';
import { discover, type DiscoveredFile } from './discover.js';
import { Job, JobStore, PixelPool } from './jobs.js';
import { band, MetricPool } from './metric.js';
import { OutputStore } from './output.js';
import { Sandbox, UserError } from './paths.js';
import { processImage } from './pipeline.js';
import { assignOutputs, candidateGroups, mergeSettings, sizesFor, targetScore, type Settings } from './planner.js';

export interface OptimizeRequest {
  paths?: string[] | undefined;
  files?: (Partial<Settings> & { path: string })[] | undefined;
  settings: Partial<Settings>;
  outputDir?: string | undefined;
  urlBase?: string | undefined;
}

export interface PreparedTask {
  file: DiscoveredFile;
  settings: Settings;
  outDir: string;
  stem: string;
}

export interface Prepared {
  tasks: PreparedTask[];
  skipped: { path: string; reason: string }[];
  truncated: boolean;
  outDirs: string[];
}

/** Everything the tools share: sandbox, job store, worker pools. One per process. */
export class Engine {
  readonly jobs = new JobStore();
  readonly metric = new MetricPool(config.slots);
  private readonly pool = new PixelPool(config.slots, config.pixelBudget);
  private engineKeyPromise?: Promise<string>;

  readonly sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
    // Batches touch each file once, so libvips' operation cache only costs memory. It also keeps
    // files it read open (WebP is memory-mapped), and Windows cannot delete or replace an open file.
    sharp.cache(false);
    sharp.concurrency(config.vipsThreads);
  }

  /** Tool and codec versions: part of the "unchanged" key, so upgrades redo files (D15). */
  engineKey(): Promise<string> {
    this.engineKeyPromise ??= oxipngAvailable().then((oxi) =>
      createHash('sha256').update(JSON.stringify([config.version, sharp.versions, oxi])).digest('hex').slice(0, 12),
    );
    return this.engineKeyPromise;
  }

  async prepare(req: OptimizeRequest): Promise<Prepared> {
    if (!req.paths?.length && !req.files?.length) throw new UserError('Pass `paths` (files, folders or globs) and/or `files` (per-file settings).');
    const outputDir = req.outputDir ? await this.sandbox.writable(req.outputDir) : undefined;
    const found = req.paths?.length ? await discover(this.sandbox, req.paths) : { files: [], skipped: [], truncated: false };
    const perFile = new Map<string, Partial<Settings>>();
    for (const f of req.files ?? []) {
      const { path: p, ...overrides } = f;
      const one = await discover(this.sandbox, [p], false);
      found.skipped.push(...one.skipped);
      for (const file of one.files) {
        if (!found.files.some((x) => x.abs === file.abs)) found.files.push(file);
        perFile.set(file.abs, overrides);
      }
    }
    const targets = assignOutputs(found.files, outputDir);
    const outDirs = [...new Set([...targets.values()].map((t) => t.outDir))];
    for (const dir of outDirs) await this.sandbox.writable(dir);
    const tasks = found.files.map((file) => {
      const t = targets.get(file.abs)!;
      return { file, settings: mergeSettings(req.settings, perFile.get(file.abs)), outDir: t.outDir, stem: t.stem };
    });
    return { tasks, skipped: found.skipped, truncated: found.truncated, outDirs };
  }

  /** Starts (or attaches to) an optimisation job. Validation errors are thrown before any job exists. */
  async optimize(req: OptimizeRequest): Promise<{ job: Job; attached: boolean }> {
    const prepared = await this.prepare(req);
    if (!prepared.tasks.length) {
      const why = prepared.skipped.length ? ` Skipped: ${prepared.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}` : '';
      throw new UserError(`No supported images found (JPEG, PNG, WebP, AVIF, GIF, TIFF).${why}`);
    }
    const engineKey = await this.engineKey();
    const key = createHash('sha256').update(JSON.stringify([req, engineKey])).digest('hex');
    return this.jobs.start(key, prepared.outDirs, (job) => this.run(job, prepared, req.urlBase, engineKey));
  }

  private async run(job: Job, prepared: Prepared, urlBase: string | undefined, engineKey: string): Promise<void> {
    job.total = prepared.tasks.length;
    job.skipped = prepared.skipped;
    job.truncated = prepared.truncated;
    const stores = new Map<string, OutputStore>();
    try {
      for (const dir of prepared.outDirs) stores.set(dir, await OutputStore.open(dir));
      const signal = job.controller.signal;
      // Admit images one at a time, in order, as the pool frees up: at most one waiter per job,
      // and no up-front metadata reads for thousands of files.
      const inFlight = new Set<Promise<void>>();
      const names = new Set<string>();
      const showCurrent = () => {
        job.current = names.values().next().value;
        job.changed();
      };
      for (const task of prepared.tasks) {
        const meta = await sharp(task.file.abs).metadata().catch(() => undefined);
        const weight = (meta?.width ?? 1) * (meta?.pageHeight ?? meta?.height ?? 1);
        const release = await this.pool.acquire(weight, signal).catch(() => undefined);
        if (!release) break;
        names.add(task.file.rel);
        showCurrent();
        const p = processImage({ ...task, store: stores.get(task.outDir)!, urlBase }, { metric: this.metric, signal, engineKey })
          .then((result) => {
            job.items.push(result);
            job.done++;
          })
          .finally(() => {
            release();
            inFlight.delete(p);
            names.delete(task.file.rel);
            showCurrent();
          });
        inFlight.add(p);
      }
      await Promise.allSettled(inFlight);
    } finally {
      for (const store of stores.values()) job.manifests.push(await store.close().catch(() => store.dir));
    }
  }

  /** Header facts (fast) or, with `deep`, classification and the plan `auto` would apply. */
  async analyze(paths: string[], o: { recursive: boolean; deep: boolean; offset: number; limit: number; settings?: Partial<Settings> }) {
    const found = await discover(this.sandbox, paths, o.recursive);
    const byFormat: Record<string, { files: number; bytes: number }> = {};
    let totalBytes = 0;
    await Promise.all(
      found.files.map(async (f) => {
        const bytes = (await fs.stat(f.abs)).size;
        const ext = path.extname(f.abs).slice(1).toLowerCase().replace('jpeg', 'jpg').replace('tiff', 'tif');
        byFormat[ext] ??= { files: 0, bytes: 0 };
        byFormat[ext].files++;
        byFormat[ext].bytes += bytes;
        totalBytes += bytes;
      }),
    );
    const settings = mergeSettings(o.settings);
    const targets = assignOutputs(found.files, undefined);
    const page = found.files.slice(o.offset, o.offset + o.limit);
    const items = await Promise.all(
      page.map((f) => {
        const t = targets.get(f.abs)!;
        return this.describe(f.abs, settings, path.join(t.outDir, t.stem), o.deep);
      }),
    );
    return {
      summary: { files: found.files.length, totalBytes, byFormat, skipped: found.skipped, truncated: found.truncated },
      items,
      ...(o.offset + o.limit < found.files.length ? { nextOffset: o.offset + o.limit } : {}),
    };
  }

  /** The plan optimize_images would follow, without encoding (dryRun). */
  async dryRun(req: OptimizeRequest, offset: number, limit: number) {
    const prepared = await this.prepare(req);
    const page = prepared.tasks.slice(offset, offset + limit);
    const items = await Promise.all(page.map((t) => this.describe(t.file.abs, t.settings, path.join(t.outDir, t.stem), true)));
    return {
      dryRun: true,
      files: prepared.tasks.length,
      outputFolders: prepared.outDirs,
      skipped: prepared.skipped,
      truncated: prepared.truncated,
      items,
      ...(offset + limit < prepared.tasks.length ? { nextOffset: offset + limit } : {}),
    };
  }

  /** Header facts for one image; with `deep`, its class, features and planned candidates and sizes. */
  private async describe(abs: string, settings: Settings, output: string, deep: boolean): Promise<Record<string, unknown>> {
    try {
      const h = await readHeader(abs);
      const item: Record<string, unknown> = {
        path: abs,
        format: h.format,
        width: h.width,
        height: h.height,
        bytes: h.bytes,
        hasAlpha: h.hasAlpha,
        ...(h.animated ? { animated: true, frames: h.pages } : {}),
        ...(h.wideGamut ? { wideGamut: 'kept as Display P3' } : {}),
        ...(h.hasGainMap ? { hdrGainMap: 'present; dropped on conversion in v1' } : {}),
        ...(h.unsupported ? { unsupported: h.unsupported } : {}),
      };
      if (!deep || h.unsupported) return item;
      if (h.animated) {
        return Object.assign(item, { class: 'animated', plan: { output: `${output}.webp (animated, q75)` } });
      }
      const features = await measure(abs, h);
      const c = classify(h, features);
      const sizes = sizesFor(h.width, h.height, settings);
      const groups = candidateGroups(settings.policy, {
        cls: c.cls,
        confidence: c.confidence,
        features,
        sourceFormat: h.format,
        wideGamut: h.wideGamut,
        lossless: targetScore(settings.target, c.cls) >= 100,
        maxSide: Math.max(sizes[0]!.width, sizes[0]!.height),
      });
      return Object.assign(item, {
        class: c.cls,
        confidence: c.confidence,
        alphaUsed: features.alphaUsed,
        colours: features.uniqueColours >= 4097 ? '4096+' : features.uniqueColours,
        plan: {
          target: targetScore(settings.target, c.cls),
          candidates: groups,
          chroma: c.needsFullChroma ? '4:4:4' : '4:2:0',
          sizes: sizes.map((s) => `${s.width}x${s.height}`),
          output,
        },
      });
    } catch (error) {
      return { path: abs, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** SSIMULACRA 2 between two images; the original is resized to the candidate's size if they differ. */
  async compare(originalPath: string, candidatePath: string, preview: boolean) {
    const [a, b] = await Promise.all([this.sandbox.existing(originalPath), this.sandbox.existing(candidatePath)]);
    const [ha, hb] = await Promise.all([readHeader(a), readHeader(b)]);
    const alpha = ha.hasAlpha || hb.hasAlpha;
    const decode = (file: string, width: number, height: number, resize: boolean) => {
      let s = sharp(file, { autoOrient: true, limitInputPixels: config.maxInputPixels });
      if (resize) s = s.resize({ width, height, fit: 'fill', kernel: 'lanczos3' }).gamma();
      s = s.toColourspace('srgb');
      return (alpha ? s.ensureAlpha() : s.removeAlpha()).raw().toBuffer({ resolveWithObject: true });
    };
    const resized = ha.width !== hb.width || ha.height !== hb.height;
    const [ra, rb] = await Promise.all([decode(a, hb.width, hb.height, resized), decode(b, hb.width, hb.height, false)]);
    const score = await this.metric.score({ data: ra.data, width: ra.info.width, height: ra.info.height, channels: alpha ? 4 : 3 }, rb.data);
    const result = {
      score: Number(score.toFixed(2)),
      band: band(score),
      original: { path: a, format: ha.format, width: ha.width, height: ha.height, bytes: ha.bytes },
      candidate: { path: b, format: hb.format, width: hb.width, height: hb.height, bytes: hb.bytes },
      ...(resized ? { note: 'Sizes differ: the original was resized to the candidate size before scoring.' } : {}),
    };
    const thumbs = preview
      ? await Promise.all([a, b].map((f) => sharp(f, { autoOrient: true }).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()))
      : [];
    return { result, thumbs };
  }

  /** Available codecs, for the server instructions. */
  static codecs(): string {
    return [...new Set(Object.values(CODECS).map((c) => c.format))].join(', ');
  }
}

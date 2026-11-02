import { McpServer } from '@modelcontextprotocol/server';
import { config } from './config.js';
import type { Engine } from './core/engine.js';
import type { Job } from './core/jobs.js';
import { UserError } from './core/paths.js';
import type { ImageResult } from './core/pipeline.js';
import type { Settings } from './core/planner.js';
import { analyzeInput, cancelJobInput, compareInput, getJobInput, optimizeInput } from './schemas.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface ToolResult {
  [key: string]: unknown;
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Minimal shape of the SDK's request context that the tools use. */
interface RequestContext {
  mcpReq: {
    _meta?: { progressToken?: string | number } | undefined;
    notify(notification: { method: 'notifications/progress'; params: Record<string, unknown> }): Promise<void>;
  };
}

function ok(data: Record<string, unknown>, extra: Content[] = []): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }, ...extra], structuredContent: data };
}

/** Errors become tool results the agent can act on; unexpected ones keep their message. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: error instanceof UserError ? message : `Error: ${message}` }], isError: true };
  }
}

function pickSettings(input: Record<string, unknown>): Partial<Settings> {
  const keys = ['policy', 'target', 'resize', 'crop', 'widths', 'priority', 'metadata'] as const;
  return Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) as Partial<Settings>;
}

const pct = (before: number, after: number) => (before ? Number((((before - after) / before) * 100).toFixed(1)) : 0);

function item(r: ImageResult, detailed: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    source: r.source,
    status: r.status,
    ...(r.status === 'optimized' || r.status === 'kept' || r.status === 'unchanged' ? { bytes: `${r.bytesBefore} → ${r.bytesAfter} (-${pct(r.bytesBefore, r.bytesAfter)}%)` } : {}),
    outputs: r.outputs.map((o) =>
      detailed
        ? { file: o.file, format: o.format, width: o.width, height: o.height, bytes: o.bytes, quality: o.quality, score: o.score, ...(o.original ? { original: true } : {}) }
        : `${o.file} (${o.width}x${o.height}, ${o.bytes} B${o.score !== undefined ? `, score ${o.score}` : ''})`,
    ),
    ...(r.error ? { error: r.error } : {}),
    ...(r.targetNotMet ? { targetNotMet: true } : {}),
  };
  if (detailed) Object.assign(base, { class: r.class, decision: r.decision, markup: r.markup, ms: r.ms });
  else if (r.status === 'skipped' || r.status === 'failed') base.reason = r.decision ?? r.error;
  return base;
}

/** The job as the agent sees it: totals, a page of items, and what to do next. */
export function jobView(job: Job, o: { offset: number; limit: number; detailed: boolean }): Record<string, unknown> {
  const items = [...job.items].sort((a, b) => (a.source < b.source ? -1 : 1));
  const counted = items.filter((r) => r.status !== 'failed' && r.status !== 'skipped');
  const before = counted.reduce((s, r) => s + r.bytesBefore, 0);
  const after = counted.reduce((s, r) => s + r.bytesAfter, 0);
  const counts: Record<string, number> = {};
  for (const r of items) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const page = items.slice(o.offset, o.offset + o.limit);
  const running = job.active;
  return {
    jobId: job.id,
    status: job.status,
    done: job.done,
    total: job.total,
    ...(running && job.current ? { current: job.current } : {}),
    bytesBefore: before,
    bytesAfter: after,
    savedPct: pct(before, after),
    counts,
    ...(job.skipped.length ? { skippedFiles: job.skipped.slice(0, 10) } : {}),
    ...(job.truncated ? { truncated: `Stopped discovering at ${config.maxFiles} files; run again on subfolders.` } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.manifests.length ? { manifests: job.manifests } : {}),
    items: page.map((r) => item(r, o.detailed)),
    ...(o.offset + o.limit < items.length ? { nextOffset: o.offset + o.limit } : {}),
    next: running
      ? `Still working. Call get_job with jobId "${job.id}" to wait for the rest.`
      : 'Done. Each output folder has squoosh-manifest.json with every output and its <picture>/<img> markup; use response_format "detailed" to see markup here.',
  };
}

/** Sends throttled progress notifications while waiting on a job (if the client asked for them). */
async function waitWithProgress(job: Job, ms: number, ctx: RequestContext): Promise<void> {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return job.wait(ms);
  let last = 0;
  const send = () => {
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    void ctx.mcpReq
      .notify({ method: 'notifications/progress', params: { progressToken: token, progress: job.done, total: job.total, message: job.current ? `Optimising ${job.current}` : job.status } })
      .catch(() => undefined);
  };
  const off = job.onChange(send);
  try {
    send();
    await job.wait(ms);
  } finally {
    off();
  }
}

export function createServer(engine: Engine): McpServer {
  const allowed = engine.sandbox.describe;
  const server = new McpServer(
    { name: config.name, version: config.version },
    {
      maxToolInputElements: config.maxToolInputElements,
      instructions:
        `squoosh-mcp optimises local images with Squoosh's codecs (WebP by default; AVIF, MozJPEG, OxiPNG and libimagequant on request). ` +
        `For each image it picks format, size and the lowest quality that still meets a visual-quality score (SSIMULACRA 2). ` +
        `Workflow: analyze_images (deep: true on a sample to see classes and plans) → optimize_images (per-file settings in files[]) → ` +
        `get_job while status is "running". Outputs go to an "optimized" folder inside each input folder; originals are never modified. ` +
        `Allowed directories: ${allowed}.`,
    },
  );

  server.registerTool(
    'analyze_images',
    {
      title: 'Analyse images',
      description:
        `Scan files, folders or globs and report what is there: format, size, dimensions, transparency, animation. ` +
        `With deep: true, also classify each image (photo, screenshot, graphic, icon, animated) and show the plan optimize_images would follow ` +
        `(candidate formats, sizes, quality target, output path). Read-only. Paged: use offset/nextOffset. Allowed directories: ${allowed}.`,
      inputSchema: analyzeInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(async () => {
        const limit = input.deep ? Math.min(input.limit, 50) : input.limit;
        return ok(await engine.analyze(input.paths, { recursive: input.recursive, deep: input.deep, offset: input.offset, limit, settings: pickSettings(input) }));
      }),
  );

  server.registerTool(
    'optimize_images',
    {
      title: 'Optimise images',
      description:
        `Optimise images like an expert, deciding per image. Default policy "auto" writes WebP, which every current browser supports: ` +
        `lossy for photos, lossless or palette for screenshots and graphics, whichever is smallest at the visual target. ` +
        `policy "avif" also tries AVIF (smaller, needs Safari 16.4+); "picture" adds a JPEG/PNG fallback; "keep" keeps the source format. ` +
        `Resizing fits each image's own aspect ratio and never upscales; widths makes srcset sizes; crop makes exact shapes. ` +
        `Writes NEW files to "<input folder>/optimized/" (or outputDir), never touching originals; re-runs skip unchanged files. ` +
        `Works up to ${config.inlineSeconds}s, then returns status "running" with a jobId: call get_job to wait for the rest. ` +
        `Use dryRun: true to preview decisions without encoding. Allowed directories: ${allowed}.`,
      inputSchema: optimizeInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) =>
      guard(async () => {
        const req = {
          paths: input.paths,
          files: input.files?.map((f) => ({ path: f.path, ...pickSettings(f) })),
          settings: pickSettings(input),
          outputDir: input.outputDir,
          urlBase: input.urlBase,
        };
        if (input.dryRun) return ok(await engine.dryRun(req, input.offset, Math.min(input.limit, 50)));
        const { job, attached } = await engine.optimize(req);
        await waitWithProgress(job, config.inlineSeconds * 1000, ctx);
        const view = jobView(job, { offset: input.offset, limit: input.limit, detailed: input.response_format === 'detailed' });
        return ok(attached ? { attachedToExistingJob: true, ...view } : view);
      }),
  );

  server.registerTool(
    'get_job',
    {
      title: 'Get job status',
      description:
        'Progress and results of an optimize_images job. Waits up to waitSeconds for it to finish. ' +
        'Results are paged (offset/nextOffset). Jobs are kept in memory for an hour after they finish, until the server stops.',
      inputSchema: getJobInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) =>
      guard(async () => {
        const job = engine.jobs.get(input.jobId);
        await waitWithProgress(job, input.waitSeconds * 1000, ctx);
        return ok(jobView(job, { offset: input.offset, limit: input.limit, detailed: input.response_format === 'detailed' }));
      }),
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel job',
      description: 'Stop an optimize_images job. Images already written stay, and are recorded in the manifest so a re-run skips them.',
      inputSchema: cancelJobInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(async () => {
        const job = engine.jobs.cancel(input.jobId);
        await job.wait(10_000);
        return ok({ jobId: job.id, status: job.status, done: job.done, total: job.total });
      }),
  );

  server.registerTool(
    'compare_images',
    {
      title: 'Compare images',
      description:
        'Visual similarity of an optimised image to its original, as a SSIMULACRA 2 score (100 = identical; 90+ visually lossless; ' +
        '80+ very high; 70+ high; below 50 visibly degraded), plus both sizes. Use it to check results. Read-only.',
      inputSchema: compareInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(async () => {
        const { result, thumbs } = await engine.compare(input.original, input.candidate, input.preview);
        return ok(result, thumbs.map((t) => ({ type: 'image' as const, data: t.toString('base64'), mimeType: 'image/jpeg' })));
      }),
  );

  return server;
}

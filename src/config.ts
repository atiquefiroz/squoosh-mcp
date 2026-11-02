import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

function intEnv(name: string, fallback: number, min = 1): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

const cores = os.availableParallelism();
const slots = intEnv('SQUOOSH_MCP_CONCURRENCY', Math.max(1, Math.min(4, Math.floor(cores / 2))));

/** Runtime limits. Every value can be overridden with the environment variable named next to it. */
export const config = {
  name: pkg.name,
  version: pkg.version,
  /** Seconds optimize_images works before handing back a jobId (SQUOOSH_MCP_INLINE_SECONDS). */
  inlineSeconds: intEnv('SQUOOSH_MCP_INLINE_SECONDS', 45, 0),
  /** Images processed at once (SQUOOSH_MCP_CONCURRENCY). */
  slots,
  /** libvips threads per image, so slots × threads ≈ cores. */
  vipsThreads: Math.max(1, Math.floor(cores / slots)),
  /** Pixels in flight across all images (SQUOOSH_MCP_PIXEL_BUDGET_MP). */
  pixelBudget: intEnv('SQUOOSH_MCP_PIXEL_BUDGET_MP', 64) * 1_000_000,
  /** Files one call may discover (SQUOOSH_MCP_MAX_FILES). */
  maxFiles: intEnv('SQUOOSH_MCP_MAX_FILES', 10_000),
  /** Largest input file (SQUOOSH_MCP_MAX_INPUT_MB). */
  maxInputBytes: intEnv('SQUOOSH_MCP_MAX_INPUT_MB', 256) * 1024 * 1024,
  /** sharp's decompression-bomb guard, applied per image or per animation frame. */
  maxInputPixels: 268_402_689,
  /** Array elements + object members allowed in one tool call's arguments. */
  maxToolInputElements: 20_000,
  maxRunningJobs: 2,
  maxQueuedJobs: 8,
  jobTtlMs: 60 * 60 * 1000,
  maxGlobDepth: 32,
  /** Per-image time budget: base + per megapixel of the largest output. */
  imageBudgetBaseMs: 60_000,
  imageBudgetPerMpMs: 2_000,
} as const;

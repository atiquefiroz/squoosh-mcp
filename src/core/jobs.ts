import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { UserError } from './paths.js';
import type { ImageResult } from './pipeline.js';

/** Limits images in flight by slots and by total pixels; an image over budget runs alone. */
export class PixelPool {
  private active = 0;
  private pixels = 0;
  private readonly waiting: { weight: number; grant: () => void }[] = [];

  private readonly slots: number;
  private readonly budget: number;

  constructor(slots: number, budget: number) {
    this.slots = slots;
    this.budget = budget;
  }

  private fits(weight: number): boolean {
    return this.active < this.slots && (this.active === 0 || this.pixels + weight <= this.budget);
  }

  /**
   * Waits for a slot and pixel budget, first come first served; resolves with the release function.
   * The slot is reserved before the waiter wakes, so a release can never admit more than fits.
   */
  acquire(weight: number, signal: AbortSignal): Promise<() => void> {
    const w = Math.min(weight, this.budget);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      this.pixels -= w;
      this.drain();
    };
    if (signal.aborted) return Promise.reject(new Error('cancelled'));
    if (!this.waiting.length && this.fits(w)) {
      this.take(w);
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiting.indexOf(waiter);
        if (i !== -1) this.waiting.splice(i, 1);
        reject(new Error('cancelled'));
      };
      const waiter = {
        weight: w,
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private take(w: number): void {
    this.active++;
    this.pixels += w;
  }

  private drain(): void {
    while (this.waiting.length && this.fits(this.waiting[0]!.weight)) {
      const next = this.waiting.shift()!;
      this.take(next.weight);
      next.grant();
    }
  }
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export class Job {
  readonly id = randomUUID().slice(0, 8);
  readonly createdAt = Date.now();
  status: JobStatus = 'queued';
  finishedAt?: number;
  total = 0;
  done = 0;
  current?: string;
  error?: string;
  items: ImageResult[] = [];
  skipped: { path: string; reason: string }[] = [];
  truncated = false;
  manifests: string[] = [];
  readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private settle!: () => void;
  readonly finished = new Promise<void>((resolve) => (this.settle = resolve));

  readonly key: string;
  readonly outDirs: readonly string[];
  readonly run: (job: Job) => Promise<void>;

  constructor(key: string, outDirs: readonly string[], run: (job: Job) => Promise<void>) {
    this.key = key;
    this.outDirs = outDirs;
    this.run = run;
  }

  get active(): boolean {
    return this.status === 'queued' || this.status === 'running';
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    for (const fn of this.listeners) fn();
  }

  finish(status: JobStatus, error?: string): void {
    this.status = status;
    if (error) this.error = error;
    this.finishedAt = Date.now();
    this.current = undefined;
    this.changed();
    this.settle();
  }

  /** Resolves when the job ends or `ms` pass, whichever is first. */
  async wait(ms: number): Promise<void> {
    if (!this.active || ms <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.finished, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }
}

/**
 * Process-wide job store. A call identical to an active job returns that job (so a client
 * retry after a timeout attaches instead of duplicating work); a job whose output folders
 * overlap an active job's is refused; finished jobs expire after an hour.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  private prune(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (!job.active && now - (job.finishedAt ?? now) > config.jobTtlMs) this.jobs.delete(id);
    }
  }

  start(key: string, outDirs: string[], run: (job: Job) => Promise<void>): { job: Job; attached: boolean } {
    this.prune();
    const active = [...this.jobs.values()].filter((j) => j.active);
    const same = active.find((j) => j.key === key);
    if (same) return { job: same, attached: true };
    const clash = active.find((j) => j.outDirs.some((d) => outDirs.includes(d)));
    if (clash) {
      throw new UserError(`Job ${clash.id} is already writing to ${clash.outDirs.join(', ')}. Wait with get_job, or stop it with cancel_job.`);
    }
    if (active.filter((j) => j.status === 'queued').length >= config.maxQueuedJobs) {
      throw new UserError('Too many queued jobs. Wait for running jobs to finish (get_job), then try again.');
    }
    const job = new Job(key, outDirs, run);
    this.jobs.set(job.id, job);
    this.pump();
    return { job, attached: false };
  }

  private pump(): void {
    const running = [...this.jobs.values()].filter((j) => j.status === 'running').length;
    const next = [...this.jobs.values()].find((j) => j.status === 'queued');
    if (!next || running >= config.maxRunningJobs) return;
    next.status = 'running';
    next.changed();
    void next
      .run(next)
      .then(
        () => next.finish(next.controller.signal.aborted ? 'cancelled' : 'completed'),
        (error: unknown) => next.finish(next.controller.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error)),
      )
      .finally(() => this.pump());
    this.pump();
  }

  get(id: string): Job {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new UserError(`Unknown or expired jobId "${id}". Finished jobs are kept for an hour; start a new optimize_images call.`);
    return job;
  }

  cancel(id: string): Job {
    const job = this.get(id);
    if (job.status === 'queued') job.finish('cancelled');
    job.controller.abort();
    return job;
  }
}

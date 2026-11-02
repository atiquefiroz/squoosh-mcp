import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './paths.js';

export const MANIFEST = 'squoosh-manifest.json';
export const JOURNAL = '.squoosh-journal.jsonl';
const LOCK = '.squoosh.lock';
const TEMP_FILE = /\.tmp-[0-9a-f]+$/;

export interface OutputRecord {
  /** Relative to the output folder, POSIX. */
  path: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  quality?: number | undefined;
  score?: number | undefined;
  /** This output is a copy of the original (nothing re-encoded was smaller). */
  original?: boolean | undefined;
  /** Index of the format group (0 = primary; the last group is the <img> fallback). */
  group?: number | undefined;
}

export interface Entry {
  /** Source path relative to the output folder, POSIX. */
  source: string;
  sourceBytes: number;
  sourceMtimeMs: number;
  sourceHash: string;
  /** Hash of effective settings + tool and codec versions: a re-run skips only when it matches. */
  key: string;
  class?: string | undefined;
  outputs: OutputRecord[];
  markup?: string | undefined;
  note?: string | undefined;
  updatedAt: string;
}

interface ManifestFile {
  generator: string;
  version: number;
  entries: Entry[];
  /** Paths claimed for a source whose write was interrupted: still ours to overwrite. */
  orphans?: Record<string, string>;
}

/** A journal line: a finished entry, or a claim written before a source's files are. */
type JournalLine = Entry | { claim: string; paths: string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

/** Write to a temp file in the same folder, then rename into place (retrying Windows sharing errors). */
export async function atomicWrite(file: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await sleep(50 * 2 ** attempt);
        continue;
      }
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }
}

async function removeTempFiles(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  await Promise.all(
    entries.filter((e) => e.isFile() && TEMP_FILE.test(e.name)).map((e) => fs.rm(path.join(e.parentPath, e.name), { force: true })),
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const openStores = new Set<string>();

/**
 * One output folder: a lock against other processes, an index of what we wrote (so we only
 * ever overwrite our own files), an append-only journal written after each rename, and a
 * manifest compacted from it when the job ends. A crash loses nothing: the journal replays.
 */
export class OutputStore {
  private readonly entries = new Map<string, Entry>();
  /** Lower-cased output path → the source that owns it. */
  private readonly owned = new Map<string, string>();
  private journalQueue: Promise<void> = Promise.resolve();
  private dirty = false;

  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(dir: string): Promise<OutputStore> {
    if (openStores.has(dir)) throw new UserError(`Another job is already writing to ${dir}. Wait for it, or cancel it with cancel_job.`);
    await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, LOCK);
    const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    try {
      await fs.writeFile(lock, body, { flag: 'wx' });
    } catch {
      const held = JSON.parse(await fs.readFile(lock, 'utf8').catch(() => '{}')) as { pid?: number };
      if (held.pid && held.pid !== process.pid && processAlive(held.pid)) {
        throw new UserError(`${dir} is locked by another squoosh-mcp process (pid ${held.pid}). Wait for it to finish.`);
      }
      await fs.writeFile(lock, body);
    }
    openStores.add(dir);
    const store = new OutputStore(dir);
    try {
      await removeTempFiles(dir);
      await store.load();
    } catch (error) {
      await store.release();
      throw error;
    }
    return store;
  }

  private async load(): Promise<void> {
    const text = await fs.readFile(path.join(this.dir, MANIFEST), 'utf8').catch(() => undefined);
    if (text) {
      const manifest = JSON.parse(text) as ManifestFile;
      for (const entry of manifest.entries ?? []) this.put(entry);
      for (const [p, source] of Object.entries(manifest.orphans ?? {})) this.owned.set(p.toLowerCase(), source);
    }
    const journal = await fs.readFile(path.join(this.dir, JOURNAL), 'utf8').catch(() => '');
    for (const line of journal.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as JournalLine;
        if ('claim' in item) for (const p of item.paths) this.owned.set(p.toLowerCase(), item.claim);
        else this.put(item);
        this.dirty = true;
      } catch {
        // A torn last line from a crash: everything before it is intact.
      }
    }
  }

  private put(entry: Entry): void {
    this.entries.set(entry.source, entry);
    for (const o of entry.outputs) this.owned.set(o.path.toLowerCase(), entry.source);
  }

  lookup(source: string): Entry | undefined {
    return this.entries.get(source);
  }

  abs(rel: string): string {
    return path.join(this.dir, ...rel.split('/'));
  }

  async outputsExist(entry: Entry): Promise<boolean> {
    for (const o of entry.outputs) if (!(await exists(this.abs(o.path)))) return false;
    return true;
  }

  /**
   * Reserves output paths for one source and journals the claim before any file is written, so a
   * write cut short by a crash or cancel leaves files that are still ours. Refuses paths owned by
   * another source (photo.jpg at 640w vs a source named photo-640w.png) and files we did not create.
   */
  async claim(source: string, rels: readonly string[]): Promise<void> {
    const fresh: string[] = [];
    for (const rel of rels) {
      const owner = this.owned.get(rel.toLowerCase());
      if (owner !== undefined && owner !== source) {
        throw new UserError(`${this.abs(rel)} is already the output of ${owner}. Rename one of the two sources, or use another outputDir.`);
      }
      if (owner === undefined) fresh.push(rel);
    }
    // Reserve synchronously, before any await, so concurrent images cannot claim the same path.
    for (const rel of fresh) this.owned.set(rel.toLowerCase(), source);
    try {
      for (const rel of fresh) {
        if (await exists(this.abs(rel))) {
          throw new UserError(`${this.abs(rel)} already exists and was not created by squoosh-mcp. Move it, or choose another outputDir.`);
        }
      }
    } catch (error) {
      for (const rel of fresh) this.owned.delete(rel.toLowerCase());
      throw error;
    }
    this.dirty = true;
    await this.append({ claim: source, paths: [...rels] });
  }

  private append(line: JournalLine): Promise<void> {
    this.journalQueue = this.journalQueue.then(() => fs.appendFile(path.join(this.dir, JOURNAL), `${JSON.stringify(line)}\n`));
    return this.journalQueue;
  }

  async write(rel: string, data: Buffer): Promise<void> {
    await atomicWrite(this.abs(rel), data);
  }

  async copy(rel: string, from: string): Promise<void> {
    await this.write(rel, await fs.readFile(from));
  }

  /** Records a finished source after its files are in place. */
  record(entry: Entry): Promise<void> {
    this.put(entry);
    this.dirty = true;
    return this.append(entry);
  }

  /** Compacts the journal into the manifest and releases the lock. */
  async close(): Promise<string> {
    await this.journalQueue.catch(() => undefined);
    const manifestPath = path.join(this.dir, MANIFEST);
    try {
      if (this.dirty) {
        const entries = [...this.entries.values()].sort((a, b) => (a.source < b.source ? -1 : 1));
        const recorded = new Set(entries.flatMap((e) => e.outputs.map((o) => o.path.toLowerCase())));
        const orphans = Object.fromEntries([...this.owned].filter(([p]) => !recorded.has(p)).sort());
        const manifest: ManifestFile = { generator: 'squoosh-mcp', version: 1, entries, ...(Object.keys(orphans).length ? { orphans } : {}) };
        await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await fs.rm(path.join(this.dir, JOURNAL), { force: true });
      }
    } finally {
      await this.release();
    }
    return manifestPath;
  }

  private async release(): Promise<void> {
    openStores.delete(this.dir);
    await fs.rm(path.join(this.dir, LOCK), { force: true });
  }
}

export interface MarkupOptions {
  urlBase?: string | undefined;
  priority?: boolean | undefined;
  sizes?: string | undefined;
}

const escapeAttr = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

/**
 * `<picture>`/`<img>` markup. Outputs of one format form a srcset; the last group is the
 * `<img>` fallback. Width and height prevent layout shift; hero images get `priority`.
 */
export function markup(groups: OutputRecord[][], o: MarkupOptions = {}): string {
  const url = (rel: string) => escapeAttr(o.urlBase ? `${o.urlBase.replace(/\/+$/, '')}/${rel}` : rel);
  const sizes = escapeAttr(o.sizes ?? '100vw');
  const srcset = (g: OutputRecord[]) => (g.length > 1 ? g.map((r) => `${url(r.path)} ${r.width}w`).join(', ') : '');
  const usable = groups.filter((g) => g.length);
  const img = usable.at(-1)!;
  const largest = img[0]!;
  const loading = o.priority ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  const imgSet = srcset(img);
  const imgTag = `<img src="${url(largest.path)}"${imgSet ? ` srcset="${imgSet}" sizes="${sizes}"` : ''} width="${largest.width}" height="${largest.height}" alt="" ${loading} decoding="async">`;
  if (usable.length === 1) return imgTag;
  const sources = usable.slice(0, -1).map((g) => {
    const set = srcset(g) || url(g[0]!.path);
    return `  <source type="image/${g[0]!.format}" srcset="${set}"${g.length > 1 ? ` sizes="${sizes}"` : ''}>`;
  });
  return `<picture>\n${sources.join('\n')}\n  ${imgTag}\n</picture>`;
}

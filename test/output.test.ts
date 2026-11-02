import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOURNAL, MANIFEST, OutputStore, markup, type Entry, type OutputRecord } from '../src/core/output.js';
import { UserError } from '../src/core/paths.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-store-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const entry = (source: string, out: string): Entry => ({
  source,
  sourceBytes: 10,
  sourceMtimeMs: 1,
  sourceHash: 'h',
  key: 'k',
  class: 'photo',
  outputs: [{ path: out, format: 'avif', width: 1, height: 1, bytes: 1 }],
  markup: '',
  note: '',
  updatedAt: '2026-11-02T00:00:00.000Z',
});

describe('OutputStore', () => {
  it('persists entries through the manifest across runs', async () => {
    const store = await OutputStore.open(dir);
    await store.write('a.avif', Buffer.from('x'));
    await store.record(entry('../a.png', 'a.avif'));
    await store.close();
    const again = await OutputStore.open(dir);
    expect(again.lookup('../a.png')?.outputs[0]?.path).toBe('a.avif');
    expect(await again.outputsExist(again.lookup('../a.png')!)).toBe(true);
    await again.close();
    await expect(fs.access(path.join(dir, JOURNAL))).rejects.toThrow();
  });

  it('replays the journal after a crash and ignores a torn last line', async () => {
    const lines = [JSON.stringify(entry('../a.png', 'a.avif')), JSON.stringify(entry('../b.png', 'b.avif')), '{"source":"../c.p'];
    await fs.writeFile(path.join(dir, JOURNAL), lines.join('\n'));
    const store = await OutputStore.open(dir);
    expect(store.lookup('../b.png')).toBeDefined();
    expect(store.lookup('../c.png')).toBeUndefined();
    await store.close();
    const manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8')) as { entries: Entry[] };
    expect(manifest.entries.map((e) => e.source).sort()).toEqual(['../a.png', '../b.png']);
  });

  it('refuses a second writer and files it did not create', async () => {
    const store = await OutputStore.open(dir);
    await expect(OutputStore.open(dir)).rejects.toThrow(UserError);
    await fs.writeFile(path.join(dir, 'theirs.avif'), 'x');
    await expect(store.claim('../a.png', ['theirs.avif'])).rejects.toThrow(/not created by squoosh-mcp/);
    // A case variant is the same file where names ignore case (macOS, Windows), and a new file on Linux.
    const sameFile = await fs.access(path.join(dir, 'THEIRS.AVIF')).then(() => true, () => false);
    const variant = store.claim('../a.png', ['THEIRS.AVIF']);
    if (sameFile) await expect(variant).rejects.toThrow(/not created by squoosh-mcp/);
    else await expect(variant).resolves.toBeUndefined();
    await store.record(entry('../a.png', 'mine.avif'));
    await expect(store.claim('../a.png', ['mine.avif'])).resolves.toBeUndefined();
    await store.close();
  });

  it("refuses another source's output path (regression: photo.jpg at 640w vs photo-640w.png)", async () => {
    const store = await OutputStore.open(dir);
    await store.claim('../photo.jpg', ['photo-640w.webp']);
    await expect(store.claim('../photo-640w.png', ['photo-640w.webp'])).rejects.toThrow(/already the output of \.\.\/photo\.jpg/);
    await store.close();
  });

  it('keeps files from an interrupted write owned by their source (regression: they blocked re-runs)', async () => {
    const store = await OutputStore.open(dir);
    await store.claim('../a.png', ['a.webp', 'a-640w.webp']);
    await fs.writeFile(path.join(dir, 'a.webp'), 'half');
    await store.close(); // cancelled before record()
    const again = await OutputStore.open(dir);
    await expect(again.claim('../a.png', ['a.webp'])).resolves.toBeUndefined();
    await expect(again.claim('../b.png', ['a.webp'])).rejects.toThrow(UserError);
    await again.close();
  });
});

describe('markup', () => {
  const rec = (p: string, format: string, width: number): OutputRecord => ({ path: p, format, width, height: width / 2, bytes: 1 });

  it('a single output is a plain lazy <img> with intrinsic size', () => {
    expect(markup([[rec('a.avif', 'avif', 800)]])).toBe('<img src="a.avif" width="800" height="400" alt="" loading="lazy" decoding="async">');
  });

  it('two formats make a <picture>; priority images load eagerly', () => {
    const html = markup([[rec('a-800w.avif', 'avif', 800), rec('a-400w.avif', 'avif', 400)], [rec('a-800w.jpg', 'jpeg', 800), rec('a-400w.jpg', 'jpeg', 400)]], {
      urlBase: '/img',
      priority: true,
    });
    expect(html).toContain('<source type="image/avif" srcset="/img/a-800w.avif 800w, /img/a-400w.avif 400w"');
    expect(html).toContain('<img src="/img/a-800w.jpg"');
    expect(html).toContain('loading="eager" fetchpriority="high"');
  });
});

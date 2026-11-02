// End to end through the MCP protocol: client ⇄ in-memory transport ⇄ server ⇄ engine ⇄ real files.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/core/engine.js';
import { Sandbox } from '../src/core/paths.js';
import { createServer } from '../src/server.js';

let dir: string;
let engine: Engine;
let client: Client;

type Result = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-e2e-')));
  const noise = Buffer.alloc(640 * 480 * 3).map((_, i) => (i * 2654435761) % 256);
  await sharp(noise, { raw: { width: 640, height: 480, channels: 3 } }).blur(1.5).jpeg({ quality: 92 }).toFile(path.join(dir, 'photo.jpg'));
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><circle cx="100" cy="100" r="80" fill="#ff5a36"/><rect x="220" y="60" width="150" height="80" fill="#073b4c"/></svg>'))
    .png()
    .toFile(path.join(dir, 'logo.png'));
  const frames = await Promise.all(['#ef4444', '#3b82f6'].map((c) => sharp({ create: { width: 64, height: 64, channels: 3, background: c } }).png().toBuffer()));
  await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100] }).toFile(path.join(dir, 'anim.gif'));
  await fs.writeFile(path.join(dir, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

  engine = new Engine(await Sandbox.create([dir]));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(engine).connect(serverSide);
  client = new Client({ name: 'e2e', version: '0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close();
  await engine?.metric.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('squoosh-mcp over MCP', () => {
  it('lists five tools with safety annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['analyze_images', 'cancel_job', 'compare_images', 'get_job', 'optimize_images']);
    const optimize = tools.find((t) => t.name === 'optimize_images')!;
    expect(optimize.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(tools.find((t) => t.name === 'analyze_images')!.annotations?.readOnlyHint).toBe(true);
  });

  it('analyses and classifies, skipping vector files with a reason', async () => {
    const r = await call('analyze_images', { paths: ['.'], deep: true });
    const data = r.structuredContent as { summary: { files: number; skipped: unknown[] }; items: { path: string; class: string }[] };
    expect(data.summary.files).toBe(3);
    expect(data.summary.skipped).toHaveLength(1);
    const cls = Object.fromEntries(data.items.map((i) => [path.basename(i.path), i.class]));
    expect(cls).toEqual({ 'anim.gif': 'animated', 'logo.png': 'graphic', 'photo.jpg': 'photo' });
  });

  it('optimises every image, writes smaller files and a manifest, then skips them on re-run', async () => {
    const r = await call('optimize_images', { paths: ['.'], response_format: 'detailed' });
    expect(r.isError).toBeFalsy();
    type Item = { source: string; status: string; outputs: { file: string; bytes: number; width: number; height: number }[] };
    const job = r.structuredContent as { status: string; counts: Record<string, number>; items: Item[] };
    expect(job.status).toBe('completed');
    const status = Object.fromEntries(job.items.map((i) => [path.basename(i.source), i.status]));
    // The two-frame GIF is ~200 bytes: animated WebP cannot beat it, so the original is kept.
    expect(status).toEqual({ 'anim.gif': 'kept', 'logo.png': 'optimized', 'photo.jpg': 'optimized' });
    for (const item of job.items) {
      const before = (await fs.stat(item.source)).size;
      for (const o of item.outputs) {
        if (item.status === 'kept') expect(o.bytes).toBe(before);
        else expect(o.bytes).toBeLessThan(before);
        const meta = await sharp(o.file).metadata();
        expect([meta.width, meta.pageHeight ?? meta.height]).toEqual([o.width, o.height]);
      }
    }
    await expect(fs.access(path.join(dir, 'optimized', 'squoosh-manifest.json'))).resolves.toBeUndefined();

    const again = await call('optimize_images', { paths: ['.'] });
    expect((again.structuredContent as { counts: Record<string, number> }).counts).toEqual({ unchanged: 3 });
  });

  it('handles strict targets and lossless <picture> (regression: probe quality out of range, duplicate names)', async () => {
    const r = await call('optimize_images', {
      files: [
        { path: 'logo.png', target: 'lossless-look' },
        { path: 'photo.jpg', policy: 'picture', target: 100 },
      ],
      outputDir: 'strict',
      response_format: 'detailed',
    });
    const job = r.structuredContent as { counts: Record<string, number>; items: { source: string; status: string; outputs: { file: string; score?: number }[]; error?: string }[] };
    expect(job.items.map((i) => i.error).filter(Boolean)).toEqual([]);
    const logo = job.items.find((i) => i.source.endsWith('logo.png'))!;
    expect(logo.outputs[0]!.score).toBeGreaterThanOrEqual(95);
    const photo = job.items.find((i) => i.source.endsWith('photo.jpg'))!;
    // Lossless WebP for the <source>, lossless PNG for the <img> fallback.
    expect(photo.outputs.map((o) => path.extname(o.file)).sort()).toEqual(['.png', '.webp']);
  });

  it('rebuilds markup when only urlBase changes (regression: stale markup)', async () => {
    const r = await call('optimize_images', { paths: ['photo.jpg'], urlBase: '/cdn', response_format: 'detailed' });
    const item = (r.structuredContent as { items: { status: string; markup: string }[] }).items[0]!;
    expect(item.status).toBe('unchanged');
    expect(item.markup).toContain('src="/cdn/photo.webp"');
  });

  it('compares an output with its original', async () => {
    const r = await call('compare_images', { original: 'photo.jpg', candidate: 'optimized/photo.webp' });
    const data = r.structuredContent as { score: number; band: string };
    expect(data.score).toBeGreaterThan(70);
    expect(data.band).toMatch(/high|excellent|lossless/);
  });

  it('refuses paths outside the allowed folders as a tool error', async () => {
    const r = await call('analyze_images', { paths: ['/etc'] });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/outside the allowed directories/);
  });
});

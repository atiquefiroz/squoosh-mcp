import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscoveredFile } from '../src/core/discover.js';
import { assignOutputs, candidateGroups, mergeSettings, sizesFor, targetScore, type CandidateInput } from '../src/core/planner.js';

describe('sizesFor', () => {
  it('never upscales and keeps the aspect ratio', () => {
    expect(sizesFor(800, 600, { resize: { maxWidth: 4000 } })).toEqual([{ width: 800, height: 600, suffix: '' }]);
    expect(sizesFor(4000, 3000, { resize: { maxWidth: 1000 } })).toEqual([{ width: 1000, height: 750, suffix: '' }]);
    expect(sizesFor(1000, 4000, { resize: { maxWidth: 1000, maxHeight: 1000 } })).toEqual([{ width: 250, height: 1000, suffix: '' }]);
  });

  it('builds auto srcset widths below the base, skipping near-duplicates', () => {
    const sizes = sizesFor(2000, 1333, { widths: 'auto' });
    expect(sizes.map((s) => s.width)).toEqual([2000, 1280, 960, 640]);
    expect(sizes.every((s) => s.suffix === `-${s.width}w`)).toBe(true);
    expect(sizes[1]!.height).toBe(853);
  });

  it('clamps and de-duplicates explicit widths', () => {
    expect(sizesFor(1000, 500, { widths: [3000, 1000, 400, 400] }).map((s) => s.width)).toEqual([1000, 400]);
  });

  it('shrinks a crop box that is larger than the source, keeping its shape', () => {
    const [size] = sizesFor(300, 200, { crop: { width: 400, height: 400, strategy: 'attention' } });
    expect(size).toMatchObject({ width: 200, height: 200 });
  });
});

describe('assignOutputs', () => {
  const file = (root: string, rel: string): DiscoveredFile => ({ abs: `${root}/${rel}`, root, rel });

  it('gives same-stem sources distinct, case-insensitive names', () => {
    const files = [file('/r', 'photo.jpg'), file('/r', 'photo.png'), file('/r', 'Photo.webp'), file('/r', 'sub/photo.jpg')];
    const out = assignOutputs(files, undefined);
    const stems = files.map((f) => out.get(f.abs)!.stem);
    expect(new Set(stems.map((s) => s.toLowerCase())).size).toBe(4);
    expect(out.get('/r/sub/photo.jpg')!.stem).toBe('sub/photo');
    expect(out.get('/r/photo.jpg')!.outDir).toBe(path.join('/r', 'optimized'));
  });

  it('prefixes the root name when several roots share one outputDir', () => {
    const out = assignOutputs([file('/a/site', 'x.png'), file('/b/blog', 'x.png')], '/out');
    expect(out.get('/a/site/x.png')).toEqual({ outDir: '/out', stem: 'site/x' });
    expect(out.get('/b/blog/x.png')).toEqual({ outDir: '/out', stem: 'blog/x' });
  });
});

describe('candidateGroups', () => {
  const base: CandidateInput = { cls: 'photo', confidence: 1, features: { alphaUsed: false }, sourceFormat: 'jpeg', wideGamut: false, maxSide: 2000 };

  it('auto is WebP only; avif adds AVIF', () => {
    expect(candidateGroups('auto', base)).toEqual([['webp']]);
    expect(candidateGroups('auto', { ...base, cls: 'screenshot' })).toEqual([['webp-lossless', 'webp-palette', 'webp']]);
    expect(candidateGroups('avif', base)).toEqual([['avif', 'webp']]);
    expect(candidateGroups('avif', { ...base, cls: 'graphic' })).toEqual([['webp-palette', 'webp-lossless', 'avif']]);
  });

  it('picture: adds a JPEG fallback for opaque photos and a PNG one with alpha', () => {
    expect(candidateGroups('picture', base)[1]).toEqual(['jpeg']);
    expect(candidateGroups('picture', { ...base, features: { alphaUsed: true } })[1]).not.toContain('jpeg');
  });

  it('falls back to MozJPEG when the image is too wide for AVIF and WebP', () => {
    expect(candidateGroups('auto', { ...base, maxSide: 17_000 })).toEqual([['jpeg']]);
    expect(candidateGroups('avif', { ...base, maxSide: 17_000 })).toEqual([['jpeg']]);
    expect(candidateGroups('auto', { ...base, maxSide: 17_000, features: { alphaUsed: true } })).toEqual([['png']]);
  });

  it('picture never yields two groups of the same format (regression: duplicate file names)', () => {
    expect(candidateGroups('picture', { ...base, lossless: true })).toEqual([['webp-lossless'], ['png']]);
    expect(candidateGroups('picture', { ...base, maxSide: 17_000 })).toEqual([['jpeg']]);
  });

  it('target 100 keeps only lossless encoders', () => {
    expect(candidateGroups('auto', { ...base, lossless: true })).toEqual([['webp-lossless']]);
    expect(candidateGroups('auto', { ...base, cls: 'screenshot', lossless: true })).toEqual([['webp-lossless']]);
  });

  it('drops the quantiser that loses ICC profiles for wide-gamut images', () => {
    const keepPng = { ...base, sourceFormat: 'png', cls: 'graphic' as const };
    expect(candidateGroups('keep', keepPng)[0]).toContain('png-quant');
    expect(candidateGroups('keep', { ...keepPng, wideGamut: true })[0]).not.toContain('png-quant');
  });
});

describe('targets and settings', () => {
  it('presets are stricter for flat UI content; numbers apply as given', () => {
    expect(targetScore('balanced', 'photo')).toBe(75);
    expect(targetScore('balanced', 'screenshot')).toBe(85);
    expect(targetScore('lossless-look', 'icon')).toBe(95);
    expect(targetScore(70, 'screenshot')).toBe(70);
  });

  it('later layers win and undefined values are ignored', () => {
    const s = mergeSettings({ target: 'high', policy: 'keep' }, { target: undefined, policy: 'picture' });
    expect(s).toMatchObject({ target: 'high', policy: 'picture', metadata: 'strip' });
  });
});

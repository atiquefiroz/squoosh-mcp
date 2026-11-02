import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify, countColours, edgeFeatures, isWideGamutProfile, measure, readHeader } from '../src/core/analyze.js';

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-analyze-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const iccOf = async (profile: string) => (await sharp(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).withIccProfile(profile).png().toBuffer()).metadata()).icc;

describe('isWideGamutProfile', () => {
  it('reads primaries, so libvips\' "sP3C" counts as wide and sRGB does not (regression)', async () => {
    expect(isWideGamutProfile(await iccOf('p3'))).toBe(true);
    expect(isWideGamutProfile(await iccOf('srgb'))).toBe(false);
    expect(isWideGamutProfile(undefined)).toBe(false);
  });
});

describe('pixel features', () => {
  it('counts colours up to the cap', () => {
    const rgba = new Uint8Array(5000 * 4).map((_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) % 256));
    expect(countColours(rgba)).toBe(256);
  });

  it('flat images are flat, checkerboards are all edges', () => {
    const flat = new Uint8Array(16 * 16 * 4).fill(200);
    expect(edgeFeatures(flat, 16, 16)).toEqual({ flatRatio: 1, hardEdgeRatio: 0 });
    const checker = new Uint8Array(16 * 16 * 4).map((_, i) => {
      const p = Math.floor(i / 4);
      return i % 4 === 3 ? 255 : ((p % 16) + Math.floor(p / 16)) % 2 ? 255 : 0;
    });
    expect(edgeFeatures(checker, 16, 16).hardEdgeRatio).toBeGreaterThan(0.9);
  });
});

describe('classify', () => {
  it('tells a photo from a logo and an icon', async () => {
    const photo = path.join(dir, 'photo.png');
    const noise = Buffer.alloc(600 * 400 * 3).map((_, i) => (i * 2654435761) % 256);
    await sharp(noise, { raw: { width: 600, height: 400, channels: 3 } }).blur(1.5).png().toFile(photo);
    const logo = path.join(dir, 'logo.png');
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><circle cx="150" cy="150" r="120" fill="#e63946"/><rect x="320" y="80" width="220" height="140" fill="#1d3557"/></svg>')).png().toFile(logo);
    const icon = path.join(dir, 'icon.png');
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="8" y="8" width="48" height="48" rx="10" fill="#2563eb"/></svg>')).png().toFile(icon);

    const cls = async (f: string) => {
      const h = await readHeader(f);
      return classify(h, await measure(f, h)).cls;
    };
    expect(await cls(photo)).toBe('photo');
    expect(await cls(logo)).toBe('graphic');
    expect(await cls(icon)).toBe('icon');
  });
});

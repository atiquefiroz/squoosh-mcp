import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { band, MetricPool, pickTiles, type Pixels } from '../src/core/metric.js';

const blank = (width: number, height: number): Pixels => ({ data: new Uint8Array(width * height * 3), width, height, channels: 3 });

describe('pickTiles', () => {
  it('scores small images whole', () => {
    expect(pickTiles(blank(1000, 1000))).toEqual([{ x: 0, y: 0, width: 1000, height: 1000 }]);
  });

  it('covers mid-size images with the centre plus another tile (regression: 1600x1600 got only one)', () => {
    const tiles = pickTiles(blank(1600, 1600));
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toEqual({ x: 288, y: 288, width: 1024, height: 1024 });
    expect(tiles[1]).not.toEqual(tiles[0]);
  });

  it('fits tiles inside panoramas', () => {
    for (const t of pickTiles(blank(17_000, 600))) {
      expect(t.height).toBe(600);
      expect(t.x + t.width).toBeLessThanOrEqual(17_000);
    }
  });
});

describe('MetricPool', () => {
  const pool = new MetricPool(1);
  afterAll(() => pool.close());

  it('scores sharp output buffers (regression: they could not be transferred to the worker)', async () => {
    const noise = Buffer.alloc(256 * 256 * 3).map((_, i) => (i * 7919) % 251);
    const { data } = await sharp(noise, { raw: { width: 256, height: 256, channels: 3 } }).raw().toBuffer({ resolveWithObject: true });
    const ref: Pixels = { data, width: 256, height: 256, channels: 3 };
    expect(await pool.score(ref, Buffer.from(data))).toBeGreaterThan(99.9);
    const blurred = await sharp(noise, { raw: { width: 256, height: 256, channels: 3 } }).blur(2).raw().toBuffer();
    expect(await pool.score(ref, blurred)).toBeLessThan(60);
  });

  it('maps scores to the published bands', () => {
    expect([band(95), band(86), band(81), band(72), band(55), band(10)]).toEqual(['visually-lossless', 'excellent', 'very-high', 'high', 'medium', 'low']);
  });
});

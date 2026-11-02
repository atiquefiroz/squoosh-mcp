// Benchmark: sharp (native libvips) vs jSquash (Squoosh WASM codecs) vs @napi-rs/image
// Same raw RGBA input for every encoder; quality checked with ssim.js against the input.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import jpegEnc, { init as initJpegEnc } from '@jsquash/jpeg/encode.js';
import webpEnc, { init as initWebpEnc } from '@jsquash/webp/encode.js';
import avifEnc, { init as initAvifEnc } from '@jsquash/avif/encode.js';
import oxipng, { init as initOxi } from '@jsquash/oxipng/optimise.js';
import ssimMod from 'ssim.js';
import * as napi from '@napi-rs/image';

const ssim = ssimMod.ssim || ssimMod.default || ssimMod;
const nm = (p) => path.join(import.meta.dirname, 'node_modules', p);
const compile = (p) => WebAssembly.compile(fs.readFileSync(nm(p)));

await initJpegEnc(await compile('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'));
await initWebpEnc(await compile('@jsquash/webp/codec/enc/webp_enc_simd.wasm'));
await initAvifEnc(await compile('@jsquash/avif/codec/enc/avif_enc.wasm'));
await initOxi(await compile('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm'));

const RUNS = Number(process.env.RUNS || 3);
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function timeit(fn) {
  const ts = []; let out;
  for (let i = 0; i < RUNS; i++) { const t = performance.now(); out = await fn(); ts.push(performance.now() - t); }
  return { out: Buffer.from(out), ms: median(ts) };
}

async function quality(ref, encoded) {
  const { data, info } = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const t = performance.now();
  const r = ssim({ data: new Uint8ClampedArray(ref.data), width: ref.width, height: ref.height },
                 { data: new Uint8ClampedArray(data), width: info.width, height: info.height },
                 { ssim: 'weber' });
  const ssimMs = performance.now() - t;
  // PSNR on RGB
  let se = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) { const d = data[i + c] - ref.data[i + c]; se += d * d; n++; }
  const psnr = 10 * Math.log10((255 * 255) / (se / n));
  return { ssim: r.mssim, psnr, ssimMs };
}

async function loadRef(file, width) {
  let p = sharp(file).rotate();
  if (width) p = p.resize({ width, kernel: 'lanczos3' });
  const { data, info } = await p.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const images = JSON.parse(process.argv[2]);
const rows = [];
for (const { name, file, width } of images) {
  const ref = await loadRef(file, width);
  const raw = { raw: { width: ref.width, height: ref.height, channels: 4 } };
  const imageData = { data: new Uint8ClampedArray(ref.data), width: ref.width, height: ref.height };
  const losslessPng = await sharp(ref.data, raw).png({ compressionLevel: 6 }).toBuffer();
  const cases = [
    ['jpeg q75', 'sharp mozjpeg:true', () => sharp(ref.data, raw).jpeg({ quality: 75, mozjpeg: true }).toBuffer()],
    ['jpeg q75', 'sharp default (no mozjpeg flag)', () => sharp(ref.data, raw).jpeg({ quality: 75 }).toBuffer()],
    ['jpeg q75', 'jSquash mozjpeg (Squoosh defaults)', () => jpegEnc(imageData, { quality: 75 })],
    ['jpeg q75', '@napi-rs/image Transformer.jpeg', () => new napi.Transformer(losslessPng).jpeg(75)],
    ['webp q75', 'sharp effort 4', () => sharp(ref.data, raw).webp({ quality: 75, effort: 4 }).toBuffer()],
    ['webp q75', 'jSquash method 4 (Squoosh defaults)', () => webpEnc(imageData, { quality: 75 })],
    ['webp q75', '@napi-rs/image Transformer.webp', () => new napi.Transformer(losslessPng).webp(75)],
    ['avif q50', 'sharp effort 4 (default)', () => sharp(ref.data, raw).avif({ quality: 50, effort: 4 }).toBuffer()],
    ['avif q50', 'sharp effort 3 (aom speed 6)', () => sharp(ref.data, raw).avif({ quality: 50, effort: 3 }).toBuffer()],
    ['avif q50', 'jSquash speed 6 (Squoosh defaults)', () => avifEnc(imageData, { quality: 50, speed: 6 })],
    ['avif q50', '@napi-rs/image Transformer.avif speed 6', () => new napi.Transformer(losslessPng).avif({ quality: 50, speed: 6 })],
    ['png lossless', 'sharp compressionLevel 9, effort 10', () => sharp(ref.data, raw).png({ compressionLevel: 9, effort: 10 }).toBuffer()],
    ['png lossless', 'jSquash oxipng level 2 (Squoosh default)', () => oxipng(losslessPng, { level: 2 })],
    ['png lossless', '@napi-rs/image losslessCompressPng (oxipng)', () => napi.losslessCompressPng(losslessPng)],
    ['png palette', 'sharp palette:true colours 256 (libimagequant)', () => sharp(ref.data, raw).png({ palette: true, quality: 100, effort: 10 }).toBuffer()],
    ['png palette', '@napi-rs/image pngQuantize', () => napi.pngQuantize(losslessPng, {})],
  ];
  for (const [fmt, enc, fn] of cases) {
    try {
      const { out, ms } = await timeit(fn);
      const q = await quality(ref, out);
      rows.push({ image: name, px: `${ref.width}x${ref.height}`, fmt, enc, kb: +(out.length / 1024).toFixed(1), ms: Math.round(ms), ssim: +q.ssim.toFixed(4), psnr: +q.psnr.toFixed(2), ssimJsMs: Math.round(q.ssimMs) });
    } catch (e) {
      rows.push({ image: name, fmt, enc, error: String(e.message || e).slice(0, 120) });
    }
  }
}
console.table(rows);
fs.writeFileSync(path.join(import.meta.dirname, 'bench-results.json'), JSON.stringify(rows, null, 1));

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import avifEnc, { init as initAvifEnc } from '@jsquash/avif/encode.js';
import jpegEnc, { init as initJpegEnc } from '@jsquash/jpeg/encode.js';
import ssimMod from 'ssim.js';
const ssim = ssimMod.ssim || ssimMod.default || ssimMod;
const nm = (p) => path.join(import.meta.dirname, 'node_modules', p);
await initAvifEnc(await WebAssembly.compile(fs.readFileSync(nm('@jsquash/avif/codec/enc/avif_enc.wasm'))));
await initJpegEnc(await WebAssembly.compile(fs.readFileSync(nm('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'))));
const file = process.argv[2];
const { data, info } = await sharp(file).resize({ width: 1732 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const raw = { raw: { width: info.width, height: info.height, channels: 4 } };
const id = { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
const score = async (buf) => { const d = await sharp(buf).ensureAlpha().raw().toBuffer(); return ssim({ data: new Uint8ClampedArray(data), width: info.width, height: info.height }, { data: new Uint8ClampedArray(d), width: info.width, height: info.height }, { ssim: 'weber' }).mssim; };
console.log('AVIF sweep (size KB, weber-SSIM)');
for (const q of [30, 40, 50, 60, 70]) {
  const a = await sharp(data, raw).avif({ quality: q, effort: 4 }).toBuffer();
  const b = Buffer.from(await avifEnc(id, { quality: q, speed: 6 }));
  console.log(`q${q}  sharp e4: ${(a.length/1024).toFixed(1)}KB ${(await score(a)).toFixed(5)}  | jSquash s6: ${(b.length/1024).toFixed(1)}KB ${(await score(b)).toFixed(5)}`);
}
// Concurrency: 12 images
const N = 12;
const run = async (label, fn, parallel) => {
  const t = performance.now();
  if (parallel) await Promise.all(Array.from({ length: N }, fn)); else for (let i = 0; i < N; i++) await fn();
  console.log(label, Math.round(performance.now() - t), 'ms for', N, 'x 2MP');
};
console.log('sharp.concurrency()', sharp.concurrency(), 'UV_THREADPOOL_SIZE', process.env.UV_THREADPOOL_SIZE || '(default 4)');
await run('sharp mozjpeg serial  ', () => sharp(data, raw).jpeg({ quality: 75, mozjpeg: true }).toBuffer(), false);
await run('sharp mozjpeg parallel', () => sharp(data, raw).jpeg({ quality: 75, mozjpeg: true }).toBuffer(), true);
await run('jSquash mozjpeg parallel (main thread)', () => jpegEnc(id, { quality: 75 }), true);
await run('sharp avif e4 serial  ', () => sharp(data, raw).avif({ quality: 50, effort: 4 }).toBuffer(), false);
await run('sharp avif e4 parallel', () => sharp(data, raw).avif({ quality: 50, effort: 4 }).toBuffer(), true);
await run('jSquash avif s6 parallel (main thread)', () => avifEnc(id, { quality: 50, speed: 6 }), true);

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import jpegEnc, { init as initJpegEnc } from '@jsquash/jpeg/encode.js';
import webpEnc, { init as initWebpEnc } from '@jsquash/webp/encode.js';
import oxipng, { init as initOxi } from '@jsquash/oxipng/optimise.js';
import * as napi from '@napi-rs/image';
const nm = (p) => path.join(import.meta.dirname, 'node_modules', p);
const compile = (p) => WebAssembly.compile(fs.readFileSync(nm(p)));
await initJpegEnc(await compile('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'));
await initWebpEnc(await compile('@jsquash/webp/codec/enc/webp_enc_simd.wasm'));
await initOxi(await compile('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm'));
const h = (b) => crypto.createHash('sha1').update(Buffer.from(b)).digest('hex').slice(0, 10);
const t0 = () => performance.now();
for (const [name, file, width] of JSON.parse(process.argv[2])) {
  let p = sharp(file).rotate(); if (width) p = p.resize({ width, kernel: 'lanczos3' });
  const { data, info } = await p.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: 4 } };
  const id = { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
  const a = await sharp(data, raw).jpeg({ quality: 75, mozjpeg: true }).toBuffer();
  const b = Buffer.from(await jpegEnc(id, { quality: 75 }));
  const wa = await sharp(data, raw).webp({ quality: 75 }).toBuffer();
  const wb = Buffer.from(await webpEnc(id, { quality: 75 }));
  console.log(name, 'JPEG sharp', a.length, h(a), '| jSquash', b.length, h(b), '| WebP sharp', wa.length, h(wa), '| jSquash', wb.length, h(wb));
  // PNG lossless: sharp lossless vs oxipng (both from same pixels)
  const base = await sharp(data, raw).png({ compressionLevel: 6 }).toBuffer();
  let t = t0(); const s9 = await sharp(data, raw).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(); const s9ms = t0() - t;
  t = t0(); const ox2 = Buffer.from(await oxipng(base, { level: 2 })); const ox2ms = t0() - t;
  t = t0(); const nx = await napi.losslessCompressPng(base); const nxms = t0() - t;
  const lossless = async (buf) => { const r = await sharp(buf).ensureAlpha().raw().toBuffer(); return r.equals(data); };
  console.log(name, 'PNG lossless KB: sharp lvl9', (s9.length/1024).toFixed(0), Math.round(s9ms)+'ms', await lossless(s9), '| jSquash oxipng L2', (ox2.length/1024).toFixed(0), Math.round(ox2ms)+'ms', await lossless(ox2), '| napi oxipng', (nx.length/1024).toFixed(0), Math.round(nxms)+'ms', await lossless(nx));
  // Squoosh-like "reduce palette + oxipng" vs sharp palette
  t = t0(); const sp = await sharp(data, raw).png({ palette: true, colours: 256, dither: 1.0, effort: 7 }).toBuffer(); const spms = t0() - t;
  t = t0(); const spo = Buffer.from(await oxipng(sp, { level: 2 })); const spoms = t0() - t;
  console.log(name, 'PNG palette KB: sharp palette effort7', (sp.length/1024).toFixed(0), Math.round(spms)+'ms', '| + oxipng L2', (spo.length/1024).toFixed(0), Math.round(spoms)+'ms');
}

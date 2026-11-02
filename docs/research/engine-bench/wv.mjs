import Vips from 'wasm-vips';
import sharp from 'sharp';
import { performance } from 'node:perf_hooks';
const t0 = performance.now();
const vips = await Vips();
console.log('init ms', Math.round(performance.now() - t0), 'libvips', vips.version(), 'threads', vips.concurrency());
const sup = ['jpegsave_buffer', 'webpsave_buffer', 'heifsave_buffer', 'jxlsave_buffer', 'pngsave_buffer', 'gifsave_buffer'];
const file = process.argv[2];
const png = await sharp(file).resize({ width: 1732 }).png({ compressionLevel: 1 }).toBuffer();
const im = vips.Image.newFromBuffer(png);
for (const [name, fn] of [
  ['jpeg mozjpeg-ish q75', () => im.jpegsaveBuffer({ Q: 75, trellis_quant: true, overshoot_deringing: true, optimize_scans: true, quant_table: 3, interlace: true })],
  ['webp q75', () => im.webpsaveBuffer({ Q: 75 })],
  ['avif q50 effort4', () => im.heifsaveBuffer({ Q: 50, effort: 4, compression: 'av1' })],
  ['jxl distance 1.0 effort 7', () => im.jxlsaveBuffer({ distance: 1.0, effort: 7 })],
]) {
  try { const t = performance.now(); const b = fn(); console.log(name.padEnd(28), (b.byteLength / 1024).toFixed(1) + 'KB', Math.round(performance.now() - t) + 'ms'); }
  catch (e) { console.log(name, 'ERR', String(e.message || e).slice(0, 100)); }
}
im.delete();

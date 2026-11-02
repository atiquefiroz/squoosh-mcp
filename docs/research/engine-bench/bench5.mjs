import sharp from 'sharp';
import { performance } from 'node:perf_hooks';
import ssimMod from 'ssim.js';
const ssim = ssimMod.ssim || ssimMod;
const file = process.argv[2];
const { data, info } = await sharp(file).resize({ width: 1732 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, raw = { raw: { width: W, height: H, channels: 4 } };
const refImg = { data: new Uint8ClampedArray(data), width: W, height: H };
const score = async (b) => ssim(refImg, { data: new Uint8ClampedArray(await sharp(b).ensureAlpha().raw().toBuffer()), width: W, height: H }, { ssim: 'weber' }).mssim;
const j = await sharp(data, raw).jpeg({ quality: 75, mozjpeg: true }).toBuffer();
const jd = new Uint8ClampedArray(await sharp(j).ensureAlpha().raw().toBuffer());
for (const alg of ['fast', 'weber', 'bezkrovny', 'original']) { const t = performance.now(); const r = ssim(refImg, { data: jd, width: W, height: H }, { ssim: alg }); console.log('ssim.js', alg.padEnd(9), r.mssim.toFixed(5), Math.round(performance.now() - t), 'ms on', (W*H/1e6).toFixed(2), 'MP'); }
for (const [fmt, enc, lo0, hi0] of [['jpeg', (q) => sharp(data, raw).jpeg({ quality: q, mozjpeg: true }), 30, 95], ['webp', (q) => sharp(data, raw).webp({ quality: q, effort: 4 }), 30, 95], ['avif e4', (q) => sharp(data, raw).avif({ quality: q, effort: 4, chromaSubsampling: '4:2:0' }), 20, 90]]) {
  const target = 0.997;
  const t = performance.now(); let lo = lo0, hi = hi0, best = null, iters = 0;
  while (lo <= hi) { const q = (lo + hi) >> 1; iters++; const b = await enc(q).toBuffer(); const s = await score(b); if (s >= target) { best = { q, kb: b.length / 1024, s }; hi = q - 1; } else lo = q + 1; }
  console.log(`auto ${fmt} target weber-SSIM>=${target}: q=${best?.q} ${best?.kb.toFixed(0)}KB ssim=${best?.s.toFixed(4)} iters=${iters} total=${Math.round(performance.now() - t)}ms`);
}

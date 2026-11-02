import fs from 'node:fs'; import path from 'node:path'; import sharp from 'sharp'; import { performance } from 'node:perf_hooks';
import jxlEnc, { init } from '@jsquash/jxl/encode.js';
await init(await WebAssembly.compile(fs.readFileSync(path.join(import.meta.dirname, 'node_modules/@jsquash/jxl/codec/enc/jxl_enc.wasm'))));
const { data, info } = await sharp(process.argv[2]).resize({ width: 1732 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const id = { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
for (const q of [75, 90]) { const t = performance.now(); const b = await jxlEnc(id, { quality: q, effort: 7 }); console.log('jSquash jxl q' + q + ' effort7', (b.byteLength / 1024).toFixed(1) + 'KB', Math.round(performance.now() - t) + 'ms'); }

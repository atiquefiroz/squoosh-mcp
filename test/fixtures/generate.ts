// Generates the edge-case fixture set into test/fixtures/generated (or the folder given).
// Synthetic so the repo carries no third-party images. Run: npm run fixtures [-- <dir>]
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';

const out = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'generated'));
await fs.mkdir(out, { recursive: true });

/** Deterministic pseudo-random noise, so fixtures are identical on every machine. */
function noise(width: number, height: number, channels: number, seed = 1): Buffer {
  const buf = Buffer.alloc(width * height * channels);
  let s = seed;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = s >> 23;
  }
  return buf;
}

/** Photo-like: blurred noise texture under a lit gradient with soft shapes. */
async function photo(width: number, height: number, seed = 1): Promise<Sharp> {
  const texture = await sharp(noise(width, height, 3, seed), { raw: { width, height, channels: 3 } }).blur(1.2).toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><radialGradient id="g" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#f4c58a"/><stop offset="0.6" stop-color="#6b4a3a"/><stop offset="1" stop-color="#1d2433"/></radialGradient>
    <filter id="b"><feGaussianBlur stdDeviation="${Math.round(width / 80)}"/></filter></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <g filter="url(#b)" opacity="0.8"><circle cx="${width * 0.7}" cy="${height * 0.6}" r="${height * 0.25}" fill="#3b6e8f"/>
    <ellipse cx="${width * 0.3}" cy="${height * 0.75}" rx="${width * 0.2}" ry="${height * 0.1}" fill="#c9d6a3"/></g></svg>`;
  return sharp(Buffer.from(svg)).composite([{ input: texture, raw: { width, height, channels: 3 }, blend: 'soft-light' }]);
}

const ui = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="#f6f7f9"/>
  <rect width="100%" height="56" fill="#1f2937"/><text x="24" y="36" font-family="Helvetica, Arial" font-size="20" fill="#fff">Dashboard</text>
  <rect x="0" y="56" width="220" height="${h - 56}" fill="#ffffff" stroke="#e5e7eb"/>
  ${[0, 1, 2, 3, 4, 5].map((i) => `<text x="24" y="${100 + i * 40}" font-family="Helvetica, Arial" font-size="15" fill="#374151">Menu item ${i + 1}</text>`).join('')}
  ${[0, 1, 2].map((i) => `<rect x="${250 + i * 380}" y="90" width="350" height="140" rx="10" fill="#fff" stroke="#e5e7eb"/>
    <text x="${270 + i * 380}" y="130" font-family="Helvetica, Arial" font-size="14" fill="#6b7280">Metric ${i + 1}</text>
    <text x="${270 + i * 380}" y="185" font-family="Helvetica, Arial" font-size="36" fill="#111827">${(i + 1) * 1234}</text>`).join('')}
  ${Array.from({ length: 12 }, (_, i) => `<text x="270" y="${290 + i * 34}" font-family="Menlo, monospace" font-size="13" fill="#111827">row ${i} · value ${i * 37} · status ${i % 3 ? 'ok' : 'warn'}</text>`).join('')}
</svg>`;

const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">
  <circle cx="200" cy="200" r="150" fill="#ff5a36"/><circle cx="200" cy="200" r="90" fill="#ffd166"/>
  <text x="380" y="230" font-family="Helvetica, Arial" font-weight="bold" font-size="96" fill="#073b4c">Acme</text></svg>`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
  <rect x="8" y="8" width="112" height="112" rx="24" fill="#2563eb"/><path d="M40 64 l16 16 l32 -32" stroke="#fff" stroke-width="12" fill="none"/></svg>`;

const jobs: [string, () => Promise<unknown>][] = [
  ['photo.jpg', async () => (await photo(2000, 1333)).jpeg({ quality: 92 }).toFile(path.join(out, 'photo.jpg'))],
  ['screenshot.png', () => sharp(Buffer.from(ui(1440, 900))).png().toFile(path.join(out, 'screenshot.png'))],
  ['logo-alpha.png', () => sharp(Buffer.from(logo)).png().toFile(path.join(out, 'logo-alpha.png'))],
  ['icon.png', () => sharp(Buffer.from(icon)).png().toFile(path.join(out, 'icon.png'))],
  ['gradient.png', () =>
    sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g"><stop offset="0" stop-color="#0b1e3f"/><stop offset="1" stop-color="#f08a5d"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`))
      .png()
      .toFile(path.join(out, 'gradient.png'))],
  ['animated.gif', async () => {
    const frames = await Promise.all(['#ef4444', '#22c55e', '#3b82f6'].map((c) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><circle cx="100" cy="100" r="70" fill="${c}"/></svg>`)).png().toBuffer()));
    return sharp(frames, { join: { animated: true } }).gif({ delay: [200, 200, 200], loop: 0 }).toFile(path.join(out, 'animated.gif'));
  }],
  // Stored landscape with EXIF orientation 6: displays as portrait 600x900.
  ['rotated-exif.jpg', async () => (await photo(900, 600, 7)).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toFile(path.join(out, 'rotated-exif.jpg'))],
  ['cmyk.jpg', async () => (await photo(800, 600, 3)).toColourspace('cmyk').jpeg({ quality: 90 }).toFile(path.join(out, 'cmyk.jpg'))],
  ['deep-16bit.png', async () => (await photo(800, 600, 4)).toColourspace('rgb16').png().toFile(path.join(out, 'deep-16bit.png'))],
  ['wide-p3.png', () =>
    sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="400" height="600" fill="#ff0000"/><rect x="400" width="400" height="600" fill="#00ff00"/></svg>`))
      .withIccProfile('p3')
      .png()
      .toFile(path.join(out, 'wide-p3.png'))],
  // Wider than WebP's 16,383 px limit: WebP must be ruled out.
  ['panorama.jpg', async () => (await photo(17000, 600, 5)).jpeg({ quality: 85 }).toFile(path.join(out, 'panorama.jpg'))],
  // Same stem, two formats: outputs must not collide.
  ['dup.png', async () => (await photo(640, 480, 8)).png().toFile(path.join(out, 'dup.png'))],
  ['dup.jpg', async () => (await photo(640, 480, 9)).jpeg().toFile(path.join(out, 'dup.jpg'))],
  ['tiny.png', () => sharp(Buffer.from(icon)).resize(16, 16).png().toFile(path.join(out, 'tiny.png'))],
  ['nested/deeper/photo-small.webp', async () => {
    await fs.mkdir(path.join(out, 'nested/deeper'), { recursive: true });
    return (await photo(1200, 800, 11)).webp({ quality: 90 }).toFile(path.join(out, 'nested/deeper/photo-small.webp'));
  }],
  ['refused.svg', () => fs.writeFile(path.join(out, 'refused.svg'), icon)],
];

for (const [name, make] of jobs) {
  await make();
  console.error(`fixture ${name}`);
}
console.error(`wrote ${jobs.length} fixtures to ${out}`);

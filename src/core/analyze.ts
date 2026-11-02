import fs from 'node:fs/promises';
import sharp from 'sharp';
import { config } from '../config.js';

export type ImageClass = 'photo' | 'screenshot' | 'graphic' | 'icon' | 'animated';

export interface Header {
  format: string;
  /** Dimensions with EXIF orientation applied. */
  width: number;
  height: number;
  bytes: number;
  mtimeMs: number;
  hasAlpha: boolean;
  animated: boolean;
  /** Frame height for animations (the decoded image is frames stacked vertically). */
  pageHeight: number;
  pages: number;
  /** Wide-gamut colour profile (Display P3, Adobe RGB, Rec.2020…): kept as Display P3 on output. */
  wideGamut: boolean;
  hasGainMap: boolean;
  /** EXIF, XMP or IPTC present (may include GPS location). */
  hasMetadata: boolean;
  /** Why the file cannot be processed, if it cannot. */
  unsupported?: string;
}

export interface Features {
  alphaUsed: boolean;
  /** Distinct RGBA colours, counted up to 4,097. */
  uniqueColours: number;
  /** Share of pixels equal to their right and lower neighbours. */
  flatRatio: number;
  /** Share of neighbour pairs whose luma differs by more than 64/255. */
  hardEdgeRatio: number;
  entropy: number;
}

export interface Classification {
  cls: ImageClass;
  /** 0–1: normalised distance from the nearest decision threshold. */
  confidence: number;
  /** Chroma subsampling would blur this image's edges or flat colours. */
  needsFullChroma: boolean;
}

const COLOUR_CAP = 4097;
const FEATURE_MAX_PIXELS = 4_000_000;
/** Starting thresholds, to be tuned on a larger set of real images. */
export const THRESHOLDS = {
  paletteColours: 256,
  iconSide: 256,
  graphicFlat: 0.6,
  graphicEntropy: 4,
  screenshotFlat: 0.35,
  screenshotEdges: 0.02,
  fullChromaColours: 1024,
} as const;

const WIDE_GAMUT = /display ?p3|dci-p3|adobe ?rgb|prophoto|romm|rec\.? ?2020|bt\.? ?2020|wide ?gamut/i;

type XY = [number, number];
const triangleArea = ([x1, y1]: XY, [x2, y2]: XY, [x3, y3]: XY) => Math.abs(x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2;
/** sRGB primaries as D50-adapted ICC colorants, in xy. */
const SRGB_AREA = triangleArea([0.6484, 0.3309], [0.3212, 0.5979], [0.1559, 0.066]);

/** Gamut area (xy) from the rXYZ/gXYZ/bXYZ colorant tags of a matrix RGB profile, if present. */
function primariesArea(icc: Buffer): number | undefined {
  const count = Math.min(icc.readUInt32BE(128), 200);
  const xy: Record<string, XY> = {};
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12;
    if (at + 12 > icc.length) break;
    const sig = icc.toString('latin1', at, at + 4);
    if (sig !== 'rXYZ' && sig !== 'gXYZ' && sig !== 'bXYZ') continue;
    const offset = icc.readUInt32BE(at + 4);
    if (offset + 20 > icc.length || icc.toString('latin1', offset, offset + 4) !== 'XYZ ') continue;
    const [X, Y, Z] = [0, 1, 2].map((k) => icc.readInt32BE(offset + 8 + k * 4) / 65536) as [number, number, number];
    const sum = X + Y + Z;
    if (sum > 0) xy[sig] = [X / sum, Y / sum];
  }
  return xy.rXYZ && xy.gXYZ && xy.bXYZ ? triangleArea(xy.rXYZ, xy.gXYZ, xy.bXYZ) : undefined;
}

/**
 * Wide gamut = primaries enclosing clearly more than sRGB (Display P3 is about 1.36x, Adobe RGB 1.35x).
 * Profile names vary ("Display P3", libvips' "sP3C"), so names are only a fallback for LUT profiles.
 */
export function isWideGamutProfile(icc: Buffer | undefined): boolean {
  if (!icc || icc.length < 132) return false;
  const area = primariesArea(icc);
  if (area !== undefined) return area > SRGB_AREA * 1.1;
  const text = icc.subarray(128, Math.min(icc.length, 4096)).toString('latin1').replaceAll('\0', '');
  return WIDE_GAMUT.test(text);
}

async function isAnimatedPng(abs: string): Promise<boolean> {
  const handle = await fs.open(abs, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const chunk = head.subarray(0, bytesRead);
    const actl = chunk.indexOf('acTL');
    const idat = chunk.indexOf('IDAT');
    return actl !== -1 && (idat === -1 || actl < idat);
  } finally {
    await handle.close();
  }
}

/** Reads header facts only (no pixel decode). Fast enough for thousands of files. */
export async function readHeader(abs: string): Promise<Header> {
  const [meta, stat] = await Promise.all([sharp(abs, { limitInputPixels: false }).metadata(), fs.stat(abs)]);
  const format = meta.format === 'heif' ? (meta.compression === 'av1' ? 'avif' : 'heic') : (meta.format ?? 'unknown');
  const pages = meta.pages ?? 1;
  const pageHeight = meta.pageHeight ?? meta.height ?? 0;
  const header: Header = {
    format,
    width: meta.autoOrient?.width ?? meta.width ?? 0,
    height: pages > 1 ? pageHeight : (meta.autoOrient?.height ?? meta.height ?? 0),
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    hasAlpha: meta.hasAlpha ?? false,
    animated: pages > 1 && (format === 'gif' || format === 'webp'),
    pageHeight,
    pages,
    wideGamut: isWideGamutProfile(meta.icc),
    hasGainMap: meta.gainMap !== undefined,
    hasMetadata: Boolean(meta.exif ?? meta.xmp ?? meta.iptc),
  };
  if (format === 'heic') header.unsupported = 'HEIC is not supported yet (sharp cannot decode HEVC).';
  else if (stat.size > config.maxInputBytes) header.unsupported = `File is larger than ${config.maxInputBytes >> 20} MB.`;
  else if (header.width * header.height > config.maxInputPixels) header.unsupported = 'Image has more pixels than the 268 MP safety limit.';
  else if (format === 'png' && (await isAnimatedPng(abs))) header.unsupported = 'Animated PNG is kept as is (only its first frame could be decoded).';
  return header;
}

/** Counts distinct RGBA colours with an early exit at COLOUR_CAP. */
export function countColours(rgba: Uint8Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) {
    seen.add(((rgba[i]! << 24) | (rgba[i + 1]! << 16) | (rgba[i + 2]! << 8) | rgba[i + 3]!) >>> 0);
    if (seen.size >= COLOUR_CAP) break;
  }
  return seen.size;
}

/** Flat-area and hard-edge shares from interleaved RGBA pixels. */
export function edgeFeatures(rgba: Uint8Array, width: number, height: number): { flatRatio: number; hardEdgeRatio: number } {
  let flat = 0;
  let edges = 0;
  let pairs = 0;
  const row = width * 4;
  const luma = (i: number) => (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >> 8;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * row + x * 4;
      const r = i + 4;
      const d = i + row;
      const y0 = luma(i);
      if (Math.abs(luma(r) - y0) > 64) edges++;
      if (Math.abs(luma(d) - y0) > 64) edges++;
      pairs += 2;
      if (
        rgba[i] === rgba[r] && rgba[i + 1] === rgba[r + 1] && rgba[i + 2] === rgba[r + 2] &&
        rgba[i] === rgba[d] && rgba[i + 1] === rgba[d + 1] && rgba[i + 2] === rgba[d + 2]
      ) flat++;
    }
  }
  const cells = Math.max(1, (width - 1) * (height - 1));
  return { flatRatio: flat / cells, hardEdgeRatio: pairs ? edges / pairs : 0 };
}

/** Decodes pixels (downscaled above 4 MP) and measures the classifier features. */
export async function measure(abs: string, header: Header): Promise<Features> {
  const scale = Math.min(1, Math.sqrt(FEATURE_MAX_PIXELS / Math.max(1, header.width * header.height)));
  const width = Math.max(1, Math.round(header.width * scale));
  const base = () => sharp(abs, { autoOrient: true, limitInputPixels: config.maxInputPixels }).ensureAlpha();
  const stats = sharp(abs, { limitInputPixels: config.maxInputPixels }).stats();
  // Nearest-neighbour keeps real colours for counting; a smoothing kernel keeps real edges.
  const colourPixels = (scale < 1 ? base().resize({ width, kernel: 'nearest' }) : base()).raw().toBuffer({ resolveWithObject: true });
  const edgePixels = scale < 1 ? base().resize({ width, kernel: 'linear' }).raw().toBuffer({ resolveWithObject: true }) : colourPixels;
  const [s, colours, edgesRaw] = await Promise.all([stats, colourPixels, edgePixels]);
  return {
    alphaUsed: header.hasAlpha && !s.isOpaque,
    uniqueColours: countColours(colours.data),
    ...edgeFeatures(edgesRaw.data, edgesRaw.info.width, edgesRaw.info.height),
    entropy: s.entropy,
  };
}

const distance = (value: number, threshold: number) => Math.min(1, Math.abs(value - threshold) / threshold);

/** Pure classification from header facts and features. */
export function classify(header: Pick<Header, 'width' | 'height' | 'animated'>, f: Features): Classification {
  const t = THRESHOLDS;
  const needsFullChroma = f.hardEdgeRatio > t.screenshotEdges / 2 || f.uniqueColours < t.fullChromaColours;
  if (header.animated) return { cls: 'animated', confidence: 1, needsFullChroma };
  const confidence = Math.min(
    distance(f.uniqueColours, t.paletteColours),
    distance(f.flatRatio, t.screenshotFlat),
    distance(f.hardEdgeRatio, t.screenshotEdges),
  );
  let cls: ImageClass;
  if (Math.max(header.width, header.height) <= t.iconSide && f.uniqueColours <= t.paletteColours) cls = 'icon';
  else if (f.uniqueColours <= t.paletteColours || (f.flatRatio > t.graphicFlat && f.entropy < t.graphicEntropy)) cls = 'graphic';
  else if (f.flatRatio > t.screenshotFlat && f.hardEdgeRatio > t.screenshotEdges) cls = 'screenshot';
  else cls = 'photo';
  return { cls, confidence: Number(confidence.toFixed(2)), needsFullChroma };
}

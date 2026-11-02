import path from 'node:path';
import type { Features, ImageClass } from './analyze.js';
import { CODECS, type CodecId } from './codecs.js';
import type { DiscoveredFile } from './discover.js';
import { toPosix } from './paths.js';

export type Policy = 'auto' | 'avif' | 'keep' | 'picture';
export type TargetPreset = 'small' | 'balanced' | 'high' | 'lossless-look';
export type CropStrategy = 'attention' | 'entropy' | 'center';

export interface Settings {
  policy: Policy;
  target: TargetPreset | number;
  resize?: { maxWidth?: number | undefined; maxHeight?: number | undefined } | undefined;
  crop?: { width: number; height: number; strategy: CropStrategy } | undefined;
  widths?: number[] | 'auto' | undefined;
  /** Markup only: eager loading and fetchpriority="high" for above-the-fold images. */
  priority?: boolean | undefined;
  metadata: 'strip' | 'all';
}

export const DEFAULT_SETTINGS: Settings = { policy: 'auto', target: 'balanced', metadata: 'strip' };

/**
 * SSIMULACRA 2 targets. `balanced` is a placeholder until T1 calibrates it to the score of
 * squoosh.app's default output (decision D4); 90 is visually lossless on the metric's scale.
 */
export const TARGETS: Record<TargetPreset, number> = { small: 65, balanced: 75, high: 85, 'lossless-look': 90 };

/**
 * Presets are 10 points stricter for flat UI content. SSIMULACRA 2 was tuned on photos and
 * under-weights faint 1px lines: on a dashboard screenshot, palette q27 scored 80.7 yet dropped
 * the card borders, which return at about 85 for about 1 KB more. Numeric targets apply as given.
 */
const FLAT_CLASS_BONUS = 10;

export function targetScore(target: Settings['target'], cls?: ImageClass): number {
  if (typeof target === 'number') return target;
  const flat = cls === 'screenshot' || cls === 'graphic' || cls === 'icon';
  return Math.min(95, TARGETS[target] + (flat ? FLAT_CLASS_BONUS : 0));
}

/** Merges per-file settings over top-level settings over defaults. */
export function mergeSettings(...layers: (Partial<Settings> | undefined)[]): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

type Table = Record<Exclude<ImageClass, 'animated'>, CodecId[]>;
/** `auto` (default): WebP only, which every current browser decodes (Safari 14+, iOS 14+). */
const WEBP_ONLY: Table = {
  photo: ['webp'],
  screenshot: ['webp-lossless', 'webp-palette', 'webp'],
  graphic: ['webp-palette', 'webp-lossless', 'webp'],
  icon: ['webp-palette', 'webp-lossless', 'webp'],
};
/** `avif` and `picture`: AVIF or WebP, whichever is smaller (AVIF needs Safari 16.4+). */
const WITH_AVIF: Table = {
  photo: ['avif', 'webp'],
  screenshot: ['webp-lossless', 'webp-palette', 'avif'],
  graphic: ['webp-palette', 'webp-lossless', 'avif'],
  icon: ['webp-palette', 'webp-lossless', 'avif'],
};
const PNG_FAMILY: CodecId[] = ['png-palette', 'png-quant', 'png'];

export interface CandidateInput {
  cls: ImageClass;
  confidence: number;
  features: Pick<Features, 'alphaUsed'>;
  sourceFormat: string;
  wideGamut: boolean;
  /** Target 100: only lossless encoders (D4). */
  lossless?: boolean;
  /** Longest side of the largest output. */
  maxSide: number;
}

/**
 * Candidate codecs, one group per output format to produce (plan §4.3). `auto`, `avif` and `keep`
 * produce one group; `picture` adds a JPEG/PNG fallback group.
 */
export function candidateGroups(policy: Policy, c: CandidateInput): CodecId[][] {
  if (c.cls === 'animated') return [];
  const table = policy === 'auto' ? WEBP_ONLY : WITH_AVIF;
  const lowConfidence = c.confidence < 0.3;
  const modern = lowConfidence ? [...new Set([...table[c.cls], ...table.photo, ...table.screenshot])] : table[c.cls];
  const photoLike = c.cls === 'photo' && !c.features.alphaUsed;
  const fallback = photoLike ? ['jpeg' as const] : PNG_FAMILY;

  let groups: CodecId[][];
  if (policy === 'picture') groups = [modern, fallback];
  else if (policy === 'auto' || policy === 'avif') groups = [modern];
  else {
    switch (c.sourceFormat) {
      case 'jpeg':
        groups = [['jpeg']];
        break;
      case 'webp':
        groups = [c.cls === 'photo' ? ['webp'] : ['webp-lossless', 'webp-palette', 'webp']];
        break;
      case 'avif':
        groups = [['avif']];
        break;
      case 'tiff':
        groups = [fallback];
        break;
      default: // png, and still GIFs (written as PNG)
        groups = [PNG_FAMILY];
    }
  }

  const fitted = groups.map((group, index): CodecId[] => {
    const fits = (id: CodecId) => {
      const codec = CODECS[id];
      if (c.features.alphaUsed && !codec.alpha) return false;
      if (c.maxSide > codec.maxSide) return false;
      if (id === 'png-quant' && c.wideGamut) return false; // that quantiser drops ICC profiles
      return !c.lossless || !codec.lossy;
    };
    const usable = group.filter(fits);
    if (usable.length) return usable;
    // Lossless with no lossless member: WebP for the primary, PNG (decodes everywhere) for a fallback.
    if (c.lossless) return index === 0 && fits('webp-lossless') ? ['webp-lossless'] : ['png'];
    // Too large for AVIF and WebP (over 16,384 px): PNG keeps alpha, MozJPEG otherwise.
    return c.features.alphaUsed ? ['png'] : ['jpeg'];
  });
  // A group that can only produce formats an earlier group already produces would write the same
  // file names (picture + a panorama: both groups fall back to JPEG). Drop it.
  const formats = new Set<string>();
  return fitted.filter((group) => {
    const own = group.map((id) => CODECS[id].format);
    if (own.every((f) => formats.has(f))) return false;
    for (const f of own) formats.add(f);
    return true;
  });
}

/** Starting quality for a target, per codec (seeded from benchmarks; tuned in T1). */
export function predictQuality(id: CodecId, target: number): number {
  const t = target - 70;
  switch (id) {
    case 'jpeg':
      return 72 + 1.3 * t;
    case 'webp':
      return 72 + 1.3 * t;
    case 'avif':
      return 52 + 1.4 * t;
    default: // palette codecs: libimagequant quality
      return 70 + 1.5 * t;
  }
}

export interface Size {
  width: number;
  height: number;
  /** File-name suffix, e.g. "-640w" when several widths are produced. */
  suffix: string;
  crop?: Settings['crop'];
}

const AUTO_WIDTHS = [640, 960, 1280, 1920, 2560];

/** Output sizes, largest first. Never upscales; keeps each image's own aspect ratio. */
export function sizesFor(srcWidth: number, srcHeight: number, s: Pick<Settings, 'resize' | 'crop' | 'widths'>): Size[] {
  let baseW: number;
  let baseH: number;
  if (s.crop) {
    const scale = Math.min(1, srcWidth / s.crop.width, srcHeight / s.crop.height);
    baseW = Math.max(1, Math.round(s.crop.width * scale));
    baseH = Math.max(1, Math.round(s.crop.height * scale));
  } else {
    const scale = Math.min(1, (s.resize?.maxWidth ?? Infinity) / srcWidth, (s.resize?.maxHeight ?? Infinity) / srcHeight);
    baseW = Math.max(1, Math.round(srcWidth * scale));
    baseH = Math.max(1, Math.round(srcHeight * scale));
  }

  let widths: number[];
  if (s.widths === 'auto') {
    widths = [baseW];
    for (const w of [...AUTO_WIDTHS].reverse()) {
      if (w < widths.at(-1)! / 1.15) widths.push(w);
    }
  } else if (Array.isArray(s.widths) && s.widths.length) {
    widths = [...new Set(s.widths.map((w) => Math.min(w, baseW)))].sort((a, b) => b - a);
  } else {
    widths = [baseW];
  }

  const multiple = widths.length > 1;
  return widths.map((width) => ({
    width,
    height: Math.max(1, Math.round((baseH * width) / baseW)),
    suffix: multiple ? `-${width}w` : '',
    ...(s.crop ? { crop: s.crop } : {}),
  }));
}

export interface OutputTarget {
  outDir: string;
  /** Output path relative to outDir, without extension (POSIX). */
  stem: string;
}

/**
 * Assigns every source an output folder and a collision-free stem before any encoding starts.
 * Stems are compared NFC-normalised and lower-cased (APFS and NTFS are case-insensitive);
 * clashes such as photo.jpg + photo.png resolve deterministically in sorted order.
 */
export function assignOutputs(files: readonly DiscoveredFile[], outputDir: string | undefined): Map<string, OutputTarget> {
  const roots = new Set(files.map((f) => f.root));
  const taken = new Set<string>();
  const result = new Map<string, OutputTarget>();
  for (const file of [...files].sort((a, b) => (a.abs < b.abs ? -1 : 1))) {
    const outDir = outputDir ?? path.join(file.root, 'optimized');
    const prefix = outputDir && roots.size > 1 ? `${path.basename(file.root)}/` : '';
    const ext = path.extname(file.rel);
    const base = prefix + file.rel.slice(0, file.rel.length - ext.length);
    let stem = base;
    for (let n = 1; ; n++) {
      const key = `${outDir}|${stem.normalize('NFC').toLowerCase()}`;
      if (!taken.has(key)) {
        taken.add(key);
        break;
      }
      stem = n === 1 ? `${base}-${ext.slice(1).toLowerCase()}` : `${base}-${ext.slice(1).toLowerCase()}-${n}`;
    }
    result.set(file.abs, { outDir, stem: toPosix(stem) });
  }
  return result;
}

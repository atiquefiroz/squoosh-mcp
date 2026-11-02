import sharp, { type Sharp } from 'sharp';

export type CodecId = 'avif' | 'webp' | 'webp-lossless' | 'webp-palette' | 'jpeg' | 'png' | 'png-palette' | 'png-quant';
export type Chroma = '4:2:0' | '4:4:4';

export interface Codec {
  id: CodecId;
  format: 'avif' | 'webp' | 'jpeg' | 'png';
  ext: string;
  mime: string;
  /** Lossy codecs are searched over `range`; lossless ones are encoded once. */
  lossy: boolean;
  range: readonly [number, number];
  alpha: boolean;
  maxSide: number;
}

const codec = (id: CodecId, format: Codec['format'], lossy: boolean, range: readonly [number, number], alpha: boolean, maxSide: number): Codec => ({
  id,
  format,
  ext: format === 'jpeg' ? '.jpg' : `.${format}`,
  mime: `image/${format}`,
  lossy,
  range,
  alpha,
  maxSide,
});

/** Per-side limits: WebP 16,383; AVIF 16,384 (sharp's HEIF writer check); JPEG 65,535. */
export const CODECS: Record<CodecId, Codec> = {
  avif: codec('avif', 'avif', true, [20, 99], true, 16_384),
  webp: codec('webp', 'webp', true, [30, 100], true, 16_383),
  'webp-lossless': codec('webp-lossless', 'webp', false, [100, 100], true, 16_383),
  // Palette codecs are searched over libimagequant's quality (fewest colours that reach it).
  'webp-palette': codec('webp-palette', 'webp', true, [10, 100], true, 16_383),
  jpeg: codec('jpeg', 'jpeg', true, [30, 98], false, 65_535),
  png: codec('png', 'png', false, [100, 100], true, Number.MAX_SAFE_INTEGER),
  'png-palette': codec('png-palette', 'png', true, [10, 100], true, Number.MAX_SAFE_INTEGER),
  'png-quant': codec('png-quant', 'png', true, [10, 100], true, Number.MAX_SAFE_INTEGER),
};

/** Decoded, resized pixels for one output size: 8-bit, 3 or 4 interleaved channels. */
export interface Frame {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
  /** Output is tagged Display P3 (wide-gamut source). */
  wide: boolean;
  /**
   * Re-runs the source pipeline for encoders that must not start from raw pixels
   * (wide gamut keeps its profile; `metadata: "all"` keeps EXIF/XMP).
   */
  source?: () => Sharp;
}

export interface EncodeOptions {
  quality: number;
  /** The final encode of a winner may use a slower, better effort than the search. */
  final?: boolean;
  chroma?: Chroma;
  dither?: number;
}

type NapiImage = typeof import('@napi-rs/image');
let napi: Promise<NapiImage | null> | undefined;
/** @napi-rs/image provides OxiPNG 10 and a second quantiser; absent on a few platforms, so optional. */
function napiImage(): Promise<NapiImage | null> {
  napi ??= import('@napi-rs/image').then((m) => ((m as { default?: NapiImage }).default ?? m) as NapiImage).catch(() => null);
  return napi;
}

export async function oxipngAvailable(): Promise<boolean> {
  return (await napiImage()) !== null;
}

function pipeline(frame: Frame): Sharp {
  if (frame.source) return frame.source();
  return sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: frame.channels } });
}

async function oxipng(png: Buffer): Promise<Buffer> {
  const lib = await napiImage();
  if (!lib) return sharp(png).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const out = await lib.losslessCompressPng(png);
  return out.length < png.length ? out : png;
}

function palettePng(frame: Frame, quality: number, dither: number): Promise<Buffer> {
  return pipeline(frame).png({ palette: true, quality: Math.round(quality), dither, effort: 7 }).toBuffer();
}

/** Encodes one frame with Squoosh-equivalent settings. */
export async function encode(frame: Frame, id: CodecId, o: EncodeOptions): Promise<Buffer> {
  const quality = Math.round(o.quality);
  switch (id) {
    case 'avif':
      // sharp effort = 9 − aom speed: search at 3 (Squoosh's speed 6), final encode at 4.
      return pipeline(frame)
        .avif({ quality, effort: o.final ? 4 : 3, chromaSubsampling: o.chroma ?? '4:2:0', tune: 'iq', bitdepth: 8 })
        .toBuffer();
    case 'webp':
      return pipeline(frame).webp({ quality, effort: 4, smartSubsample: o.chroma === '4:4:4' }).toBuffer();
    case 'webp-lossless':
      return pipeline(frame).webp({ lossless: true, effort: 4 }).toBuffer();
    case 'webp-palette': {
      const png = await palettePng(frame, quality, o.dither ?? 1);
      const s = sharp(png);
      return (frame.wide ? s.keepIccProfile() : s).webp({ lossless: true, effort: 4 }).toBuffer();
    }
    case 'jpeg':
      // mozjpeg: trellis, overshoot deringing, optimised scans, quant table 3, progressive.
      return pipeline(frame).jpeg({ quality, mozjpeg: true, chromaSubsampling: o.chroma ?? '4:2:0' }).toBuffer();
    case 'png':
      return oxipng(await pipeline(frame).png({ compressionLevel: 1 }).toBuffer());
    case 'png-palette': {
      const png = await palettePng(frame, quality, o.dither ?? 1);
      return o.final ? oxipng(png) : png;
    }
    case 'png-quant': {
      const lib = await napiImage();
      if (!lib) return encode(frame, 'png-palette', o);
      const input = await pipeline(frame).png({ compressionLevel: 0 }).toBuffer();
      return lib.pngQuantize(input, { minQuality: 0, maxQuality: quality, speed: o.final ? 3 : 5 });
    }
  }
}

/** Decodes an encoded candidate to pixels comparable with its frame. */
export async function decodeLike(frame: Frame, encoded: Buffer): Promise<Buffer> {
  let s = sharp(encoded, { limitInputPixels: false });
  s = frame.wide ? s.keepIccProfile() : s.toColourspace('srgb');
  s = frame.channels === 4 ? s.ensureAlpha() : s.removeAlpha();
  return s.raw().toBuffer();
}

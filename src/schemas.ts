import * as z from 'zod/v4';

const target = z
  .union([z.enum(['small', 'balanced', 'high', 'lossless-look']), z.number().min(30).max(100)])
  .describe(
    'Visual-quality target (SSIMULACRA 2). Presets for photos: small=65, balanced=75 (default), high=85, lossless-look=90; ' +
      'screenshots, graphics and icons get +10 (faint UI lines need it). Or an exact number 30–100 for every image.',
  );

/** Settings accepted at the top level of optimize_images and per file in `files[]`. */
export const settingsShape = {
  policy: z
    .enum(['auto', 'avif', 'keep', 'picture'])
    .optional()
    .describe(
      'auto (default): WebP (lossy, lossless or palette, whichever is smallest at the target); works in every current browser. ' +
        'avif: AVIF or WebP, whichever is smaller (often 20–30% smaller photos; AVIF needs Safari 16.4+). ' +
        'keep: same format as the source. picture: AVIF/WebP plus a JPEG/PNG fallback for <picture>.',
    ),
  target: target.optional(),
  resize: z
    .object({
      maxWidth: z.number().int().positive().optional(),
      maxHeight: z.number().int().positive().optional(),
    })
    .optional()
    .describe('Fit inside this box, keeping the aspect ratio. Never upscales.'),
  crop: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      strategy: z.enum(['attention', 'entropy', 'center']).default('attention'),
    })
    .optional()
    .describe('Exact output shape (e.g. 400x400 thumbnails). attention keeps faces/salient areas; entropy keeps the busiest area.'),
  widths: z
    .union([z.literal('auto'), z.array(z.number().int().min(16).max(16_384)).min(1).max(12)])
    .optional()
    .describe('Responsive widths for srcset. "auto" = 640/960/1280/1920/2560 up to the image\'s own width. Files get a -<w>w suffix.'),
  priority: z.boolean().optional().describe('Markup only: above-the-fold image (loading="eager", fetchpriority="high").'),
  metadata: z.enum(['strip', 'all']).optional().describe('strip (default): remove EXIF/GPS/XMP after auto-rotating. all: keep metadata.'),
};

const responseFormat = z.enum(['concise', 'detailed']).default('concise').describe('detailed adds per-output scores, qualities and HTML markup.');
const offset = z.number().int().min(0).default(0);

export const analyzeInput = z.object({
  paths: z.array(z.string()).min(1).describe('Files, folders or globs (e.g. "site/public/**/*.png") inside the allowed directories.'),
  recursive: z.boolean().default(true),
  deep: z.boolean().default(false).describe('Decode and classify each image (photo/screenshot/graphic/icon/animated) and show the plan. Slower; at most 50 per call.'),
  offset,
  limit: z.number().int().min(1).max(200).default(50),
  ...settingsShape,
});

export const optimizeInput = z.object({
  paths: z.array(z.string()).optional().describe('Files, folders or globs to optimise with the top-level settings.'),
  files: z
    .array(z.object({ path: z.string(), ...settingsShape }))
    .optional()
    .describe('Per-file settings that override the top-level ones, e.g. [{ path: "hero.jpg", resize: { maxWidth: 1920 }, priority: true }].'),
  ...settingsShape,
  outputDir: z.string().optional().describe('Default: an "optimized" folder inside each input folder, mirroring its structure.'),
  urlBase: z.string().optional().describe('URL prefix for generated markup, e.g. "/images/optimized".'),
  dryRun: z.boolean().default(false).describe('Return the per-image plan (class, candidates, sizes, output paths) without encoding anything.'),
  response_format: responseFormat,
  offset: offset.describe('First item of the page to return (use nextOffset from the previous result).'),
  limit: z.number().int().min(1).max(200).default(20).describe('Items per page in the result.'),
});

export const getJobInput = z.object({
  jobId: z.string(),
  waitSeconds: z.number().min(0).max(45).default(40).describe('Wait up to this long for the job to finish before answering.'),
  offset,
  limit: z.number().int().min(1).max(200).default(20),
  response_format: responseFormat,
});

export const cancelJobInput = z.object({ jobId: z.string() });

export const compareInput = z.object({
  original: z.string().describe('The source image.'),
  candidate: z.string().describe('The optimised image. If its size differs, the original is resized to match before scoring.'),
  preview: z.boolean().default(false).describe('Also return both images as small thumbnails.'),
});

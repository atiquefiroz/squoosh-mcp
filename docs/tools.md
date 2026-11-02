# squoosh-mcp tool reference

This is the reference for the 5 MCP tools, for people integrating squoosh-mcp with an agent or client. The input contracts come from [schemas.ts](../src/schemas.ts) and the output shapes from [server.ts](../src/server.ts) and [engine.ts](../src/core/engine.ts). How the server works inside is in [architecture.md](architecture.md).

## Contents

- [Basics](#basics)
- [Shared settings](#shared-settings)
- [analyze_images](#analyze_images)
- [optimize_images](#optimize_images)
- [get_job](#get_job)
- [cancel_job](#cancel_job)
- [compare_images](#compare_images)
- [Long jobs](#long-jobs)
- [Output folder](#output-folder)
- [squoosh-manifest.json](#squoosh-manifestjson)
- [Examples](#examples)
- [Errors](#errors)

## Basics

| Tool | What it does | Writes files |
|---|---|---|
| [`analyze_images`](#analyze_images) | Lists images and their facts; with `deep`, their class and the plan | No |
| [`optimize_images`](#optimize_images) | Optimises images into new files; returns results or a `jobId` | Yes, into an output folder |
| [`get_job`](#get_job) | Waits for and pages through a job's results | No |
| [`cancel_job`](#cancel_job) | Stops a job | No |
| [`compare_images`](#compare_images) | SSIMULACRA 2 score of an output against its original | No |

**Typical workflow:** `analyze_images` with `deep: true` on a sample → `optimize_images` (with per-file settings in `files[]` where needed) → `get_job` while the status is `running` → `compare_images` to spot-check.

**Paths.** The server only reads and writes inside the folders it was started with (command-line arguments, or Claude Code's `CLAUDE_PROJECT_DIR`). The allowed folders are listed in the server instructions and in the descriptions of `analyze_images` and `optimize_images`. A path can be absolute, or relative to the first allowed folder. Paths in results are absolute.

**Results.** Every tool returns its result as JSON text and, identically, as `structuredContent`. Errors come back as tool results with `isError: true` and a message that says how to fix the call. See [Errors](#errors).

**Quality score.** SSIMULACRA 2 rates how close an image looks to its original, on a 0–100 scale.

| Score | Band (as returned by `compare_images`) |
|---|---|
| 90 and above | `visually-lossless` |
| 85–90 | `excellent` |
| 80–85 | `very-high` |
| 70–80 | `high` |
| 50–70 | `medium` |
| below 50 | `low` |

## Shared settings

These settings are accepted at the top level of `optimize_images`, in each `files[]` entry of `optimize_images`, and by `analyze_images` (where they shape the plan that `deep` shows). A per-file value overrides the top-level one, which overrides the default.

| Name | Type | Default | Limits | What it does |
|---|---|---|---|---|
| `policy` | `"auto"` \| `"avif"` \| `"keep"` \| `"picture"` | `"auto"` | | Which output formats to consider. See below |
| `target` | `"small"` \| `"balanced"` \| `"high"` \| `"lossless-look"` \| number | `"balanced"` | number 30–100 | The visual-quality score each output must reach. See below |
| `resize` | `{ maxWidth?: int, maxHeight?: int }` | none | positive integers | Fit inside this box, keeping the aspect ratio. Never upscales |
| `crop` | `{ width: int, height: int, strategy?: "attention" \| "entropy" \| "center" }` | none; `strategy` defaults to `"attention"` | positive integers | Exact output shape. `attention` keeps faces and salient areas; `entropy` keeps the busiest area. A box larger than the source is shrunk to fit, keeping its shape |
| `widths` | `"auto"` \| int[] | one size | 1–12 widths, each 16–16,384 | Responsive sizes for `srcset`. See below |
| `priority` | boolean | `false` | | Markup only: `loading="eager" fetchpriority="high"` for an above-the-fold image |
| `metadata` | `"strip"` \| `"all"` | `"strip"` | | `strip` removes EXIF, GPS and XMP after auto-rotating. `all` keeps them |

### `policy`

| Value | Output per size | Browser support |
|---|---|---|
| `auto` (default) | WebP: lossy, lossless or palette, whichever is smallest at the target | Every current browser (Safari 14+, iOS 14+) |
| `avif` | AVIF or WebP, whichever is smaller | AVIF needs Safari 16.4+ |
| `keep` | The source's format: JPEG → JPEG (MozJPEG), PNG or still GIF → PNG, WebP → WebP, AVIF → AVIF, TIFF → JPEG (or PNG if it has transparency or is not a photo) | Same as the source |
| `picture` | Two files: AVIF or WebP (whichever is smaller), plus a JPEG fallback (opaque photos) or PNG fallback (everything else). The markup is a `<picture>` | Everywhere, through the fallback |

- Which encoders are tried depends on the image's class. For example, under `auto` a photo tries lossy WebP, and a screenshot tries lossless, palette and lossy WebP. [architecture.md](architecture.md#how-one-image-is-decided) has the full table.
- On 12 real 1792 × 2400 photos at `balanced`, `avif` was about 33% smaller than `auto` (3.37 MB against 5.04 MB) and took about 86% longer (26.6 s against 14.3 s). See [architecture.md § Performance](architecture.md#performance).
- **Very large images.** WebP allows at most 16,383 px per side and AVIF 16,384 px. An image larger than every candidate allows is written as JPEG (MozJPEG), or as PNG if it uses transparency.
- **Animated** GIF and WebP always become animated WebP at quality 75, with no search. Under `keep`, an animated GIF stays a GIF.

### `target`

| Value | Photos | Screenshots, graphics, icons |
|---|---|---|
| `"small"` | 65 | 75 |
| `"balanced"` (default) | 75 | 85 |
| `"high"` | 85 | 95 |
| `"lossless-look"` | 90 | 95 |
| a number, 30–99 | as given | as given |
| `100` | lossless encoders only | lossless encoders only |

- Presets are 10 points stricter (capped at 95) for screenshots, graphics and icons. The metric was tuned on photos and under-weights faint 1 px lines; on a dashboard screenshot, faint card borders vanished at a score of about 81 and came back at about 85.
- `balanced` = 75 is a starting value. It will be calibrated against squoosh.app's default output during testing (T1).
- With `100`, only lossless WebP and lossless PNG (OxiPNG) are candidates. `auto` and `avif` write lossless WebP. `keep` writes PNG for PNG and still GIF sources, and lossless WebP for JPEG, WebP and AVIF sources, which have no lossless option of their own here. `picture` adds a lossless PNG fallback.

### `widths`

- `"auto"`: the image's own width (after `resize` or `crop`), then 2560, 1920, 1280, 960 and 640 px in turn, each kept only if it is more than 15% narrower than the last width kept. For example, a 3000 px photo with `resize: { maxWidth: 2560 }` gets 2560, 1920, 1280, 960 and 640.
- A list: each width is capped at the image's own width; duplicates are dropped.
- With more than one width, file names get a `-<width>w` suffix (`hero-1280w.webp`) and the markup gets a `srcset`.
- Heights follow the image's aspect ratio (or the `crop` box's). Animated images ignore `widths` and `crop`.

## analyze_images

Scans files, folders or globs and reports what is there. With `deep: true` it also decodes each image, classifies it and shows the plan `optimize_images` would follow. It never writes anything.

### Input

| Name | Type | Default | Limits | Notes |
|---|---|---|---|---|
| `paths` | string[] | required | at least 1 | Files, folders or globs, e.g. `"site/public/**/*.png"` |
| `recursive` | boolean | `true` | | Applies to folders. A glob follows its own pattern |
| `deep` | boolean | `false` | | Classify and plan each image. Slower |
| `offset` | integer | `0` | ≥ 0 | First item of the page |
| `limit` | integer | `50` | 1–200; at most 50 when `deep` | Items per page |
| shared settings | | | | `policy`, `target`, `resize`, `crop`, `widths`, `priority`, `metadata` shape the `deep` plan |

### Output

```json
{
  "summary": {
    "files": 2,
    "totalBytes": 393905,
    "byFormat": { "jpg": { "files": 1, "bytes": 390573 }, "png": { "files": 1, "bytes": 3332 } },
    "skipped": [{ "path": "/Users/me/site/logo.svg", "reason": "SVG is vector; it is left as is (SVG optimisation is planned for a later version)." }],
    "truncated": false
  },
  "items": [ /* one per file on this page */ ],
  "nextOffset": 50
}
```

- `summary` covers every file found, not just this page. `byFormat` is keyed by file extension (`jpeg` counts as `jpg`, `tiff` as `tif`).
- `nextOffset` is present only when there are more items.

Each item:

| Field | When | Meaning |
|---|---|---|
| `path` | always | Absolute path |
| `format` | always | `jpeg`, `png`, `webp`, `avif`, `gif`, `tiff` (or `heic`) |
| `width`, `height` | always | After EXIF orientation. For animations, one frame's size |
| `bytes` | always | File size |
| `hasAlpha` | always | The file has an alpha channel (it may still be fully opaque; see `alphaUsed`) |
| `animated`, `frames` | animations | `true` and the frame count |
| `wideGamut` | wide-gamut profile | `"kept as Display P3"` |
| `hdrGainMap` | HDR gain map | `"present; dropped on conversion in v1"` |
| `unsupported` | cannot be processed | The reason (HEIC, over 256 MB, over 268 MP, animated PNG) |
| `class` | `deep` | `photo`, `screenshot`, `graphic`, `icon` or `animated` |
| `confidence` | `deep` | 0–1. Below 0.3, more candidates are tried |
| `alphaUsed` | `deep` | Some pixel is not fully opaque |
| `colours` | `deep` | Distinct colours, or `"4096+"` |
| `plan.target` | `deep` | The score this image must reach |
| `plan.candidates` | `deep` | Encoders to try, one list per output format, e.g. `[["webp"]]` |
| `plan.chroma` | `deep` | `"4:4:4"` for sharp edges and few colours, else `"4:2:0"` |
| `plan.sizes` | `deep` | Output sizes, largest first, e.g. `["1200x800", "960x640"]` |
| `plan.output` | `deep` | Output path without the extension |
| `error` | the file could not be read | The message; the item then has only `path` and `error` |

For an animated image, `deep` returns `class: "animated"` and `plan: { "output": "<path>.webp (animated, q75)" }`.

### Annotations

`readOnlyHint: true`, `openWorldHint: false`.

### Typical errors

| Message starts with | What to do |
|---|---|
| `Path is outside the allowed directories` | Use a path inside an allowed folder (they are listed in the tool description) |
| `Path not found` | Check the path; relative paths start from the first allowed folder |
| `… is a squoosh-mcp output folder` | Point at the source folder, not at `optimized/` |
| `Input validation error` | Fix the argument named in the message (e.g. `limit` over 200) |

## optimize_images

Optimises images into new files. For each image it decides size, format and the lowest quality that still meets the target. Originals are never modified. It works for up to 45 seconds, then hands back a `jobId` if it is not finished ([Long jobs](#long-jobs)).

### Input

| Name | Type | Default | Limits | Notes |
|---|---|---|---|---|
| `paths` | string[] | none | | Files, folders or globs. Folders are always scanned recursively |
| `files` | `{ path: string, …shared settings }[]` | none | | Per-file settings that override the top level. `path` can be a file, a folder (top level only) or a glob. A file also matched by `paths` keeps its output location and just takes these settings |
| shared settings | | | | `policy`, `target`, `resize`, `crop`, `widths`, `priority`, `metadata` ([Shared settings](#shared-settings)) |
| `outputDir` | string | `<input folder>/optimized` | inside an allowed folder | One folder for all outputs. With several input folders, each gets a subfolder named after it |
| `urlBase` | string | none | | URL prefix for the markup, e.g. `"/images/optimized"`. Without it, markup uses paths relative to the output folder |
| `dryRun` | boolean | `false` | | Return the plan only. Nothing is encoded or written |
| `response_format` | `"concise"` \| `"detailed"` | `"concise"` | | `detailed` adds per-output quality and score, class, decision, markup and time |
| `offset` | integer | `0` | ≥ 0 | First item of the page. With `dryRun`, pass `nextOffset` here for the next page of plans |
| `limit` | integer | `20` | 1–200; at most 50 with `dryRun` | Items in the result. Use `get_job` with `offset` for more of a running or finished job |

- Give `paths`, `files`, or both.
- The whole argument object may hold at most 20,000 array elements and object members. A call may discover at most 10,000 files.

### Output: the job view

`optimize_images` and `get_job` return the same shape.

```json
{
  "jobId": "cc7b87f9",
  "status": "completed",
  "done": 2,
  "total": 2,
  "bytesBefore": 393905,
  "bytesAfter": 157988,
  "savedPct": 59.9,
  "counts": { "optimized": 2 },
  "manifests": ["/Users/me/site/img/optimized/squoosh-manifest.json"],
  "items": [
    {
      "source": "/Users/me/site/img/hero.jpg",
      "status": "optimized",
      "bytes": "390573 → 157456 (-59.7%)",
      "outputs": [
        "/Users/me/site/img/optimized/hero-1200w.webp (1200x800, 157456 B, score 76.31)",
        "/Users/me/site/img/optimized/hero-960w.webp (960x640, 129502 B, score 75.47)",
        "/Users/me/site/img/optimized/hero-640w.webp (640x427, 95150 B, score 76.43)"
      ]
    },
    {
      "source": "/Users/me/site/img/logo.png",
      "status": "optimized",
      "bytes": "3332 → 532 (-84%)",
      "outputs": ["/Users/me/site/img/optimized/logo.webp (400x200, 532 B, score 90.77)"]
    }
  ],
  "next": "Done. Each output folder has squoosh-manifest.json with every output and its <picture>/<img> markup; use response_format \"detailed\" to see markup here."
}
```

| Field | When | Meaning |
|---|---|---|
| `attachedToExistingJob` | `optimize_images` only | `true` when an identical call was already running and this call joined it |
| `jobId` | always | Pass to `get_job` or `cancel_job` |
| `status` | always | `queued`, `running`, `completed`, `cancelled` or `failed` |
| `done`, `total` | always | Images finished and images in the job. `total` is 0 while queued |
| `current` | while running | One image in progress, relative to its input folder |
| `bytesBefore`, `bytesAfter`, `savedPct` | always | Totals over images that were optimised, kept or unchanged. `bytesAfter` counts each image's main output only (largest size, first format), not every file written |
| `counts` | always | Images per item status |
| `skippedFiles` | if any | Up to 10 `{ path, reason }` for files refused during discovery (SVG, HEIC, BMP, ICO) |
| `truncated` | if any | Discovery stopped at the file limit; run again on subfolders |
| `error` | job failed | Why the whole job failed |
| `manifests` | when the job ends | Path of each output folder's `squoosh-manifest.json` |
| `items` | always | One page, sorted by source path |
| `nextOffset` | more items | Pass as `offset` to `get_job` |
| `next` | always | What to do next |

**Item status:**

| `status` | Meaning |
|---|---|
| `optimized` | New files were written |
| `kept` | No re-encode was smaller than the source, so the source was copied unchanged into the output folder (with its metadata) |
| `unchanged` | Skipped: same source, same settings and same tool version as the last run, and its outputs still exist |
| `skipped` | Not processed; `reason` says why |
| `failed` | Something went wrong for this image only; `error` says what. Other images are not affected |

**Item fields:**

| Field | `concise` | `detailed` |
|---|---|---|
| `source` | yes | yes |
| `status` | yes | yes |
| `bytes` | `"before → after (-pct%)"` for `optimized`, `kept`, `unchanged` | same |
| `outputs` | strings: `"<file> (WxH, N B, score S)"` | objects: `{ file, format, width, height, bytes, quality, score, original? }`. `quality` is absent for lossless outputs; `original: true` marks a copied source |
| `targetNotMet` | `true` if some output missed the target (the best attempt was used) | same |
| `error` | on failure | same |
| `reason` | for `skipped` and `failed` | (use `decision` and `error`) |
| `class` | | `photo`, `screenshot`, `graphic`, `icon` or `animated` |
| `decision` | | Per size: codec, quality and score, e.g. `"1200px: webp q80 → 76.3"`; also notes such as "original kept" or "Time budget reached" |
| `markup` | | The `<img>` or `<picture>` HTML for this image |
| `ms` | | Time spent on this image |

**`dryRun` output** is different: the plan per file, from the same code a real run uses.

```json
{
  "dryRun": true,
  "files": 2,
  "outputFolders": ["/Users/me/site/img/optimized"],
  "skipped": [],
  "truncated": false,
  "items": [ /* same fields as analyze_images items with deep: true */ ],
  "nextOffset": 50
}
```

### Annotations

| Hint | Value | Why it is honest |
|---|---|---|
| `readOnlyHint` | `false` | It writes new files |
| `destructiveHint` | `false` | It never writes originals, and it only overwrites files its own manifest says it created |
| `idempotentHint` | `true` | An identical call while the job runs returns that job. After it finishes, a repeat finds every file `unchanged` |
| `openWorldHint` | `false` | Local files only |

### Typical errors

| Message starts with | What to do |
|---|---|
| ``Pass `paths` (files, folders or globs) and/or `files` `` | Give at least one of them |
| `No supported images found (JPEG, PNG, WebP, AVIF, GIF, TIFF).` | Check the paths; the message lists skipped files and why |
| `Job <id> is already writing to …` | Another job uses the same output folder. Wait with `get_job`, or stop it with `cancel_job` |
| `Too many queued jobs.` | 2 jobs run and 8 wait at most. Wait for one to finish |
| `Path is outside the allowed directories` / `Path not found` | See [Errors](#errors) |
| Job `error`: `… is locked by another squoosh-mcp process (pid N)` | Another server process is writing there. Wait, or use another `outputDir` |
| Item `error`: `… already exists and was not created by squoosh-mcp` | A file of that name is in the way. Move it, or choose another `outputDir` |
| Item `error`: `… is already the output of <other source>` | Two sources map to one output name, for example `photo.jpg` with `widths` and a source named `photo-640w.png`. Rename one of them |
| Item `error`: `Cancelled before this image finished.` | The job was cancelled. Run again to finish |
| Item `targetNotMet: true` | The best attempt missed the target, usually because the time budget ran out or the codec range ended. Accept it, lower the target, or try `target: 100` |

## get_job

Waits for a job and returns its progress and results, one page at a time.

### Input

| Name | Type | Default | Limits | Notes |
|---|---|---|---|---|
| `jobId` | string | required | | From `optimize_images` |
| `waitSeconds` | number | `40` | 0–45 | Returns as soon as the job ends, or after this long. `0` returns at once |
| `offset` | integer | `0` | ≥ 0 | First item of the page |
| `limit` | integer | `20` | 1–200 | Items per page |
| `response_format` | `"concise"` \| `"detailed"` | `"concise"` | | As for `optimize_images` |

### Output

The [job view](#output-the-job-view), without `attachedToExistingJob`.

### Annotations

`readOnlyHint: true`, `openWorldHint: false`.

### Typical errors

| Message starts with | What to do |
|---|---|
| `Unknown or expired jobId` | Jobs are kept in memory for an hour after they finish, and are lost when the server restarts. Run `optimize_images` again; finished files are skipped as `unchanged` |

## cancel_job

Stops a job. Images already written stay, and are recorded in the manifest so a re-run skips them.

### Input

| Name | Type | Default | Notes |
|---|---|---|---|
| `jobId` | string | required | From `optimize_images` |

### Output

```json
{ "jobId": "cc7b87f9", "status": "cancelled", "done": 7, "total": 40 }
```

- A queued job is cancelled at once. A running job stops admitting images, and images in progress stop at their next checkpoint.
- The call waits up to 10 seconds for the job to stop. If `status` is still `running`, call `get_job` to wait for the end.
- Cancelling a job that has already finished changes nothing and returns its final status.

### Annotations

`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. `destructiveHint` is set explicitly, because the MCP default for a non-read-only tool is `true`.

### Typical errors

| Message starts with | What to do |
|---|---|
| `Unknown or expired jobId` | Nothing to cancel |

## compare_images

Scores how close an optimised image looks to its original with SSIMULACRA 2, and reports both files' sizes. Use it to spot-check results.

### Input

| Name | Type | Default | Notes |
|---|---|---|---|
| `original` | string | required | The source image |
| `candidate` | string | required | The optimised image. If its dimensions differ, the original is resized to match before scoring |
| `preview` | boolean | `false` | Also return both images as JPEG thumbnails of at most 512 px |

### Output

```json
{
  "score": 76.43,
  "band": "high",
  "original": { "path": "/Users/me/site/img/hero.jpg", "format": "jpeg", "width": 1200, "height": 800, "bytes": 390573 },
  "candidate": { "path": "/Users/me/site/img/optimized/hero-640w.webp", "format": "webp", "width": 640, "height": 427, "bytes": 95150 },
  "note": "Sizes differ: the original was resized to the candidate size before scoring."
}
```

- `score` has 2 decimals; `band` follows the [score table](#basics). `note` appears only when the sizes differ.
- With `preview: true`, two `image` content blocks (`image/jpeg`, original first) follow the JSON text.
- Both images are converted to 8-bit sRGB. If either has an alpha channel, both are compared with alpha.
- Images over 2.3 MP are scored the same way `optimize_images` scores them: the lower score of two 1024 × 1024 tiles (the centre and the most detailed area). That is slightly stricter than a whole-image score.
- For wide-gamut sources the score can differ slightly from the one in the job result, because `optimize_images` scores in Display P3 and `compare_images` in sRGB.

### Annotations

`readOnlyHint: true`, `openWorldHint: false`.

### Typical errors

| Message starts with | What to do |
|---|---|
| `Path is outside the allowed directories` / `Path not found` | See [Errors](#errors) |
| `Error: …` from the decoder | One of the files cannot be decoded (for example HEIC) |

## Long jobs

`optimize_images` never blocks for longer than the inline window (45 s by default, set by `SQUOOSH_MCP_INLINE_SECONDS`).

```
agent                                   squoosh-mcp
  │  optimize_images { paths } ───────────►│  starts the job, works up to 45 s
  │◄──── status "running", jobId, done/total
  │  get_job { jobId, waitSeconds: 40 } ──►│  returns when the job ends, or after 40 s
  │◄──── status "running", done/total
  │  get_job { jobId, waitSeconds: 40 } ──►│
  │◄──── status "completed", first page of items, nextOffset
  │  get_job { jobId, offset: 20 } ───────►│  next page
```

1. Call `optimize_images`. If the job finishes within the window, the result is final.
2. Otherwise `status` is `running` (or `queued`) and `next` says to call `get_job`. Keep calling `get_job` with the `jobId` while `status` is `queued` or `running`.
3. **Progress:** if the client sends a `progressToken`, the server sends `notifications/progress` while `optimize_images` or `get_job` waits, at most 4 times a second, with `progress` (images done), `total` and a message naming the image in progress.
4. **Timeouts and retries:** if the client gives up during the window, the job keeps running. Repeating the identical call joins the running job (`attachedToExistingJob: true`) instead of starting another.
5. **Paging:** items are sorted by source path. Use `offset` and `nextOffset` with `get_job`.
6. **Lifetime:** job results stay in memory for an hour after the job ends and are lost if the server restarts. The manifest on disk is the durable record, and a re-run skips finished files.
7. **Limits:** at most 2 jobs run at once, and up to 8 more wait in order. Images from all jobs share one pool (by default `min(4, cores / 2)` at once, set by `SQUOOSH_MCP_CONCURRENCY`).

## Output folder

By default, each input folder gets an `optimized/` folder that mirrors its structure:

```
site/img/                           ← input folder (the folder given, a file's own folder, or a glob's fixed base)
├── hero.jpg
├── logo.png
├── blog/
│   └── cover.jpg
└── optimized/                      ← created by squoosh-mcp
    ├── squoosh-manifest.json       ← every output and its markup (written when the job ends)
    ├── hero-1200w.webp             ← several widths: -<width>w suffix
    ├── hero-960w.webp
    ├── hero-640w.webp
    ├── logo.webp
    └── blog/
        ├── cover.avif              ← policy "picture": modern format…
        └── cover.jpg               ← …plus the fallback
```

- **While a job runs** the folder also holds `.squoosh.lock` (blocks a second server process) and `.squoosh-journal.jsonl` (one line per finished image; folded into the manifest at the end). Temporary `*.tmp-*` files appear only during a write.
- **Output folders are recognised by their manifest or journal,** not by name, and are never scanned as input. Your own folder called `optimized` with no manifest is treated as normal input.
- **Name clashes** are resolved before encoding, case-insensitively: if `photo.jpg` and `photo.png` share a folder, the first (in sorted order) gets `photo.*` and the second `photo-png.*`.
- **`outputDir`** puts every output under one folder. With several input folders, each gets a subfolder named after it.
- **Only our files are overwritten.** A file in the output folder that the manifest does not list is never replaced; that image fails with a message instead.
- Deleting the `optimized/` folder is safe. The next run redoes everything.

## squoosh-manifest.json

One manifest per output folder. It lists every source processed into that folder, with all its outputs and its markup.

```json
{
  "generator": "squoosh-mcp",
  "version": 1,
  "entries": [
    {
      "source": "../logo.png",
      "sourceBytes": 3332,
      "sourceMtimeMs": 1793614706978.779,
      "sourceHash": "3e2e03ef68489020123d4e91b73fabb773cc8268c4fe1a5cf3f081a5ee1d7896",
      "key": "f659148c97a701f9",
      "class": "graphic",
      "outputs": [
        { "path": "logo.webp", "format": "webp", "width": 400, "height": 200, "bytes": 532, "quality": 21, "score": 90.77 }
      ],
      "markup": "<img src=\"/img/optimized/logo.webp\" width=\"400\" height=\"200\" alt=\"\" loading=\"lazy\" decoding=\"async\">",
      "note": "400px: webp-palette q21 → 90.8",
      "updatedAt": "2026-11-02T10:18:27.919Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `source` | Source path relative to the output folder, with `/` separators |
| `sourceBytes`, `sourceMtimeMs`, `sourceHash` | Size, modification time and sha256 of the source when it was processed. Used to skip unchanged files |
| `key` | Hash of the effective settings and the tool and codec versions. A different key redoes the file |
| `class` | The image class |
| `outputs[]` | `path` (relative to the output folder), `format`, `width`, `height`, `bytes`, `quality` (lossy only), `score`, and `original: true` for a copied source |
| `markup` | Ready-to-paste HTML. `alt` is always empty: fill it in |
| `note` | The decision, as in `decision` in the job result |
| `updatedAt` | When the entry was written |

**Markup rules:**
- One output format: an `<img>`. Several formats (`picture`): a `<picture>` with one `<source type srcset>` per modern format, then the `<img>` with the fallback.
- Several widths: a `srcset` with `w` descriptors and `sizes="100vw"`. There is no option for `sizes` yet; edit it if the image is not full width.
- The `<img>` always has `width`, `height` (so the page does not jump), `alt=""` and `decoding="async"`, plus `loading="lazy"`, or `loading="eager" fetchpriority="high"` with `priority`.
- URLs are relative to the output folder, or start with `urlBase`.

## Examples

The examples assume the server was started with `/Users/me/site` as its allowed folder, so relative paths start there. Responses are trimmed; the numbers are illustrative.

### 1. Optimise a folder

```json
{ "name": "optimize_images", "arguments": { "paths": ["public/images"] } }
```

Every image in `public/images` and its subfolders becomes WebP in `public/images/optimized/`, at the `balanced` target. If it takes more than 45 s:

```json
{
  "jobId": "4f1c2a9e",
  "status": "running",
  "done": 31,
  "total": 120,
  "current": "products/mug.png",
  "bytesBefore": 48211904,
  "bytesAfter": 3120554,
  "savedPct": 93.5,
  "counts": { "optimized": 30, "kept": 1 },
  "items": [ /* 20 items */ ],
  "nextOffset": 20,
  "next": "Still working. Call get_job with jobId \"4f1c2a9e\" to wait for the rest."
}
```

### 2. A hero image with responsive widths and `priority`

```json
{
  "name": "optimize_images",
  "arguments": {
    "paths": ["public/images"],
    "files": [
      { "path": "public/images/hero.jpg", "resize": { "maxWidth": 2560 }, "widths": "auto", "priority": true }
    ],
    "urlBase": "/images/optimized",
    "response_format": "detailed"
  }
}
```

For a 3000 × 2000 `hero.jpg`, the item's `markup` is:

```html
<img src="/images/optimized/hero-2560w.webp" srcset="/images/optimized/hero-2560w.webp 2560w, /images/optimized/hero-1920w.webp 1920w, /images/optimized/hero-1280w.webp 1280w, /images/optimized/hero-960w.webp 960w, /images/optimized/hero-640w.webp 640w" sizes="100vw" width="2560" height="1707" alt="" loading="eager" fetchpriority="high" decoding="async">
```

The other images in the folder use the top-level settings (one size, lazy loading).

### 3. `<picture>` with a fallback

```json
{
  "name": "optimize_images",
  "arguments": { "paths": ["public/blog"], "policy": "picture", "urlBase": "/blog/optimized", "response_format": "detailed" }
}
```

For an opaque photo `cover.jpg` (1600 × 900), where AVIF came out smaller than WebP:

```html
<picture>
  <source type="image/avif" srcset="/blog/optimized/cover.avif">
  <img src="/blog/optimized/cover.jpg" width="1600" height="900" alt="" loading="lazy" decoding="async">
</picture>
```

A transparent logo gets a PNG fallback instead of JPEG.

### 4. Lossless

```json
{ "name": "optimize_images", "arguments": { "paths": ["public/icons"], "target": 100 } }
```

Only lossless encoders are tried: lossless WebP here. With `"policy": "keep"`, PNG sources are written as lossless PNG through OxiPNG. If the lossless result is not smaller than the source, the source is copied and the item's status is `kept`. Pixels are processed at 8 bits per channel, so a 16-bit PNG may not come out bit-exact. With `policy: "picture"`, the `<source>` is lossless WebP and the `<img>` fallback is lossless PNG.

### 5. Preview the plan with `dryRun`

```json
{ "name": "optimize_images", "arguments": { "paths": ["public/images"], "policy": "avif", "dryRun": true } }
```

```json
{
  "dryRun": true,
  "files": 2,
  "outputFolders": ["/Users/me/site/public/images/optimized"],
  "skipped": [],
  "truncated": false,
  "items": [
    {
      "path": "/Users/me/site/public/images/hero.jpg",
      "format": "jpeg", "width": 1200, "height": 800, "bytes": 390573, "hasAlpha": false,
      "class": "photo", "confidence": 1, "alphaUsed": false, "colours": "4096+",
      "plan": { "target": 75, "candidates": [["avif", "webp"]], "chroma": "4:2:0", "sizes": ["1200x800"], "output": "/Users/me/site/public/images/optimized/hero" }
    },
    {
      "path": "/Users/me/site/public/images/logo.png",
      "format": "png", "width": 400, "height": 200, "bytes": 3332, "hasAlpha": true,
      "class": "graphic", "confidence": 0.3, "alphaUsed": true, "colours": 180,
      "plan": { "target": 85, "candidates": [["webp-palette", "webp-lossless", "avif"]], "chroma": "4:4:4", "sizes": ["400x200"], "output": "/Users/me/site/public/images/optimized/logo" }
    }
  ]
}
```

Nothing is encoded or written. `analyze_images` with `deep: true` gives the same per-file plan without needing an `optimize_images` call.

### 6. Check a result with `compare_images`

```json
{
  "name": "compare_images",
  "arguments": { "original": "public/images/hero.jpg", "candidate": "public/images/optimized/hero-640w.webp", "preview": true }
}
```

The result is the JSON shown under [compare_images](#compare_images), followed by two JPEG thumbnails (original, then candidate). For an output of the same size or a downscale, the score should match the one in the job result, because both use the same resize and scorer. A score is not a substitute for looking: check text and fine lines in the thumbnails or at 100%.

## Errors

Every error comes back as a normal tool result with `isError: true`, so the agent can read it and retry.

| Message starts with | Cause | What to do |
|---|---|---|
| `No allowed directories are configured.` | The server was started without folders, and `CLAUDE_PROJECT_DIR` was missing, the home folder or a filesystem root | Restart the server with folder paths as arguments, e.g. `npx -y squoosh-mcp /absolute/path/to/images` |
| `Path is outside the allowed directories: … Allowed: …` | The path, a symlink target or `outputDir` is outside the sandbox | Use a path inside one of the listed folders |
| `Path not found: …` | The file or folder does not exist | Check the path; relative paths start from the first allowed folder |
| `Path contains a null byte.` | | Fix the path |
| `Input validation error: Invalid arguments for tool …` | The arguments do not match the schema | Fix the field named in the message |
| `Invalid arguments for tool …: arguments contain more than the maximum of 20000 elements` | The call is too large | Split it, or use folders or globs instead of long lists |
| `Error: …` | An unexpected failure, such as a decoder error | Read the message. If it repeats, report it |

Errors about a single image (for example a corrupt file) do not fail the call. They appear as that item's `error`, and the rest of the batch continues.

**Server settings** that change these limits (environment variables): `SQUOOSH_MCP_INLINE_SECONDS` (45), `SQUOOSH_MCP_CONCURRENCY` (`min(4, cores / 2)`), `SQUOOSH_MCP_PIXEL_BUDGET_MP` (64), `SQUOOSH_MCP_MAX_FILES` (10,000), `SQUOOSH_MCP_MAX_INPUT_MB` (256).

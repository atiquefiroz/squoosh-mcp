# squoosh-mcp: architecture

This doc is for contributors. It records what was actually built (version 0.1.0) and how the parts fit together. The design intent and decisions D1–D21 are in [plan.md](plan.md). Where this doc and the plan disagree, this doc follows the code; [Differences from the plan](#differences-from-the-plan) lists each case. The tool contracts for integrators are in [tools.md](tools.md).

## Contents

- [In one paragraph](#in-one-paragraph)
- [Request flow](#request-flow)
- [Modules](#modules)
- [How one image is decided](#how-one-image-is-decided)
- [Concurrency and memory](#concurrency-and-memory)
- [Crash safety and idempotency](#crash-safety-and-idempotency)
- [Safety model](#safety-model)
- [Performance](#performance)
- [Differences from the plan](#differences-from-the-plan)
- [Known limits and next steps](#known-limits-and-next-steps)
- [Tests](#tests)

## In one paragraph

An MCP client starts the server over stdio with one or more allowed folders. The agent calls `optimize_images` on files, folders or globs. For each image the server reads its header, measures a few pixel features, and classifies it as photo, screenshot, graphic, icon or animated. It then picks the output sizes and a short list of candidate encoders. For each candidate it searches for the lowest quality whose SSIMULACRA 2 score still meets the target, and keeps the smallest file. Encoding is native, through sharp (libvips with MozJPEG, libwebp, libaom and libimagequant) and OxiPNG from `@napi-rs/image`. Scoring runs as WebAssembly in worker threads. New files go to an `optimized/` folder next to the sources, with a journal while the job runs and a `squoosh-manifest.json` at the end.

## Request flow

```
MCP client (agent)
   │  stdio (serveStdio)
   ▼
index.ts ── CLI folders, or CLAUDE_PROJECT_DIR ──► Sandbox (paths.ts)
   │
   ▼
server.ts: 5 tools, zod input schemas (schemas.ts), guard() turns throws into isError results
   ├─ analyze_images ─► Engine.analyze ─► discover ─► readHeader (+ measure, classify, plan if deep)
   ├─ compare_images ─► Engine.compare ─► MetricPool.score
   ├─ get_job, cancel_job ─► JobStore
   └─ optimize_images
        │
        ▼
Engine.prepare: discover(paths) + discover(files[]) ─► mergeSettings ─► assignOutputs ─► sandbox.writable(outDirs)
        │        (dryRun stops here: Engine.describe per file, nothing is written)
        ▼
Engine.optimize: job key = sha256(request + engineKey) ─► JobStore.start (attach, refuse or queue)
        │
        ▼
Engine.run (at most 2 jobs running): OutputStore.open per output folder (lock, clean temp files, replay journal)
        │  for each file, in order:
        │     PixelPool.acquire(width × frame height)   ◄── slots + 64 MP budget, first come first served
        ▼
pipeline.processImage (never throws; failures come back as items with status "failed")
   ├─ readHeader ─► unsupported? ─► skipped
   ├─ unchanged? (settings key + size + mtime or sha256 + outputs exist) ─► unchanged
   ├─ animated ─► one animated WebP at q75 (GIF for keep) ─► keep the original if not smaller
   └─ still image:
        measure ─► classify ─► sizesFor + candidateGroups + targetScore
        for each size, largest first:
           makeFrame (orient, crop or resize in linear light, colour, alpha)
           MetricPool.open(frame) ─► MetricSession (reference cached in one worker)
           for each candidate group:
              largest size:  chooseCodec ─► SizeSearch.search ─► finalize
              smaller sizes: search the largest size's winner from its quality (≤ 4 encodes) ─► finalize
              keep-original guard
           session.close()
        check every output name ─► OutputStore.write / copy (temp file + rename) ─► OutputStore.record (journal line)
        │
        ▼
OutputStore.close at job end: journal ─► squoosh-manifest.json, delete journal, release lock
```

## Modules

Links are relative to this folder.

| File | Responsibility |
|---|---|
| [src/index.ts](../src/index.ts) | Binary entry: flags, sharp setup, sandbox, `serveStdio` |
| [src/config.ts](../src/config.ts) | Runtime limits and their environment variables |
| [src/schemas.ts](../src/schemas.ts) | zod input schemas for the 5 tools |
| [src/server.ts](../src/server.ts) | Tool registration, annotations, result shaping, progress |
| [src/core/engine.ts](../src/core/engine.ts) | Shared state; prepare, optimize, run, analyze, dryRun, compare |
| [src/core/jobs.ts](../src/core/jobs.ts) | `PixelPool`, `Job`, `JobStore` |
| [src/core/paths.ts](../src/core/paths.ts) | `Sandbox`, `UserError` |
| [src/core/discover.ts](../src/core/discover.ts) | Files, folders and globs to image files |
| [src/core/analyze.ts](../src/core/analyze.ts) | Header facts, pixel features, classifier, wide-gamut check |
| [src/core/planner.ts](../src/core/planner.ts) | Settings, targets, candidate codecs, sizes, output names |
| [src/core/codecs.ts](../src/core/codecs.ts) | Codec table, encoders, decode for scoring |
| [src/core/search.ts](../src/core/search.ts) | Quality search |
| [src/core/pipeline.ts](../src/core/pipeline.ts) | One image end to end |
| [src/core/metric.ts](../src/core/metric.ts) | Tiling, `MetricSession`, `MetricPool` |
| [src/core/metric-worker.ts](../src/core/metric-worker.ts) | Worker thread that runs the WASM |
| [src/core/output.ts](../src/core/output.ts) | `OutputStore` (lock, journal, manifest) and markup |
| [wasm/ssim2/src/lib.rs](../wasm/ssim2/src/lib.rs) | SSIMULACRA 2 as plain C-ABI WASM exports |

### index.ts

- Parses `--help` and `--version`. Every other argument is an allowed folder.
- Turns off libvips' operation cache (`sharp.cache(false)`): a batch touches each file once, so the cache only costs memory.
- Sets libvips threads per image to `floor(cores / slots)`.
- Builds the `Sandbox`, one `Engine`, and serves `createServer(engine)` over stdio. Logs go to stderr only.

### config.ts

| Setting | Default | Environment variable |
|---|---|---|
| `inlineSeconds` | 45 | `SQUOOSH_MCP_INLINE_SECONDS` (0 allowed) |
| `slots` (images at once) | `min(4, floor(cores / 2))`, at least 1 | `SQUOOSH_MCP_CONCURRENCY` |
| `vipsThreads` | `floor(cores / slots)` | (derived) |
| `pixelBudget` | 64 MP | `SQUOOSH_MCP_PIXEL_BUDGET_MP` |
| `maxFiles` per call | 10,000 | `SQUOOSH_MCP_MAX_FILES` |
| `maxInputBytes` | 256 MB | `SQUOOSH_MCP_MAX_INPUT_MB` |
| `maxInputPixels` | 268,402,689 (sharp's default) | fixed |
| `maxToolInputElements` | 20,000 | fixed |
| `maxRunningJobs` / `maxQueuedJobs` | 2 / 8 | fixed |
| `jobTtlMs` | 1 hour | fixed |
| `maxGlobDepth` | 32 | fixed |
| Per-image time budget | 60 s + 2 s per MP of the largest output | fixed |

An invalid or too-small environment value falls back to the default.

### schemas.ts and server.ts

- **Schemas** are zod 4 objects. `settingsShape` (policy, target, resize, crop, widths, priority, metadata) is shared by `analyze_images`, the top level of `optimize_images`, and each `files[]` entry. There are no output schemas; results are returned as JSON text plus the same object in `structuredContent`.
- **Validation** is done by the SDK before the handler runs. A failure comes back as a tool result with `isError: true` and the text `Input validation error: …`. The SDK also enforces `maxToolInputElements`.
- **`guard()`** wraps every handler. A `UserError` becomes an `isError` result with its message as written. Any other error is prefixed with `Error: `.
- **`jobView()`** builds the job result: totals, counts by status, one page of items sorted by source path, and a `next` hint. `item()` gives each image a one-line form (`concise`) or a full form (`detailed`).
- **`waitWithProgress()`** waits on a job and, if the client sent a `progressToken`, sends `notifications/progress` at most every 250 ms.
- **Allowed folders** are written into the server instructions and the `analyze_images` and `optimize_images` descriptions at startup.

### engine.ts

`Engine` holds everything the tools share. There is one per process.

| Member | What it does |
|---|---|
| `jobs: JobStore` | All jobs in this process |
| `metric: MetricPool` | SSIMULACRA 2 workers, `slots` of them at most |
| `pool: PixelPool` | Admission control for images in flight, shared by all jobs |
| `engineKey()` | `sha256(package version, sharp.versions, OxiPNG available)`, first 12 hex characters. Part of every "unchanged" key, so an upgrade of the tool or of any codec redoes files (D15) |
| `prepare(req)` | Discovers files, merges settings (defaults, then top level, then per file), assigns output names, checks every output folder against the sandbox |
| `optimize(req)` | `prepare`, then refuses an empty result, then starts or attaches to a job |
| `run(job, …)` | Opens one `OutputStore` per output folder, admits images one at a time through the `PixelPool`, and closes the stores (writing the manifests) in a `finally` |
| `analyze()` | Header facts for every file and totals by extension; with `deep`, a page of classifications and plans |
| `dryRun()` | `prepare`, then the plan for a page of files. Nothing is encoded or written |
| `describe()` | The per-file plan used by `analyze` (deep) and `dryRun`. It calls the same `measure`, `classify`, `sizesFor`, `candidateGroups` and `targetScore` as the pipeline, so a dry run shows what a real run would try |
| `compare()` | Decodes both files to 8-bit sRGB, resizes the original to the candidate's size if they differ (lanczos3, linear light), and scores them |

Invariants:
- Validation errors (bad paths, overlapping jobs, no images) are thrown before a job exists, so the agent gets them as a tool error.
- `processImage` never throws, so one bad image never stops a job.

### jobs.ts

**`PixelPool`** limits images in flight by `slots` and by total source pixels.
- An image is admitted when a slot is free and its pixels fit the budget. An image larger than the whole budget is admitted only when nothing else is running, so it runs alone.
- Waiters are served first come, first served. `acquire` never jumps the queue.
- **Invariant:** the slot and pixels are reserved *before* a waiter is woken. An earlier version woke every waiter on a release, so concurrency was unbounded; `test/jobs.test.ts` guards against that regression.
- A waiter is rejected when its job's `AbortSignal` fires, and the pool keeps serving the others.

**`Job`** holds status (`queued`, `running`, `completed`, `cancelled`, `failed`), counters, the current file, results, skipped files, manifest paths and an `AbortController`. `wait(ms)` resolves when the job ends or the time runs out. `onChange` feeds progress notifications.

**`JobStore`** is the process-wide registry.
- A call identical to an active job (same key) returns that job (`attached: true`). A client that times out and retries attaches instead of starting duplicate work.
- A job whose output folders overlap an active job's is refused with a message.
- At most 2 jobs run at once. Others queue in order, up to 8 queued; more are refused.
- Finished jobs are pruned an hour after they finish. Jobs live in memory only and are lost when the server stops.
- `cancel` finishes a queued job at once and aborts a running one.

### paths.ts

**`Sandbox`** is the allow-list of folders. It follows the official filesystem server's path validation.
- `create(dirs)`: each folder must exist and be a directory; it is stored as its real path. A folder inside an earlier allowed folder is dropped as redundant.
- `fromStartup(args, CLAUDE_PROJECT_DIR)`: CLI folders win. With none, `CLAUDE_PROJECT_DIR` is used unless it resolves to the home folder or a filesystem root. Otherwise the sandbox is empty, and every path call is refused with a message that explains how to restart the server.
- `absolute(p)`: relative paths resolve against the first allowed folder. Null bytes are refused.
- `existing(p)`: `realpath`, then containment.
- `writable(p)`: for an output that may not exist yet, finds the deepest existing ancestor, takes its real path, adds the rest back, then checks containment.
- `contains(real)`: containment with a trailing separator, so `/a/bc` is not inside `/a/b`.

**`UserError`** marks an error whose message tells the agent how to fix the call.

### discover.ts

`discover(sandbox, entries, recursive)` turns files, folders and globs into `DiscoveredFile { abs, root, rel }`.
- **Root:** a folder entry is its own root; a file's root is its own folder; a glob's root is its fixed base folder (the part before the first `*?[]{}`). Outputs mirror paths relative to the root.
- **Accepted:** `.jpg .jpeg .png .webp .avif .gif .tif .tiff`.
- **Refused with a reason** (returned in `skipped`): `.heic .heif .svg .bmp .ico`. Other extensions are ignored silently.
- **Skipped:** names starting with `.`, `node_modules`, temp files (`*.tmp-<hex>`), and any folder holding `squoosh-manifest.json` or `.squoosh-journal.jsonl` (our output folders, recognised by marker, not by name). Pointing straight at an output folder is an error.
- **Symlinks** are followed only when their target is inside the sandbox. Glob matches are resolved with `realpath` and checked the same way.
- **Limits:** depth 32 and `maxFiles` files; past that, discovery stops and sets `truncated`.
- Globs use Node's built-in `fs.glob` (D21). Backslashes in globs count as separators.
- Results are sorted by absolute path, so runs are deterministic.

### analyze.ts

- **`readHeader(abs)`** reads metadata only, with no pixel decode: format (`heif` is reported as `avif` or `heic`), width and height after EXIF orientation (frame height for animations), bytes, mtime, alpha channel, frame count, wide gamut, HDR gain map, and whether EXIF, XMP or IPTC is present. It sets `unsupported` for HEIC, files over 256 MB, images over 268 MP (per frame), and animated PNG (only its first frame would decode, so it is left as is).
- **Wide gamut** is decided from the ICC profile's `rXYZ`/`gXYZ`/`bXYZ` primaries: a gamut triangle more than 1.1× the area of sRGB's counts as wide (Display P3 is about 1.36×). libvips names its P3 profile `sP3C`, so name matching alone missed it. Profile names are only a fallback for LUT-based profiles without primaries.
- **`measure(abs, header)`** decodes once more at up to 4 MP and returns `Features`:

| Feature | How |
|---|---|
| `alphaUsed` | The image has alpha and `stats().isOpaque` is false |
| `uniqueColours` | Distinct RGBA values, counted up to 4,097, on a nearest-neighbour downscale (keeps real colours) |
| `flatRatio` | Share of pixels equal to their right and lower neighbours, on a linear downscale |
| `hardEdgeRatio` | Share of neighbour pairs whose luma differs by more than 64/255 |
| `entropy` | `stats().entropy` |

- **`classify(header, features)`** applies the plan's rules, first match wins: `animated` (more than one frame, GIF or WebP); `icon` (longest side ≤ 256 and ≤ 256 colours); `graphic` (≤ 256 colours, or flat > 0.6 and entropy < 4); `screenshot` (flat > 0.35 and hard edges > 0.02); otherwise `photo`.
  - `confidence` is the smallest normalised distance to the colour, flat and edge thresholds, capped at 1.
  - `needsFullChroma` is true when hard edges > 0.01 or there are fewer than 1,024 colours, whatever the class. It turns on 4:4:4 for AVIF and JPEG, and `smartSubsample` for lossy WebP.
- The thresholds in `THRESHOLDS` are starting values; T1 tunes them.

### planner.ts

Pure functions with no I/O. They are shared by the pipeline, `analyze` (deep) and `dryRun`.

- **`Settings`** and `mergeSettings(...layers)`: defaults (`policy: auto`, `target: balanced`, `metadata: strip`), then the top level, then the per-file entry. `undefined` never overrides.
- **`targetScore(target, class)`**: presets are `small` 65, `balanced` 75, `high` 85, `lossless-look` 90. Screenshots, graphics and icons get +10, capped at 95. A number is used exactly as given. `balanced` is a placeholder until T1 calibrates it against squoosh.app (D4).
- **`candidateGroups(policy, …)`**: one list of codecs per output format to produce. See [How one image is decided](#how-one-image-is-decided).
- **`predictQuality(codec, target)`**: the starting quality for the search, a straight line per codec seeded from the benchmarks.
- **`sizesFor(w, h, settings)`**: output sizes, largest first.
  - The base size fits inside `resize` (never upscaling), or is the `crop` box (shrunk to fit the source, keeping its shape).
  - `widths: "auto"` keeps the base width, then adds 2560, 1920, 1280, 960 and 640 in turn when each is more than 15% narrower than the last width kept.
  - An explicit `widths` list is clamped to the base width, de-duplicated and sorted.
  - Each size keeps the base aspect ratio. File names get a `-<width>w` suffix only when there are several sizes.
- **`assignOutputs(files, outputDir)`**: every source gets an output folder and a unique stem before any encoding starts.
  - The default folder is `<root>/optimized`. With `outputDir` and several roots, each root's files go under a subfolder named after the root.
  - Stems are compared NFC-normalised and lower-cased, because APFS and NTFS are case-insensitive.
  - A clash gets the source extension added (`photo.jpg` keeps `photo`, `photo.png` becomes `photo-png`), then a counter. Files are processed in sorted order, so the result is deterministic.

### codecs.ts

| Codec id | Output | Searched | Quality range | Alpha | Max side | Settings |
|---|---|---|---|---|---|---|
| `webp` | WebP | yes | 30–100 | yes | 16,383 | `effort: 4`; `smartSubsample` when 4:4:4 is needed |
| `webp-lossless` | WebP | no | n/a | yes | 16,383 | `lossless: true, effort: 4` |
| `webp-palette` | WebP | yes (libimagequant quality) | 10–100 | yes | 16,383 | sharp palette PNG (`effort: 7`, dither 1; finalising also tries dither 0), then lossless WebP. Keeps the ICC profile for wide gamut |
| `avif` | AVIF | yes | 20–99 | yes | 16,384 | `effort: 3` while searching, `4` when finalising; `tune: 'iq'`; 8-bit; 4:2:0 or 4:4:4 |
| `jpeg` | JPEG | yes | 30–98 | no | 65,535 | `mozjpeg: true` (trellis, deringing, optimised scans, quant table 3, progressive); 4:2:0 or 4:4:4 |
| `png` | PNG | no | n/a | yes | none | `compressionLevel: 1`, then OxiPNG |
| `png-palette` | PNG | yes | 10–100 | yes | none | sharp palette PNG (`effort: 7`, dither 1; finalising also tries dither 0); OxiPNG on the final encode only |
| `png-quant` | PNG | yes | 10–100 | yes | none | `@napi-rs/image` `pngQuantize` (`speed` 5, or 3 when finalising). Not used for wide-gamut images, because it drops the ICC profile |

- **`Frame`** is the decoded, resized source for one output size: 8-bit, 3 or 4 interleaved channels. For wide-gamut sources, and for `metadata: "all"`, it also carries `source()`, which re-runs the sharp pipeline so the encoder keeps the ICC profile or the metadata. Other encodes start from the raw pixels.
- **OxiPNG** comes from the optional `@napi-rs/image`. If that module fails to load, `png` falls back to sharp's own zlib at level 9 with adaptive filtering, and `png-quant` falls back to `png-palette`. OxiPNG output is used only when it is smaller.
- **`decodeLike(frame, buf)`** decodes a candidate back to raw pixels with the frame's channel count and colour space, ready to score.
- **Trap:** in sharp, setting `quality`, `effort`, `colours` or `dither` on `png()` turns palette mode on. Lossless `png` sets none of them.

### search.ts

`searchQuality(evaluate, options)` finds the lowest quality that meets the target in few encodes.
1. Encode at `q0`, clamped to the codec's range.
2. Then, until `maxEvals` (6 by default) or `shouldStop()`:
   - With a passing and a failing point: stop if they are 2 or fewer steps apart; otherwise interpolate (secant) between them, or bisect if the slope is not positive or the point was already tried.
   - With only passing points: jump down by half the remaining range (at least 4 steps). Stop at the bottom of the range.
   - With only failing points: jump up the same way. Stop at the top.
3. The bracket is recomputed from every measured point, so a non-monotonic curve cannot trap the search.

`pick(points, target)` returns the smallest file that meets the target, or the highest score if none does (with `met: false`).

### pipeline.ts

`processImage(task, deps)` optimises one source end to end. See [How one image is decided](#how-one-image-is-decided) for the decisions. Its internal parts:
- **`settingsKey(settings, engineKey)`**: sha256 of the effective settings without `priority`, the engine key and `PIPELINE_REVISION`, which is bumped whenever decision rules change what the same settings produce (2: `auto` became WebP only). Stored per source in the manifest. On an unchanged image the markup is rebuilt from the stored outputs and their `group` index, so a new `urlBase` or `priority` takes effect without re-encoding.
- **`sourcePipeline` / `makeFrame`**: auto-orient; crop (`cover` with `attention`, `entropy` or centre) or resize (`fill`, lanczos3); `.gamma()` when resizing, which is sharp's equivalent of Squoosh's linear-light resize; keep metadata if asked; convert to Display P3 (wide gamut) or sRGB; add or drop alpha by `alphaUsed`.
- **`SizeSearch`**: encodes and scores candidates for one output size. It memoises every `(codec, quality, final, dither)` result, so a probe that the search repeats costs nothing. `final` counts only for AVIF, png-palette and png-quant, the encoders that do more work on the final pass; for the rest, the "final" encode is the searched one.
- **`chooseCodec`**: picks the codec for one candidate group at the largest size. The probe quality from `predictQuality` is clamped to the codec's range.
- **`finalize`**: re-encodes the winner at final settings and re-checks it.
- **Write phase**: after every encode for the image has succeeded, it checks all output names (no two the same, case-insensitively, and none that would replace a file we did not create), writes them, and records one journal entry.

### metric.ts and metric-worker.ts

- **`MetricPool`** compiles `ssim2.wasm` once (from `dist/core/ssim2.wasm`, or `wasm/ssim2.wasm` when running from source) and starts up to `slots` workers lazily. Workers are `unref`'d so they never keep the process alive.
- **`MetricSession`** caches one reference image in one worker. `score(candidate)` compares a same-sized candidate against it. `close()` frees the reference and reads back the worker's WASM memory size.
- **Worker choice:** an idle worker (no open session) first, then a new worker if the pool is not full, then the least loaded one. In practice each worker holds one open session, so its WASM memory is one reference plus scratch.
- **Recycling:** WASM memory never shrinks. A worker that is idle and has grown past 512 MB is terminated and replaced on demand.
- **Crashes:** a WASM trap makes the worker exit; its pending requests are rejected, and the pool replaces it on the next `open`.
- **Tiling** (`pickTiles`): an image up to 2.3 MP is scored whole. Above that it is scored on two full-resolution tiles of up to 1024 × 1024: the centre tile, plus the most detailed tile of an overlapping grid (detail = mean horizontal luma change, sampled every 4th pixel). The image's score is the lower of the two.
- **Transfer:** sharp's buffers are external memory and cannot be transferred to a worker, so each tile is copied into a fresh `ArrayBuffer` and transferred without a second copy.
- **`band(score)`**: `visually-lossless` ≥ 90, `excellent` ≥ 85, `very-high` ≥ 80, `high` ≥ 70, `medium` ≥ 50, else `low`.

### wasm/ssim2

- A Rust `cdylib` wrapping [`fast-ssim2`](https://crates.io/crates/fast-ssim2) pinned at `=0.9.1` with default features off. It is built for `wasm32-unknown-unknown` with `+simd128`, LTO, one codegen unit, `panic = "abort"` and symbols stripped.
- Exports are plain C ABI with no JS glue and no imports: `alloc`, `dealloc`, `ref_new`, `ref_compare` and `ref_free`. Pixels are 8-bit sRGB (`RGB8_SRGB` or `RGBA8_SRGB`, straight alpha). Errors return −1e9, which the worker turns into an exception.
- `ref_compare` scores the whole image it is given. The comment in `lib.rs` notes that fast-ssim2's strip mode measured about 2.5× slower in WASM, so large images are tiled on the JS side instead.
- [`wasm/build.sh`](../wasm/build.sh) rebuilds `wasm/ssim2.wasm` (about 190 KB). It needs `rustup` with the `wasm32-unknown-unknown` target. The built file is committed (D20), so contributors without Rust can build the package; `npm run build` copies it to `dist/core/`.

### output.ts

**`OutputStore`** owns one output folder for the length of a job.

| File in the output folder | When it exists | Purpose |
|---|---|---|
| `.squoosh.lock` | While a job writes here | `{ pid, startedAt }`. Blocks a second process |
| `.squoosh-journal.jsonl` | From the first finished image until the job ends | One `Entry` per finished source, appended after its files are renamed into place |
| `squoosh-manifest.json` | After the first job ends | `{ generator, version: 1, entries }`, sorted by source |
| `*.tmp-<12 hex>` | Only during a write, or after a crash | Removed when the folder is next opened |

- **`open(dir)`** refuses a folder that another job in this process has open, or whose lock belongs to another live process. A lock left by a dead process is taken over. Then it removes stale temp files, loads the manifest and replays the journal (a torn last line is ignored).
- **Ownership:** the store maps every lower-cased output path to the source that owns it. Before writing, `claim(source, paths)` reserves the paths synchronously, so concurrent images can't race, and journals the claim. It refuses a path owned by another source (for example `photo.jpg` at 640 px against a source named `photo-640w.png`), and an existing file that no source owns. Claimed paths without a finished entry are kept in the manifest as `orphans`, so files from an interrupted write still belong to their source.
- **`record(entry)`** appends to the journal through a single promise queue, so lines never interleave.
- **`close()`** writes the manifest atomically if anything changed, deletes the journal and removes the lock.
- **`atomicWrite`** writes `<file>.tmp-<random>` in the same folder and renames it into place, retrying `EPERM`, `EBUSY` and `EACCES` up to 5 times with backoff (Windows).
- **`markup(groups, options)`** builds the HTML for one source. Each group is one output format, holding its sizes largest first. The last group becomes the `<img>`; the others become `<source type srcset>` inside a `<picture>`. A group with several sizes gets a `srcset` with `w` descriptors and `sizes="100vw"`. The `<img>` always has `width`, `height`, `alt=""` and `decoding="async"`, plus `loading="lazy"`, or `loading="eager" fetchpriority="high"` when `priority` is set. URLs are paths relative to the output folder, or `urlBase` + `/` + that path.

## How one image is decided

### 1. Candidates by policy and class

Under `auto`, `avif` and `keep` there is one group, so one output format per size. `picture` adds a fallback group.

| Class | `auto` (default): WebP only | `avif`, and the first group of `picture` | `picture` fallback group |
|---|---|---|---|
| photo | `webp` | `avif`, `webp` | `jpeg`, or the PNG family if the photo uses transparency |
| screenshot | `webp-lossless`, `webp-palette`, `webp` | `webp-lossless`, `webp-palette`, `avif` | PNG family: `png-palette`, `png-quant`, `png` |
| graphic, icon | `webp-palette`, `webp-lossless`, `webp` | `webp-palette`, `webp-lossless`, `avif` | PNG family |

- `auto` writes WebP because every current browser decodes it (Safari 14+, iOS 14+). AVIF needs Safari 16.4+, so it is opt-in through `avif` or `picture`.
- **`keep`** follows the source format: JPEG → `jpeg`; WebP photo → `webp`; other WebP → `webp-lossless`, `webp-palette`, `webp`; AVIF → `avif`; TIFF → the `picture` fallback; PNG and still GIF → the PNG family.
- **Low confidence** (below 0.3): under `auto`, `avif` and `picture`, the photo and screenshot candidates of the same policy are added to the class's own.
- **Filters**, applied to every group: codecs without alpha are dropped when transparency is used; codecs whose side limit is smaller than the largest output are dropped; `png-quant` is dropped for wide gamut; with a target of 100, every lossy codec is dropped.
- **When nothing is left:** with target 100, `webp-lossless` (or `png` if the image is too large for WebP). Otherwise, an image too large for every candidate (over 16,383 px for WebP, 16,384 px for AVIF) falls back to `png` if it uses transparency, or `jpeg` if not.
- **Animated** images skip all of this; see step 5.

### 2. Target

`targetScore` from the preset or number, with +10 for flat classes on presets (capped at 95). Reason: SSIMULACRA 2 was tuned on photos and under-weights faint 1 px lines. On a dashboard screenshot, palette WebP at q27 scored 80.7 but lost its faint 1 px card borders; they came back at about 85, for about 1 KB more.

### 3. Choosing a codec at the largest size (`chooseCodec`)

1. Encode each lossless candidate once and score it.
2. Probe each lossy candidate at its predicted quality `q0`, in parallel. Estimate its size at the target: the probe's bytes, × 0.9 for `png-palette` (OxiPNG is skipped while probing), × `1 + 0.06 × (target − score)` if the probe missed.
3. Sort probes by estimate. Fully search the best one, then the runner-up **only if** its estimate is within 1.15× of the best size that has met the target so far.
4. Take the smallest result that met the target; if none did, the highest score.
5. **Finalize** the winner: re-encode at final settings (AVIF effort 4; OxiPNG for `png-palette`; slower `png-quant`). Palette codecs also try dither 0 against dither 1. If the final encode misses a target the search had met, try once more at quality + 3.

### 4. Smaller sizes

Each smaller size reuses the codec chosen at the largest size for that group. Its search starts from the largest size's quality and is capped at 4 encodes, then finalised.

### 5. Animated images

- One encode, no search: animated WebP at quality 75 (`effort: 4`), or GIF (`effort: 10`) for `policy: "keep"` on a GIF source.
- Only `resize.maxWidth`/`maxHeight` apply. `crop` and `widths` are ignored.
- If the result is not smaller and nothing was resized, the original is copied instead.

### 6. Keep-original guard

When the output is the source's own size (no crop, no resize), there is one group, and the best encode is not smaller than the source, the source file is copied as is, under the source's extension. The output is marked `original: true` with score 100. The note says no re-encode beat it, and warns that its EXIF/XMP metadata is kept if the source has some and `metadata` is `strip`. The guard does not apply under `picture`.

### 7. Time budget

Each image has 60 s plus 2 s per megapixel of its largest output. When it runs out, searches stop and the best result so far is used. The note says "Time budget reached". `targetNotMet` is set only if that result misses the target.

### 8. Write and record

All output names are checked first, then files are written (temp file + rename), then one journal entry is recorded. The image's status is `optimized`, or `kept` if every output is a copy of the original.

## Concurrency and memory

```
JobStore ── at most 2 jobs running, 8 queued
   │
   ▼  each job admits its images one at a time, in order
PixelPool (one per process) ── slots (default min(4, cores/2)) and 64 MP of source pixels
   │
   ▼  each admitted image
libvips: floor(cores / slots) threads per image
MetricPool: at most `slots` workers, one open reference per worker
```

- **Admission:** `Engine.run` reads one file's metadata, waits for the pool, starts the image, and only then looks at the next file. A job never has more than one waiter in the pool, and nothing reads thousands of headers up front.
- **Weight** is the source's width × frame height, because decoding works at source size even when the output is small.
- **Inside one image**, sizes and groups run one after another; the probes of the lossy candidates run in parallel. Both tiles of one comparison go to the same worker, so they run one after the other.
- **Node's libuv thread pool** is left at its default (the code does not set `UV_THREADPOOL_SIZE`).
- **Memory per image:**
  - the raw frame for the current size (width × height × 3 or 4 bytes);
  - every encoded candidate for that size, kept in the `SizeSearch` memo until the size is done;
  - in its worker, one SSIMULACRA 2 reference. For a 1 MP image the reference holds about 57 MB of WASM memory, and a comparison needs about 68 MB of scratch. Tiling caps a comparison at two 1024 × 1024 tiles (about 2.1 MP), whatever the image size.
- **WASM memory never shrinks,** so the pool keeps one open session per worker and recycles a worker that has grown past 512 MB.

## Crash safety and idempotency

### The "unchanged" key

A source is skipped on a re-run only when all of these hold (D15):

| Check | Source of truth |
|---|---|
| An entry exists for this source in the folder's manifest or journal | `OutputStore.lookup` |
| Its settings key matches: sha256 of the effective settings (without `priority`), the engine key (package version, `sharp.versions`, whether OxiPNG loaded) and `PIPELINE_REVISION` | `settingsKey`, `Engine.engineKey` |
| The source's byte size matches | `Entry.sourceBytes` |
| Every recorded output still exists | `OutputStore.outputsExist` |
| The mtime matches, or failing that, the sha256 of the source's content matches | `Entry.sourceMtimeMs`, `Entry.sourceHash` |

A skipped source is returned with status `unchanged` and its recorded outputs and markup.

### Job-level idempotency

The job key is sha256 of the request (`paths`, `files`, top-level settings, `outputDir`, `urlBase`) and the engine key. An identical call while that job is queued or running attaches to it. After it finishes, an identical call starts a new job, which finds every file `unchanged`.

### What survives a crash

| Moment of the crash | Result on the next run |
|---|---|
| During an encode | Nothing was written for that image. It is redone |
| During a write | A `*.tmp-*` file may be left. It is removed when the folder is opened, and discovery ignores it |
| After the claim line, during or after the renames (also a cancel mid-write) | The claim makes the files ours, so the image is redone and they are overwritten |
| After the journal line | The journal is replayed. The image is `unchanged` |
| Before the manifest is compacted | The journal is replayed and compacted at the end of the next job |
| Lock left behind | Taken over if its pid is no longer alive |

### Cancellation

`cancel_job` aborts the job's signal. Images waiting for the pool are not started. Images in progress stop at their next check (between sizes, groups and writes) and come back as `failed` with "Cancelled before this image finished." Finished images are already in the journal, and the manifest is still written, so a re-run skips them.

## Safety model

- **Folders:** reads and writes only inside the allowed folders (see [paths.ts](#pathsts)). The `CLAUDE_PROJECT_DIR` fallback is refused for the home folder and filesystem roots. With no folder configured, every path-taking call is refused with a message that explains the fix.
- **Paths:** real paths on both sides; containment with a trailing separator; symlinks followed only to targets inside the sandbox; outputs checked through their deepest existing ancestor; null bytes refused.
- **Originals:** never opened for writing. Outputs go to a separate folder. If `outputDir` points at the source folder, the ownership check still refuses to replace any file squoosh-mcp did not create, including the sources.
- **Our files only:** an existing file is overwritten only if our manifest or journal lists it.
- **One writer per folder:** the in-process registry and the lock file.
- **Refused inputs:** HEIC/HEIF, SVG, BMP and ICO by extension (with a reason); HEIC by content; files over 256 MB; images over 268 MP (per frame for animations); animated PNG (left as is).
- **Resource limits:** 10,000 files per call, glob depth 32, 20,000 argument elements, the pixel budget, and the per-image time budget.
- **Metadata:** stripped by default after auto-rotation, so GPS and camera data do not leak. The exception is a kept original, which is a byte copy; its note says so.
- **No network:** every tool has `openWorldHint: false`, and nothing is fetched.

## Performance

Measured on an Apple Silicon Mac (18 cores, 48 GB), Node 24, 4 slots. Input: 12 real 1792 × 2400 PNG photos, 81.0 MB in total, target `balanced` (75).

| Run | Output | Smaller by | Time | Peak RSS | Scores | Quality chosen |
|---|---|---|---|---|---|---|
| `policy: "auto"` (WebP) | 5.04 MB | 93.8% | 14.3 s | 1.55 GB | 75.0–76.8 | WebP q77–88 |
| `policy: "avif"` | 3.37 MB | 95.8% | 26.6 s | 1.89 GB | 75.1–76.9 | AVIF or WebP, whichever was smaller |
| `policy: "avif"`, before the build fixes in [Differences from the plan](#differences-from-the-plan) | n/a | n/a | 35 s | 2.4 GB | n/a | n/a |

- Every image met the target in both runs.
- On these photos AVIF is about 33% smaller than WebP. WebP takes about half the time and works in every current browser, which is why it is the default.

**SSIMULACRA 2 in WASM:**
- About 0.23–0.33 s per megapixel per comparison. Tiling caps a comparison at about 2.1 MP, so about 0.5–0.7 s per comparison for any large image. The plan's budget (D13) was at most 1 s per 2 MP comparison.
- About 57 MB of WASM memory per 1 MP reference, plus about 68 MB of scratch per comparison (both for a 1 MP image).

**Tiling accuracy:** on 36 real encodes, the lower tile score was on average 1.4 points stricter than the whole-image score, and at most 0.6 points more lenient.

Not measured yet: the 500-image run (T1.5), Linux and Windows timings, and `npx` cold start.

## Differences from the plan

| Topic | Plan | Built | Why |
|---|---|---|---|
| Default format (D3) | `auto` = AVIF or WebP | `auto` = WebP only; new `avif` policy = AVIF or WebP; `picture` unchanged | WebP decodes in Safari 14+; AVIF needs 16.4+. Decided 2026-11-02 |
| Presets (D4) | Same score for every class | +10 for screenshot, graphic and icon, capped at 95 | Faint 1 px UI lines (see step 2 above) |
| Target 100 (D4) | Forces lossless | Only lossless encoders are candidates | Same intent, made explicit |
| Tiled scoring (R2, A.5) | Above 16 MP, 2 MP tiles chosen by entropy | Above 2.3 MP, two 1024 px tiles: the centre and the most detailed | Bounded time and WASM memory; measured as slightly stricter than whole-image scoring |
| Candidate pruning (A.5) | Fully search the best two probes | The runner-up only if its estimate is within 1.15× of the best result so far | Saves a full search when it cannot plausibly win |
| `PixelPool` | Slots plus pixel budget | Same, but the slot is reserved before a waiter wakes, and `Engine.run` admits images one at a time | A release used to wake every waiter, so concurrency was unbounded |
| Codec limits (§4.3, A.4) | WebP 16,383 px; wider goes to AVIF or is resized | AVIF 16,384 px (sharp's HEIF writer check); too large for the candidates → MozJPEG, or PNG with transparency | No other encoder in the set takes larger images |
| Wide gamut (D11) | By profile | By ICC primaries (area > 1.1× sRGB); names are a fallback | libvips' P3 profile is named `sP3C`; name matching missed it |
| Keep-original guard (§4.3) | Keep the original if nothing is smaller | Copies the original as is; the note warns its EXIF/XMP is kept; not applied under `picture` | A byte copy cannot strip metadata |
| Smaller widths (A.6) | Each starts from the next larger width's result | Each starts from the largest width's winner (codec and quality), ≤ 4 encodes | Simpler; same effect for most images |
| Scoring colour (A.5) | Wide gamut scored as Display P3; 16-bit at 16 bits | Frames are 8-bit. Wide-gamut frames hold Display P3 values and are scored with fast-ssim2's sRGB descriptor (P3 shares sRGB's transfer curve, not its primaries) | fast-ssim2's 8-bit input path |
| Transparency (A.5) | Scored on two backgrounds | RGBA is passed to fast-ssim2 as straight alpha; how the crate handles alpha was not checked for this doc | n/a |
| WASM build (A.1) | `wasm-bindgen` | Plain C ABI, no JS glue | Fewer moving parts |
| Layout (A.1) | `tools/`, `codecs/`, `metric/` folders and `resize.ts` | Flat `core/` modules; tools live in `server.ts`; resizing lives in `pipeline.ts` | Small enough not to need folders |
| OxiPNG fallback (D9) | `@jsquash/oxipng` (WASM) | sharp's zlib at level 9; `png-quant` falls back to `png-palette` | Not added yet |
| Lossless WebP (A.4) | `effort: 6` | `effort: 4` | Not recorded |
| `metadata` (A.2) | `strip`, `copyright`, `all` | `strip`, `all` | `copyright` not built |
| Schemas (A.1, A.2) | Input and output schemas; `response_format` on `analyze_images` | Input schemas only; `analyze_images` has no `response_format` | Not built |
| Job result (A.2) | `byFormat`, `manifestPath` | `counts` by status, `manifests[]` | n/a |
| Markup `sizes` (D19) | `100vw` unless set | Always `100vw`; there is no input to set it | Not built |

## Known limits and next steps

**T1 is not done.** Until it is:
- `balanced` (75) is a placeholder. It has not been calibrated against the SSIMULACRA 2 score of squoosh.app's default output (T1.2, D4).
- There is no BD-rate comparison against squoosh.app per format and class (T1.1), so "as good as Squoosh at the same score" is not yet shown.
- Classifier thresholds, the starting-quality lines in `predictQuality`, the chroma rule, AVIF 4:2:0 against 4:4:4, palette dither and the linear-light method are starting values (T1.4).
- The 500-image performance check, Linux and Windows timings, real clients and agent evaluations are still to run (T1.5–T1.7). CI is defined in `.github/workflows/ci.yml` but has not run yet, because there is no GitHub repo (P0.6, D7).

**Fixed after review** (each has a regression test): probe quality outside the codec's range under strict targets; `picture` groups that resolved to the same format; width-suffix name clashes across sources; stale markup when only `urlBase` or `priority` changed; files from interrupted writes blocking re-runs; a redundant final encode for WebP, JPEG and palette winners; `dryRun` paging without an `offset` input.

**Not built in v1:**
- HEIC/HEIF input (D14), SVG, JPEG XL; preserving HDR gain maps (they are dropped and reported by `analyze_images`); 16-bit output.
- Quality search for animations; `crop` and `widths` for animations.
- Pruning stale outputs when sources are deleted or renamed.
- A `sizes` input for markup, and real `alt` text (markup always has `alt=""`, which the agent should fill in).
- Persistent jobs: jobs live in memory, so a server restart loses job status. Outputs and manifests survive, and a re-run skips finished files.

## Tests

`npm test` runs vitest on [test/](../test/). The suites run against the TypeScript sources. The metric worker runs from `.ts` through Node's type stripping.

| File | Covers |
|---|---|
| [paths.test.ts](../test/paths.test.ts) | Relative paths, `..`, symlink escapes, null bytes, output paths, the `CLAUDE_PROJECT_DIR` fallback |
| [planner.test.ts](../test/planner.test.ts) | Sizes, auto widths, crop shrinking, output-name collisions, candidate groups, targets, settings merge |
| [search.test.ts](../test/search.test.ts) | Search on synthetic quality curves, unreachable targets, early stop, `pick` |
| [analyze.test.ts](../test/analyze.test.ts) | Wide-gamut detection (the `sP3C` regression), colour and edge features, classification |
| [metric.test.ts](../test/metric.test.ts) | Tile choice, scoring sharp buffers in the worker, bands |
| [jobs.test.ts](../test/jobs.test.ts) | `PixelPool` slots, pixel budget and abort (the wake-all regression); `JobStore` attach, refuse, cancel |
| [output.test.ts](../test/output.test.ts) | Manifest persistence, journal replay with a torn line, lock and ownership, markup |
| [e2e.test.ts](../test/e2e.test.ts) | All five tools over an in-memory MCP transport on real files, including a re-run that skips everything |

`npm run fixtures` generates the larger fixture set in `test/fixtures/generated/` (not committed).

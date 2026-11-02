# squoosh-mcp: build plan

| | |
|---|---|
| Status | **Approved and built** (2026-11-02). Decisions follow the recommendations, except D3, which you changed to a WebP default. T1 (test and tune) and R1 (release) remain. Build-time changes to this plan are in [7.3 Decided](#73-decided). |
| Date | 2026-11-02 (revised after an independent review the same day) |
| Progress | [progress.md](progress.md) owns the task IDs (P1.3 and so on) and their status. |
| Research | Full notes and citations are in [research/](research/), and this plan cites them by file and section. Decision numbers inside the research notes are local to each note; the D-numbers here are the ones that count. |

---

## 1. Summary

**What.** An open-source MCP server on npm (`npx -y squoosh-mcp <folders>`). An AI agent points it at folders of images. For each image it decides size, format and quality, then writes new optimised files, a manifest and ready-to-paste `<picture>` markup.

**Why.** squoosh.app is the quality reference many teams trust, but it optimises one image at a time by hand. Its batch mode applies one setting to every image, whatever its shape or content. Google deleted Squoosh's Node library and CLI in January 2023. No existing MCP server does any of these ([competitors.md §4](research/competitors.md)):
- sets quality by how the result *looks*,
- decides per image,
- produces responsive sizes locally.

**How.**
- **Codecs:** use the same codec families as Squoosh, with Squoosh's settings: MozJPEG, libwebp, AV1 through aom, OxiPNG and libimagequant. They run natively through `sharp`, which is faster than Squoosh's browser (WASM) builds and mostly newer (§2.3).
- **Quality:** add the SSIMULACRA 2 visual-quality score. It finds the lowest quality, or fewest colours, at which each image still looks right.

**Order** (your instruction, 2026-11-02):
1. Build everything first: phases P0–P5.
2. Then test and tune against squoosh.app on your images (T1).
3. Release only when you say (R1).

| | squoosh.app | squoosh-mcp |
|---|---|---|
| Throughput | One image at a time, by hand | Hundreds per call, several in parallel |
| Quality setting | You guess a number (MozJPEG 75, AVIF 50…) | Searches for the lowest setting that meets a visual-quality score |
| Batch decisions | One setting for every file | Each image gets its own format, quality and size; the agent can set any of them per file |
| Resizing | One box for all | Fits each image's own aspect ratio and never upscales. Smart crop is available per file |
| Output | Download files one by one | Files, a manifest, and `<picture>`/`srcset` markup with width and height |
| PNG / lossless | OxiPNG 9 | OxiPNG 10, plus palette reduction tuned by score |

---

## 2. Current state

### 2.1 This repo
`docs/` only. There is no git repository yet (D8).

### 2.2 Squoosh today ([squoosh-internals.md](research/squoosh-internals.md))
- **libsquoosh and the CLI were deleted on 2023-01-03**, in commits `918c596c` and `13a185de` (#1321). The README gives staffing as the reason. `@squoosh/lib` 0.5.3 only supports Node ≤ 16 (§1.3).
- **The web app's code was last changed on 2024-08-19.** Its codecs are MozJPEG 3.3.1 (2018), libwebp from 2020-11, libavif 1.0.1 with aom 3.7.0, OxiPNG 9.0, libimagequant 2.12.1, and a libjxl build from 2022 (§2.1, §3.2).
- **A large codec refresh is open but not merged:** PR #1473, 44 commits from May to October 2026. It would:
  - make jpegli the default JPEG encoder,
  - set AVIF to 4:4:4 and palette dither to 0,
  - add SSIMULACRA 2 and drop WebP2.

  If it merges, squoosh.app's defaults move. T1 therefore compares against the **current live build**, pinned (§5, T1).
- **Default settings we copy** (§2.2–3.2):

| | Squoosh default |
|---|---|
| MozJPEG | quality 75, progressive, quant table 3, trellis, automatic chroma subsampling |
| WebP | quality 75, method 4 |
| AVIF | quality 50, aom speed 6, 4:2:0 chroma |
| OxiPNG | level 2 |
| Palette reduction | 256 colours, dither 1.0 |
| Resize | lanczos3, premultiplied alpha, linear light |

  Squoosh's AVIF "effort" slider is 10 − speed. sharp's `effort` is 9 − speed (libvips `heifsave.c`). Contributors must not mix the two scales.
- **jSquash** packages Squoosh's codecs for npm. Its builds are as old as the web app's. Its README calls Node support "limited/experimental", and in Node it runs every codec on one thread. It has **no palette-reduction package**. Its resize has an open bug that corrupts images in contain mode (§5).

### 2.3 Engine evidence ([engines-and-metrics.md](research/engines-and-metrics.md))
The local benchmark used 3 images on an Apple Silicon Mac with Node 24. Scripts are in [research/engine-bench/](research/engine-bench/). The numbers are indicative, not final: T1 re-measures them with SSIMULACRA 2.

| Format | sharp 0.35.5 with Squoosh's settings, against Squoosh's codecs (via jSquash) |
|---|---|
| JPEG | Within 31 bytes (≤ 0.02%). With MozJPEG tuning off, as sharp ships by default, files are **25% bigger** |
| WebP | Byte-identical on 2 of 3 images |
| AVIF | Roughly equal on one photo. **Provisional:** the score used was luma-only SSIM, and sharp ran at 4:4:4 against jSquash at 4:2:0. Re-measured in P2 |
| PNG lossless | sharp's own writer is **4–15% bigger** than OxiPNG. With OxiPNG added, it is within about 1% of Squoosh |
| PNG palette | Mixed. On artwork, @napi-rs/image's quantiser gave 314.7 KB against sharp's 413.6 KB (381 KB after OxiPNG). On a photo, sharp won |
| Speed per image at the chosen settings | JPEG about 1.8× faster; AVIF at effort 4 about 2.4–2.9× faster |
| Speed per batch | About 7× faster in our run. That overstates the gap, because jSquash ran without a worker pool |

**Libraries.**

| | sharp 0.35.5 | Squoosh (live app) |
|---|---|---|
| mozjpeg | 2025 master | 3.3.1 |
| libwebp | 1.6.0 | 2020 build |
| aom | 3.15.1, through libheif | 3.7.0, through libavif |
| PNG writer | libpng | OxiPNG |
| Quantiser | **libimagequant 2.4.1, older** | libimagequant 2.12.1 |

So "newer builds" holds for JPEG, WebP and AVIF, but **not for the quantiser**. That is why palette PNG gets a second quantiser (D17).

### 2.4 Quality metric evidence ([engines-and-metrics.md §5](research/engines-and-metrics.md))
- **SSIMULACRA 2 is the standard.** libjxl and libaom's `tune=iq` use it, and on the CID22 dataset it matches human ratings best.
- **Scale:** 90 visually lossless, 85 excellent, 80 very high, 70 high, 50 medium. For orientation, the metric's README puts 80 at about libjpeg-turbo 4:2:2 quality 85, and 70 at 4:2:0 quality 70. squoosh.app's default MozJPEG 75 4:2:0 therefore probably scores about 70–75. That is an estimate; T1 measures it (D4).
- **No trustworthy npm package exists.** The source is the Rust crate `fast-ssim2` 0.9.1 (BSD-2, released 2026-11-01). It supports WASM SIMD and lets us process the reference image once and reuse it. It scores transparent images on two backgrounds and takes the lower score, which doubles the cost, and it accepts Display P3 and 16-bit input. **Its speed and memory use as WASM in Node have not been measured.**

### 2.5 MCP today ([mcp-conventions.md](research/mcp-conventions.md))
- **Spec and SDK.** The spec is `2026-07-28`. The TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0) needs zod 4. `serveStdio` serves both older and newer clients from one code path (§2).
- **Timeouts.** The lowest common client timeout is about 60 s (Codex's default; Claude Desktop's is undocumented). Codex also gives a server only **10 s to start**, which matters for the first `npx` download (§6.1).
- **Folder access.** Roots are deprecated, so allowed folders come from command-line arguments, as in the official filesystem server (§5.3).

### 2.6 Competitors ([competitors.md](research/competitors.md))
The largest image MCP server has 34 stars and last published in April 2025. None of them:
- targets a visual-quality score,
- decides per image within a batch,
- produces responsive sizes with markup locally,
- or supports JPEG XL locally.

---

## 3. Options

### 3.1 Engine

| Option | Output versus Squoosh | Speed | Install | Main risk |
|---|---|---|---|---|
| **A. sharp with Squoosh's settings + OxiPNG, with a second quantiser for palette PNG** (recommended) | JPEG and WebP equal; AVIF provisionally equal; palette mixed (hence two quantisers) | Fastest | Prebuilt for about 14 platforms, about 20 MB, no install script | Native binary per platform |
| B. jSquash only (Squoosh's WASM codecs) | Identical by construction, except no palette reduction | 1.3–3× slower per image, single-threaded in Node | Pure WASM, portable | "Limited" Node support, old codecs, resize bug |
| C. wasm-vips | Like A, and adds JPEG XL | AVIF about 19× slower | Pure WASM | Version 0.0.x |
| D. @napi-rs/image only | WebP equal, JPEG +52% (no MozJPEG tuning) | Fast | Native | Weaker JPEG |

**Recommendation: A (D1).** Every codec sits behind one adapter interface. If T1 shows a format losing to squoosh.app, only that format switches:
- JPEG, WebP or AVIF move to the Squoosh WASM codec (B);
- palette PNG keeps whichever quantiser wins.

### 3.2 Quality metric

| Option | Accuracy | Trust | Effort |
|---|---|---|---|
| **A. Our own WASM build of `fast-ssim2`** (recommended) | Current SSIMULACRA 2.1 | Built by us from a BSD-2 crate pinned to an exact version | Needs a Rust toolchain for metric work only; the built `.wasm` is committed (D20) |
| B. `bytecut-ssimulacra2` from npm | 2.1 | One maintainer, no source repo | Low |
| C. Butteraugli (`@squoosh-kit/visdif`) | Older, less accurate | Small project | Low |
| D. `ssim.js` | Poor: grayscale and downsampled. In testing it accepted JPEG q41 | Popular | Low |
| E. No metric: fixed expert presets | None | n/a | None |

**Recommendation: A (D2).**
- **Fallback trigger (D13):** if WASM scoring is slower than 1 s per 2 MP comparison on this Mac after the optimisations in A.5, ship E for v1.
- **Later swap:** `zensim` (imazen, MIT/Apache) estimates SSIMULACRA 2 at about 22 ms per 1080p frame natively. It has no WASM build yet, so it replaces A once one exists.

### 3.3 Long batches

| Pattern | Works in every client | Calls | Note |
|---|---|---|---|
| One blocking call | No: fails at about 60 s on Codex and probably on Claude Desktop | 1 | |
| Agent splits the work into chunks | Yes | Many | The bookkeeping lands on the agent. Kept as a fallback if jobs misbehave in a client |
| **Hybrid** (recommended) | Yes | 1 for small batches; 1 + about one every 45 s for big ones | `optimize_images` works for up to 45 s (configurable), then returns a `jobId`. `get_job` waits up to 45 s per call |
| MCP Tasks extension | Only Claude Code CLI among local clients | Host polls | Later: a thin adapter on the same job store |

---

## 4. Design

### 4.1 How it works

```
 Agent ──tools──► server.ts ─► schemas ─► path sandbox ─► job store (module-wide; 45 s inline, then jobId)
                                                              │
                                                              ▼
            discover ─► analyze (facts + class) ─► planner: per-image plan + full output map (collisions resolved)
                                                              │
                                                              ▼
                              pipeline: global pool, limited by slots and a pixel budget
                              │                         │                           │
                              ▼                         ▼                           ▼
                     resize (sharp:             quality search ◄──────── SSIMULACRA 2 (WASM, worker threads,
                     lanczos3, linear light,    (fast effort while       reference processed once per size)
                     smart crop)                searching, final effort
                              │                 for the winner)
                              ▼                         │
              codec adapters: sharp MozJPEG / WebP / AVIF (+ tune=iq); palette from two quantisers;
              OxiPNG 10 (@napi-rs/image). Any format can switch to a Squoosh WASM codec.
                                                        │
                                                        ▼
              output: temp file + rename → journal line → manifest compacted at job end; markup; report
```

### 4.2 Tools

There are five tools, following Anthropic's tool-writing guidance: few high-impact tools, short output by default, and errors that say how to fix the call ([mcp-conventions.md §5.1](research/mcp-conventions.md)). The allowed folders are written into each tool's description at startup.

| Tool | Annotations | What it does |
|---|---|---|
| `analyze_images` | read-only | Scans files, folders or globs. It is fast by default: it reads headers only and returns facts per file and totals by folder. With `deep: true` it decodes and classifies each image and shows the `auto` plan. Deep mode is paged, at most 50 files per call, so every call stays well under the timeout |
| `optimize_images` | not read-only; `destructiveHint: false`; `idempotentHint: true` | Runs a batch. Settings apply at the top level and can be overridden per file in `files[]`. Returns a summary, or a `jobId` after 45 s. `dryRun` returns the plan only: classes, candidates, sizes and output paths, without encoding |
| `get_job` | read-only | Progress and results. Waits up to 45 s, with paging |
| `cancel_job` | `destructiveHint: false`, `idempotentHint: true` | Stops a job. Files already written stay, and are recorded |
| `compare_images` | read-only | SSIMULACRA 2 score and band, sizes and dimensions for an original and a candidate. Small preview images only if asked |

Why these annotations are honest:
- **Not destructive:** `optimize_images` never writes originals, and it only overwrites files that its own journal or manifest says it created (D15).
- **Idempotent:** a call identical to a running job returns that job's `jobId`. A finished file is skipped on a repeat call only if its source, settings, tool version and codec versions are all unchanged (D15).
- **`cancel_job`:** sets `destructiveHint: false` explicitly, because the spec's default is `true`.

### 4.3 How each image is decided
1. **Analyse** (Appendix A.3). Read metadata with orientation applied, then measure:
   - transparency use,
   - colour count,
   - flat-area share,
   - hard-edge share,
   - entropy.
2. **Classify** each image as `photo`, `screenshot` (UI or text), `graphic` (logo, illustration), `icon` or `animated`, with a confidence value. When confidence is low, also try the next class's candidates.
3. **Plan.** Under the default `auto` policy, outputs are WebP only: lossy, lossless or palette (D3). `avif` adds AVIF; `keep` and `picture` add JPEG or PNG.

| Class | `auto` candidates | `keep` / `picture` fallback |
|---|---|---|
| photo | AVIF 4:2:0, lossy WebP | MozJPEG (JPEG sources), or PNG |
| screenshot | Lossless WebP, palette-reduced lossless WebP, AVIF 4:4:4 | Palette PNG or OxiPNG |
| graphic / icon | Palette-reduced lossless WebP, lossless WebP, AVIF 4:4:4 | Palette PNG + OxiPNG |
| animated | Animated WebP | Re-encoded GIF |

   Rules for every class:
   - **Chroma:** never use 4:2:0 when the image has many hard edges or few colours, whatever its class. This stops a mislabelled screenshot from blurring its text.
   - **Transparency:** if every pixel is opaque, the alpha channel is dropped. If transparency is used, codecs without alpha (JPEG) are removed from the candidates.
   - **Codec limits:** candidates are filtered by codec limits. WebP allows at most 16,383 px per side, so a wider panorama goes to AVIF or is resized.
4. **Search** (A.5). For each candidate, find the lowest quality (or fewest colours) that meets the target. The search runs at a fast encoder effort; the winner is re-encoded at the final effort and scored again.
5. **Pick and guard.**
   - The smallest file that meets the target wins. A candidate that missed the target never beats one that met it.
   - If nothing is smaller than the original, and nothing was resized or converted, the original is kept. The report says why (for example, "source already heavily compressed").
6. **Write.** Each output is written to a temp file and renamed into place, then recorded in the journal. The manifest and markup are produced from the journal (A.7).

### 4.4 Safety model
- **Folders.** The server reads and writes only inside folders given at launch: command-line arguments, or Claude Code's `CLAUDE_PROJECT_DIR` if there are none.
  - The fallback is **refused** when it resolves to the home folder or a filesystem root. MCP's local-security guide says "never your home directory".
  - If no folder is configured, every call is refused with a message that explains the fix.
- **Paths.** Path checks copy the official filesystem server's:
  - real paths are compared on both sides,
  - symlinks pointing outside are refused,
  - output paths and their parent folders are checked too.
- **Originals** are never overwritten in v1 (D5).
- **Output folder:** our output folder is recognised by its marker file (the manifest or journal), not by its name, and is skipped during discovery. A user's own folder called `optimized/` is still processed.
- **One writer per output folder:** a lock file stops a second server process from writing to the same output folder at the same time.
- **Limits:**
  - discovered files per call,
  - argument size,
  - input bytes,
  - pixels per image or per animation frame,
  - a per-image time budget that scales with pixel count,
  - a global pixel budget for images in flight (A.9).

---

## 5. Plan

**How phases run:**
- **Branches:** each phase is built on its own branch. Where it merges depends on D8; `main` holds only released code.
- **Tests:** unit tests are written alongside the code for the parts that must not regress silently (D10):
  - sandbox escapes,
  - output-name collisions,
  - recovery of the journal after a crash,
  - search behaviour on synthetic quality curves,
  - classifier fixtures.
- **Validation:** the heavy testing, benchmarking and tuning is T1, after the build.

| Phase | Goal | Done when | If it goes wrong |
|---|---|---|---|
| **P0 Foundation** | Repo, package, toolchain, CI | `npm run build` produces `dist/` with a working `bin` and the `.wasm` copied in; the MCP Inspector connects and lists 5 stub tools; CI passes on macOS, Linux and Windows (on a private GitHub repo, D8) | Without a GitHub repo, Windows is first exercised in T1 and its issues surface late |
| **P1 Core engine** | Discovery, sandbox, analysis, codec adapters, resize, output map, journal, manifest | The fixture folder, including the collision and edge-case fixtures, is optimised at fixed qualities. Outputs land only in the output folder with unique names. A run killed midway resumes without errors | A codec that misbehaves is swapped behind its adapter |
| **P2 Quality** | SSIMULACRA 2 WASM, worker pool, search, candidate choice, keep-original guard | Every check passes on this Mac (D13): (1) WASM score within ±0.5 of the reference tool on its test images; (2) scoring at most 1 s per 2 MP comparison; (3) `auto` at most 6 s per 2 MP image per width; (4) the chosen file within 3% of the bytes an exhaustive quality sweep finds, using at most 6 encodes per candidate | Over the speed limit: ship presets (option E) behind the same interface |
| **P3 MCP layer** | The 5 tools, schemas, annotations, jobs, progress, cancellation, paging, error messages | A 200-image batch completes through `optimize_images` plus `get_job` in the Inspector. An identical repeat call returns the same `jobId`. Cancelling mid-job stops it with no leftover temp files | If jobs misbehave in a client, cap files per call and let the agent split the work |
| **P4 Delivery features** | Responsive widths, smart crop, markup, skip unchanged, `keep` and `picture` policies, animated images | A mixed folder of different aspect ratios gets the right sizes per image. The markup carries width and height and correct URLs. A second run with the same settings skips everything, and a run with new settings redoes everything | Each feature can ship switched off |
| **P5 Docs** | README, tool reference, architecture, security, contributing, changelog, notices | Every doc in progress.md except `benchmarks.md` (a T1 output) is written. Each README install snippet is checked against its client's current docs; the live check is T1.5 | n/a |
| **T1 Test and tune** | Comparison with squoosh.app, tuning, performance, real clients, agent evaluations | See below | Any format that fails the comparison switches codec (§3.1) |
| **R1 Release** (only on your go) | npm, public GitHub repo, MCP Registry | `npx -y squoosh-mcp@x.y.z` works on a clean machine, and the registry search finds it | `npm deprecate` and a patch release. A used `name@version` can never be republished. After 72 hours, npm allows unpublishing only with no dependents, fewer than 300 downloads in the last week and a single owner (npm policy, checked 2026-11-02). Registry entries are fixed by publishing a new version |

### T1 Test and tune: done when all of these hold
1. **Comparison.** Run on your 10–20 real images plus the generated fixtures: photos, screenshots, a transparent logo, an animated GIF, a panorama wider than 16,383 px, a portrait with EXIF rotation, a CMYK JPEG, a 16-bit PNG and a Display P3 photo.
   - **Baseline:** the squoosh.app build live today (2024-08-19 `dev`). The automatic sweep uses jSquash, which has the same codec builds, and a few manual squoosh.app exports confirm jSquash matches the app.
   - **Measure:** for each format and image class, compare how file size grows with SSIMULACRA 2 score between 60 and 90. This is the BD-rate, the standard way to compare encoders.
   - **Gate:** a format fails if it is more than 2% bigger on average. A failing format switches codec (§3.1).
   - **Palette PNG** is compared against squoosh.app's own quantiser.
   - Results go in `docs/benchmarks.md`.
2. **Defaults calibrated.** SSIMULACRA 2 is measured for squoosh.app's default output, per class. This sets `balanced` (D4) and records our default output's bytes against squoosh.app's.
3. **Visual check.** An HTML contact sheet shows 100% crops of text, gradients, skin and edges, original against output. You review it.
4. **Tuning.** These are set from the data:
   - classifier thresholds,
   - starting-quality tables,
   - the chroma rule,
   - AVIF 4:2:0 against 4:4:4 at matched scores,
   - palette dither,
   - linear-light resize: `.gamma()` against `pipelineColourspace('scrgb')`.
5. **Performance.**
   - A mixed folder of 500 images (about 3 MP on average, one width) finishes in **≤ 15 minutes** on this Mac, with peak memory **≤ 2 GB** (D13).
   - The same run is timed on Linux.
   - Cold-start time of `npx` is recorded.
6. **Real clients.** Installed from `npm pack` in Claude Code, Claude Desktop, Cursor, VS Code, Codex and Windsurf.
   - A real batch runs in each, and timeout and progress behaviour is recorded.
   - Each README snippet is copied and pasted exactly as written.
7. **Agent evaluation.** 5 realistic requests, for example "optimise this site's images; hero max 1920 and eager-loaded; thumbnails 400 square". We read the transcripts and fix tool descriptions wherever the agent stumbled.

---

## 6. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | SSIMULACRA 2 as WASM is too slow (native is about 350 ms per 2 MP; WASM unmeasured) | Medium | Slow batches | Process the reference once; search at a fast effort; prune candidates after one probe; run scoring in worker threads. The trigger in D13 switches to presets. zensim later |
| R2 | The metric's WASM memory (4 GB ceiling) is exhausted on very large images | Medium | Failure on big images | **Built:** above 2.3 MP, score two full-resolution 1024 px tiles (the centre plus the most detailed tile). That bounds memory to about 180 MB per worker, and on 36 encodes it was 1.4 points stricter than whole-image scoring on average and at most 0.6 more lenient |
| R3 | The classifier mislabels an image, and text blurs | Medium | Visible artefacts | The chroma rule depends on features, not on the class. Low-confidence images try candidates from both classes. Thresholds are tuned in T1 |
| R4 | SSIMULACRA 2 gives one score for the whole image, so a small text area can degrade while the score stays high | Medium | Local artefacts | Full chroma for images with hard edges. Later: score in tiles and use the worst tile |
| R5 | Wide-gamut photos look dull, or are scored in the wrong colour space | Medium | Colour shift | Keep the ICC profile for wide-gamut sources and score them in Display P3 (D11) |
| R6 | HDR gain maps are silently lost | Medium | HDR lost | Report every dropped gain map; preserving them comes later (D11) |
| R7 | Output-name collisions, or a crash between writing a file and recording it | Medium | Wrong or missing outputs | Build the full output map before encoding; keep an append-only journal, with ownership and a lock file (A.7) |
| R8 | A client timeout or retry leaves an orphaned or duplicate job | Medium | Wasted work | Identical calls attach to the running job; overlapping jobs are refused (A.8) |
| R9 | The comparison baseline moves when Squoosh PR #1473 merges (jpegli has no sharp equivalent) | Medium | The T1 gate goes stale | Pin the 2024 live build as the baseline; jpegli is a later candidate codec |
| R10 | Already-lossy sources: re-encoding them often saves little | High | Small savings | The keep-original guard, and the report says why a file was kept |
| R11 | The first `npx` run exceeds Codex's 10 s start-up limit | Medium | Server fails to start | The README tells Codex users to raise `startup_timeout_sec` or install globally. Cold start is measured in T1 |
| R12 | Native binaries are missing on an unusual platform (@napi-rs/image has 12 platforms, sharp 14) | Low | Install fails | If the OxiPNG native module fails to load, fall back to WASM OxiPNG (D9). The README links sharp's install guide |
| R13 | Windows paths: backslashes in globs, the 260-character limit, a rename failing on a locked file | Medium | Errors on Windows | POSIX paths in the manifest and markup; glob input normalised; retry renames with backoff; CI on Windows from P0 (D8) |
| R14 | The "Squoosh" name implies an official Google project, or Google objects | Low–medium | Forced rename | An "Unofficial; not affiliated with Google" line in the README and package description. The name lives only in packaging, so a rename is `package.json` plus `npm deprecate` |
| R15 | fast-ssim2 is version 0.x, released the day before this plan, from one vendor | Medium | Score bugs | Pin the exact version, commit the built WASM, check scores against the reference tool in P2 |
| R16 | MCP churn: the spec is 3 months old and SDK v2 is new | Medium | Breaking changes | Exact versions plus a shrinkwrap file (D18). Avoid deprecated features. `serveStdio` serves both older and newer clients |
| R17 | Data loss | Very low | High | Originals are never written. Temp file plus rename. Only files we own are overwritten. Every path is checked |

---

## 7. Decisions

### 7.1 Need your answer

D1–D8 were raised in chat on 2026-11-02 and keep their numbers.

| # | Decision | Options | Recommendation and reason |
|---|---|---|---|
| **D1** | Engine | A. sharp with Squoosh's settings + OxiPNG + a second quantiser · B. Squoosh's WASM codecs (jSquash) only | **A, gated by the T1 comparison.** Same codec families, mostly newer, faster. A losing format switches alone (§3.1) |
| **D2** | Quality metric, and installing Rust on your Mac | A. Build SSIMULACRA 2 WASM from `fast-ssim2`. This installs `rustup`, the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` under `~/.rustup` and `~/.cargo` · B. The unvetted npm package · E. Presets only | **A.** The standard metric, built by us from a BSD-2 source. Only metric work needs Rust, because the built `.wasm` is committed (D20). **May I install Rust?** |
| **D3** | Format when the agent doesn't specify one | `auto`: AVIF or WebP, whichever is smallest · `keep`: the source's format · `picture`: AVIF/WebP plus a JPEG or PNG fallback | **Decided by you: WebP.** `auto` writes WebP only (lossy, lossless or palette), which every current browser decodes (Safari 14+; AVIF needs 16.4+). The former `auto` is now `policy: "avif"`. Measured on 12 photos: WebP 5.0 MB in 17 s, AVIF 3.4 MB in 27 s (progress.md log) |
| **D4** | Default visual target (`balanced`) | A. **Calibrated:** the SSIMULACRA 2 score of squoosh.app's default output, measured per class in T1. It is probably about 72; 75 is the placeholder until then · B. Fixed at 80 ("very high") · C. Fixed at 90 (visually lossless) | **A.** The promise becomes "looks like squoosh.app's default and is smaller". Other presets: `small` = balanced − 10, `high` = 85, `lossless-look` = 90. The agent can pass any number from 30 to 99; 100 forces lossless |
| **D5** | Originals and output location | A. Never overwrite originals in v1. Outputs go **inside** each input root, in `<input root>/optimized/`, mirroring the folder structure. The input root is the folder given, or the deepest folder holding all files in that `paths` entry, or a glob's fixed base folder. Several roots mean several output folders · B. New files beside the originals (`photo.jpg` → `photo.avif`) · C. In-place replacement behind an explicit flag | **A for v1.** Always inside the allowed folder, easy to compare and easy to delete. B and C later |
| **D6** | v1 scope | **In:** the 5 tools; JPEG, PNG, WebP, AVIF, GIF and TIFF input; animated GIF and WebP; `auto`, `keep` and `picture`; per-file settings (`files[]`); resizing; smart crop per file; responsive widths; markup; manifest; skipping unchanged files. **Later (v1.1+):** glob-based `overrides` (the agent can use `files[]` instead); JPEG XL; SVG via SVGO; HEIC (D14); a Claude Desktop `.mcpb` bundle; a standalone CLI; remote URLs; the Tasks extension; tile-based scoring; pruning stale outputs; in-place replacement | **As listed.** It keeps per-image control, which is the core promise, and cuts the most schema complexity |
| **D7** | Name, licence, GitHub owner | Name: `squoosh-mcp` (your stated preference; free on npm on 2026-11-02) · Licence: Apache-2.0 or MIT · Owner: your personal account or an organisation. The owner sets the repo URL and the registry name `io.github.<owner>/squoosh-mcp` | **Decided by you: owner `atiquefiroz`**, so the repo is `github.com/atiquefiroz/squoosh-mcp` and the registry name is `io.github.atiquefiroz/squoosh-mcp`. `squoosh-mcp`, an "Unofficial" line, Apache-2.0 (patent grant, same as Squoosh) |
| **D8** | Git, branches, CI | A. `git init` now, keeping your rule that unreleased work stays off `main`: `main` holds released code only, work happens on `develop` plus a branch per phase, and **a private GitHub repo is created in P0** so CI runs on macOS, Linux and Windows from the start. It needs D7's owner and your OK to push privately · B. Local only until release: no CI before R1, so Windows problems surface late | **Changed by you: a public repo from the start, with the first release committed to `main`.** CI runs on the first push. Later work goes on branches and reaches `main` when released |
| **D10** | Tests during the build | A. The focused unit tests listed in §5, written alongside the code; full validation in T1 · B. No tests until T1 | **A.** These catch exactly the failures that are invisible until data is lost or wrong: sandbox escapes, collisions and crash recovery |
| **D11** | Metadata, colour, HDR | After auto-rotating, strip all metadata (GPS, camera, EXIF). Convert to sRGB, but **keep the ICC profile for wide-gamut sources** and score them in Display P3. Options keep copyright or everything. HDR gain maps: v1 reports when one is dropped | **As listed.** Smaller files and no location leaks, without dulling P3 photos. Preserving HDR comes later |
| **D12** | Animated images | A. Animated GIF or WebP becomes animated WebP at a fixed quality of 75 (Squoosh's default), keeping the original if that isn't smaller. The pixel limit applies per frame · B. Skip animated files in v1 | **A.** Cheap with sharp. Searching quality per animation, and mixed lossy/lossless frames, come later |
| **D13** | Speed and memory budget (P2 and T1 checks) | All on this Mac: scoring ≤ 1 s per 2 MP comparison, or switch to presets · `auto` ≤ 6 s per 2 MP image per width · 500 mixed images ≤ 15 minutes · peak memory ≤ 2 GB | **As listed.** These are my estimates from the research numbers, so tell me if you need faster |
| **D14** | HEIC (iPhone photos) | A. Later: v1 refuses HEIC with a clear message · B. v1 adds a WASM HEIC decoder. HEVC carries patent and licensing questions | **A.** sharp's prebuilt binaries cannot decode HEIC. Worth adding once the licensing is checked |

### 7.2 Technical defaults (I'll proceed with these unless you object)

| # | Topic | Default | Why |
|---|---|---|---|
| D9 | OxiPNG and the second quantiser | `@napi-rs/image` 1.16.0. It provides OxiPNG 10 with its own preset (it has no `level` option) and `pngQuantize`. If the native module fails to load, fall back to `@jsquash/oxipng` (WASM) | About 2× faster than WASM, and its quantiser beat sharp's on artwork. Adds about 22 MB, which affects cold start (R11) |
| D15 | What "unchanged" means, and who owns an output | Skip a file only when `sha256(source)` + a hash of that file's effective settings + tool version + codec versions all match. An output is ours only if it appears in our journal or manifest, and only ours may be skipped or overwritten. Size plus modification time is a fast check before hashing | Correct re-runs, honest annotations, and no overwriting of files a person made |
| D16 | AVIF settings | Search at sharp effort 3 (aom speed 6, Squoosh's default speed); encode the winner at effort 4 and score it again. `tune: 'iq'` is set explicitly. 4:2:0 for photos, 4:4:4 otherwise; T1 compares both at matched scores | Effort 3 is about 4–5× faster to search with. An explicit `tune` stops a library default change from altering output |
| D17 | Palette PNG | Candidates come from both quantisers. The colour count comes from sharp's `quality` setting (the fewest colours that reach a given quality), refined by score. Dither 0 and 1.0 are both tried at the chosen count (one extra encode) | The research showed neither quantiser always wins, and Squoosh itself is moving to dither 0 |
| D18 | Dependency pinning | Exact versions for runtime dependencies, plus `npm-shrinkwrap.json`, so `npx` installs exactly what was tested | `npx` does not use a lockfile. Caret ranges would pull untested versions |
| D19 | Markup defaults | `urlBase` option (default: paths relative to the output folder). `sizes="100vw"` unless set. `loading="lazy"` by default; `priority: true` on a file gives `loading="eager"` and `fetchpriority="high"` for hero images. `widths: "auto"` drops any width within 15% of the next | Lazy-loading the main image delays page rendering (LCP). Markup should work when pasted |
| D20 | Shipping the WASM | Commit the built `ssim2.wasm`. CI rebuilds it from the pinned crate and fails if it differs. The build copies it into `dist/` | Contributors don't need Rust, and the binary stays verifiable |
| D21 | Node and CI | `engines: >=22.17.0`, so the built-in `fs.glob` is stable (Node v22.17.0 docs). CI runs Node 22, 24 and 26: Node 26 became LTS on 2026-10-28 (nodejs/Release `schedule.json`) | No glob dependency, and all supported LTS lines are tested |

### 7.3 Decided

| What | Decision | By |
|---|---|---|
| Build order | Build everything (P0–P5), then test and tune (T1), then release only on your go (R1) | You, 2026-11-02 |
| Tracking | Plan and progress live in `docs/`; progress.md is updated as each task lands | You, 2026-11-02 |
| MCP stack | `@modelcontextprotocol/server` v2 with zod 4 and `serveStdio`. Roots, sampling, elicitation and MCP logging are not used in v1 | Technical ([mcp-conventions.md §2, §7](research/mcp-conventions.md)) |
| Long batches | Hybrid: 45 s inline (configurable), then a `jobId` (§3.3) | Technical |
| Folder access | Folders as command-line arguments, falling back to `CLAUDE_PROJECT_DIR`, but never the home folder or a filesystem root (§4.4) | Technical |
| Plan approval | Build end to end with the recommended decisions | You, 2026-11-02 |
| D3 default format | WebP for browser coverage; AVIF by `policy: "avif"` | You, 2026-11-02 |
| Presets for flat content | Screenshots, graphics and icons get +10 on presets (balanced 75 → 85). Palette WebP at a score of 80.7 dropped faint 1 px UI borders, which came back at about 85 | Technical, from a build finding |
| `target: 100` | Only lossless encoders; the original is kept when that is smaller | Technical (implements D4) |
| Large images | AVIF is capped at 16,384 px per side (sharp's HEIF writer); larger images fall back to MozJPEG, or PNG with alpha | Technical, from a build finding |

---

## 8. Sources

**Local research** (each file cites its own sources): [squoosh-internals.md](research/squoosh-internals.md) · [engines-and-metrics.md](research/engines-and-metrics.md) · [mcp-conventions.md](research/mcp-conventions.md) · [competitors.md](research/competitors.md) · [engine-bench/](research/engine-bench/)

**Primary sources:**
- **Squoosh:** https://github.com/GoogleChromeLabs/squoosh · removal commit https://github.com/GoogleChromeLabs/squoosh/commit/918c596cba36a46ff3d7aa8ffd69580bd22528e2 · codec refresh https://github.com/GoogleChromeLabs/squoosh/pull/1473 · the old auto-optimiser https://github.com/GoogleChromeLabs/squoosh/blob/918c596cba36a46ff3d7aa8ffd69580bd22528e2/libsquoosh/src/auto-optimizer.ts
- **jSquash:** https://github.com/jamsinclair/jSquash
- **sharp:** https://sharp.pixelplumbing.com/api-output/ · https://sharp.pixelplumbing.com/api-resize/ · https://sharp.pixelplumbing.com/api-operation/ · https://sharp.pixelplumbing.com/changelog/v0.35.0 · libvips build versions https://raw.githubusercontent.com/lovell/sharp-libvips/main/versions.properties
- **libaom `tune=iq`:** https://aomedia.org/blog%20posts/Libaom-3_12_0-Now-Available-from-Codec-Working-Group/
- **SSIMULACRA 2:** https://github.com/cloudinary/ssimulacra2 · `fast-ssim2` https://docs.rs/crate/fast-ssim2/latest
- **Prior art for automatic quality:** https://docs.imgproxy.net/features/autoquality · https://cloudinary.com/documentation/image_optimization#automatic_quality_selection_q_auto
- **MCP:**
  - spec changelog https://modelcontextprotocol.io/specification/2026-07-28/changelog
  - tools https://modelcontextprotocol.io/specification/2026-07-28/server/tools
  - progress https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/progress
  - cancellation https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation
  - TypeScript SDK https://github.com/modelcontextprotocol/typescript-sdk
  - filesystem server https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
  - registry https://modelcontextprotocol.io/registry/quickstart
  - MCPB bundles https://github.com/modelcontextprotocol/mcpb
- **Tool design:** https://www.anthropic.com/engineering/writing-tools-for-agents
- **Clients:** https://code.claude.com/docs/en/mcp · https://cursor.com/docs/mcp · https://code.visualstudio.com/docs/agents/reference/mcp-configuration · https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- **Node release schedule:** https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- **npm unpublish policy:** https://docs.npmjs.com/policies/unpublish

---

## Appendix A. Detailed design (LLD)

This is the starting design. Where the build finds something better, `docs/architecture.md` records what was actually built.

### A.1 Project layout

```
squoosh-mcp/
├── src/
│   ├── index.ts              # bin entry: args/env → allowed dirs; serveStdio(createServer)
│   ├── server.ts             # createServer(): registers tools; allowed dirs in descriptions
│   ├── schemas.ts            # zod 4 input/output schemas (authoritative tool contracts)
│   ├── tools/                # analyze.ts, optimize.ts, jobs.ts (get/cancel), compare.ts
│   └── core/
│       ├── paths.ts          # sandbox: realpath, containment, symlinks, outputs, home/root guard
│       ├── discover.ts       # paths/globs → files; input allow-list; skips our output dirs and *.tmp-*
│       ├── analyze.ts        # header facts; deep features → class + confidence
│       ├── planner.ts        # effective settings per file; candidates; full output map with collisions resolved
│       ├── codecs/           # types.ts (adapter), jpeg, webp, avif, png, quantize (two quantisers), oxipng, gif
│       ├── resize.ts         # fit, crop strategies, linear light, widths
│       ├── metric/           # ssim2.ts (pool API), worker.ts, ssim2.wasm (committed build)
│       ├── search.ts         # quality / colour-count search
│       ├── pipeline.ts       # one image end to end; global pool with a pixel budget
│       ├── jobs.ts           # module-wide job store; dedupe; budgets; long-poll; cancel; TTL
│       └── output.ts         # atomic writes, journal, lock, manifest compaction, markup
├── wasm/ssim2/               # Rust crate: fast-ssim2 (exact version) behind wasm-bindgen
├── test/                     # vitest unit tests + fixture generator
├── bench/                    # T1 comparison harness (BD-rate against the Squoosh baseline)
└── docs/
```

### A.2 Tool contracts (summary; `schemas.ts` is authoritative)

**`analyze_images`**
- Input:
  - `paths: string[]` (files, folders or globs)
  - `recursive = true`
  - `deep = false`
  - `offset`, `limit` (50 at most when `deep`)
  - `response_format: concise | detailed`
- Output:
  - `summary`: counts by format (and by class when `deep`), and total bytes
  - `items[]`, paged. Each item has `path`, `format`, `width`, `height` (after orientation), `bytes`, `hasAlpha` and `animated`. With `deep`, it adds `alphaUsed`, `colourCountCapped`, `class`, `confidence` and the `auto` plan.

**`optimize_images`**
- Input:
  - `paths: string[]`, and/or `files: { path, ...settings }[]`. Settings resolve in this order: top level, then per file.
  - `policy: auto (WebP) | avif | keep | picture` (D3)
  - `target: small | balanced | high | lossless-look | number (30–99, 100 = lossless)` (D4)
  - `resize: { maxWidth?, maxHeight? }`
  - `crop: { width, height, strategy: attention | entropy | center }`
  - `widths: number[] | "auto"`
  - `priority` (markup)
  - `metadata: strip | copyright | all`, default `strip`
  - `urlBase`
  - `dryRun = false`
  - `response_format`
- Output (`JobView`):
  - `jobId`, `status: queued | running | completed | cancelled | failed`
  - `done`, `total`, `bytesBefore`, `bytesAfter`, `savedPct`, `byFormat`, `manifestPath`
  - `items[]`, paged. Each item has `source`, `outputs[]` (`path`, `format`, `width`, `height`, `bytes`, `quality`, `score`), `decision` (`class`, candidates tried, reason, `targetNotMet?`) and `error?` with a fix hint.

**`get_job`**: `jobId`, `waitSeconds` (0–45), `offset`, `limit`.

**`cancel_job`**: `jobId`.

**`compare_images`**
- Input: `original`, `candidate`, `preview = false`.
- Output: `score`, a band (`visually-lossless` ≥ 90, `excellent` ≥ 85, `very-high` ≥ 80, `high` ≥ 70, `medium` ≥ 50, `low`), both sizes and dimensions.
- With `preview`: two thumbnails of at most 512 px, as image content.

### A.3 Classifier (starting heuristics, tuned in T1)

**Orientation:** dimensions always come from `metadata().autoOrient`, because plain `width`/`height` ignore EXIF orientation (sharp typings).

| Feature | How |
|---|---|
| `alphaUsed` | `stats().isOpaque` is false |
| `uniqueColours` | A capped hash set over the full image, with early exit at 4,097. Above 16 MP, a nearest-neighbour sample instead |
| `flatRatio` | Share of pixels whose 3×3 neighbourhood has zero variance, on an **area-averaged** downscale (longest side 1024) |
| `hardEdgeRatio` | Share of neighbouring pixel pairs whose brightness differs by more than 64 out of 255, on the same downscale |
| `entropy` | `stats().entropy` |
| `pages` | Frame count; animated PNG is detected and kept as is, with a message |

| Class | Rule (first match wins) |
|---|---|
| animated | `pages > 1` |
| icon | longest side ≤ 256 and `uniqueColours ≤ 256` |
| graphic | `uniqueColours ≤ 256`, or `flatRatio > 0.6` and `entropy < 4` |
| screenshot | `flatRatio > 0.35` and `hardEdgeRatio > h` (h set in T1) |
| photo | everything else |

- **Confidence** is the smallest normalised distance to any threshold: |value − threshold| / threshold, capped at 1. Below 0.3, the planner adds the next class's candidates.
- **Chroma rule:** 4:2:0 is banned when `hardEdgeRatio > h/2` or `uniqueColours < 1024`, whatever the class.
- **Accepted inputs** (D6, D14): JPEG, PNG, WebP, AVIF, GIF and TIFF. HEIC, SVG, BMP, ICO and animated PNG each get a clear refusal or "kept as is" message.

### A.4 Encoder settings (sharp 0.35.5)

| Codec | Settings | Squoosh equivalent and notes |
|---|---|---|
| JPEG | `jpeg({ quality, mozjpeg: true })`; `chromaSubsampling: '4:4:4'` when the chroma rule applies | MozJPEG: trellis, overshoot deringing, optimised scans, quant table 3, progressive |
| WebP lossy | `webp({ quality, effort: 4 })`; `smartSubsample` evaluated in T1 | quality 75, method 4. sharp's `effort` is libwebp's method |
| WebP lossless | `webp({ lossless: true, effort: 6 })`; palette-reduced variant: quantise first, then lossless | Squoosh lossless; quantise preprocessing |
| AVIF | `avif({ quality, effort: 3 → 4, chromaSubsampling, tune: 'iq' })` (D16) | Squoosh quality 50, speed 6. sharp effort = 9 − aom speed |
| PNG palette | `png({ palette: true, quality, dither })` or `pngQuantize`, then OxiPNG (D17) | Squoosh: libimagequant at 256 colours, dither 1.0, then OxiPNG |
| PNG lossless | `png({ compressionLevel: 1 })` (fast), then `losslessCompressPng` | OxiPNG 10 with @napi-rs/image's preset (no level option) |
| GIF (`keep` only) | `gif({ effort: 10 })` from the animated input | n/a |

**Trap:** in sharp, setting `quality`, `effort`, `colours` or `dither` on `png()` **turns palette mode on**. One benchmark row fell into this; lossless PNG must set none of them.

**Codec limits:** WebP allows at most 16,383 px per side. Candidates that exceed a codec's limits are removed before encoding.

### A.5 Quality search
For each output size and candidate codec:
1. **Reference:** process the SSIMULACRA 2 reference once from the resized source.
   - Transparent sources are scored in RGBA (two backgrounds, double the cost).
   - Wide-gamut sources are scored as Display P3; 16-bit sources at 16 bits.
   - Above 2.3 MP, score two 1024 px tiles, the centre and the most detailed (R2, as built).
2. **Start** at `q0` from a table indexed by codec, class and target, seeded from the benchmarks and tuned in T1.
3. **Encode, decode and score** at the search effort. Every point is recorded as (quality, score, bytes).
4. **Narrow down** while the bracket is wider than 2 quality steps and fewer than 6 encodes have run:
   - Use secant interpolation between the points on either side of the target.
   - If a new point contradicts the bracket (the score is not monotonic), fall back to bisection.
   - Ranges by codec: JPEG 30–98, WebP 30–100, AVIF 20–99.
5. **Pick** the smallest measured point at or above the target. If none qualifies, take the highest-scoring point and flag `targetNotMet`. A flagged candidate never beats one that met the target.
6. **Final encode:** re-encode the winner at its final effort and score it once more. If it drops below the target, step the quality up once.

**Candidate pruning:** probe every candidate at `q0`, estimate each one's size at the target from the probe, and run the full search only for the two best.

**Lossless candidates** are encoded once and **scored once too**. CMYK conversion, ICC conversion, bit-depth reduction (lossless WebP is 8-bit) or alpha changes can make "lossless" output differ from the source.

**Time budget per image:** 60 s plus 2 s per megapixel. When the budget runs out, the best measured result is used and flagged rather than failing.

### A.6 Resizing and responsive widths
- **Order:** `autoOrient` → crop or resize → colour handling → encode.
- **Fit:** `resize: {maxWidth, maxHeight}` fits inside the box with `withoutEnlargement`, using lanczos3.
- **Linear light:** T1 compares `.gamma()` (pure power 2.2; turns off shrink-on-load for JPEG and WebP input, which is slower on large JPEGs) with `pipelineColourspace('scrgb')` (true linear). The default before T1 is `.gamma()`, which is closest to Squoosh.
- **Crop:** `crop: {width, height, strategy}` uses sharp's `cover` with `attention` or `entropy` positioning. It can be set at the top level or per file.
- **Widths:** `widths: "auto"` uses 640, 960, 1280, 1920 and 2560, minus any wider than the source and any within 15% of the next. The capped source width is always included. Each width's search starts from the next larger width's result.

### A.7 Output, journal, manifest and markup
- **Output map:** the planner builds every output path before any encoding starts.
  - Keys are compared NFC-normalised and lower-cased, so case-insensitive file systems are safe.
  - Clashes are resolved deterministically in sorted source order: the first file keeps `photo.avif`, and the others get the source extension added (`photo-png.avif`).
  - A width suffix `-<w>w` is added only when there are several widths, and also passes through the clash check.
- **Atomic writes:** each file is written as `*.tmp-<random>`, then renamed into place. On Windows, the rename is retried with backoff. Leftover `*.tmp-*` files are cleaned up at startup and skipped during discovery.
- **Journal:** `optimized/.squoosh-journal.jsonl` gets one line per finished output, written only after the rename. A single writer queue per output folder handles it, and `optimized/.squoosh.lock` (pid and start time) blocks a second process.
- **Manifest:** at job end the journal is compacted into `optimized/squoosh-manifest.json` (temp file plus rename). After a crash, the journal is replayed on the next run. An existing output that appears in neither file is not ours: it is left alone and reported with a fix hint.
- **Paths:** every path in the manifest and markup is POSIX or a URL.
- **Markup** per image (D19):
  - a `<picture>` element with one `<source type srcset sizes>` per modern format,
  - then an `<img>` carrying the fallback (with `picture`) or the best modern format, plus `width`, `height`, `loading`, `decoding="async"` and `fetchpriority` when `priority` is set.

### A.8 Jobs, concurrency, progress
- **Job store:** module-level, shared across the process.
  - At most 2 jobs run at once; more are `queued` (first in, first out, up to 8, then refused).
  - Finished jobs expire after 1 hour.
  - A call identical to a running or queued job (same argument hash) returns that job's `jobId`.
  - A job whose output paths overlap a running job's is refused with a message.
- **Inline phase:** `optimize_images` waits up to `SQUOOSH_MCP_INLINE_SECONDS` (default 45). If the client cancels the request or times out in that window, the job **keeps running**. The agent's retry attaches to it through the duplicate check, so no work is lost or duplicated. `cancel_job` is the only way to stop a job.
- **Pool:** global, not per job.
  - At most `min(4, cores/2)` images run at once, within a global pixel budget (64 MP to start). An image larger than the whole budget runs alone.
  - `sharp.concurrency(max(1, floor(cores / slots)))` avoids starting more threads than there are cores. The thread pool (`UV_THREADPOOL_SIZE`) stays at Node's default of 4: the research measured no gain from raising it.
- **Metric:** a `worker_threads` pool, the same size as the image pool.
- **Progress:** sent at most 4 times a second, with `progress`, `total` and the current file name.
- **Logging:** stderr only.

### A.9 Safety limits (starting values; each can be changed with an environment variable)

| Limit | Start |
|---|---|
| Discovered files per call | 10,000 |
| Argument size (`maxToolInputElements`: array elements plus object members) | 20,000 |
| Input file size | 256 MB |
| Pixels per image or per animation frame | 268 MP (sharp's `limitInputPixels` default), checked per frame for animations |
| Per-image time budget | 60 s + 2 s per MP (A.5) |
| Glob depth | 32 |

Path checks follow the filesystem server's `path-validation.ts`:
- Reject null bytes.
- Run `realpath` on both the allowed folder and the target.
- Check containment with `dir + sep`.
- Check every output path and its parent.
- Refuse the home folder and filesystem roots as an allowed folder via the fallback.
- On Windows, treat backslashes in globs as path separators.

### A.10 Package and release
- **`package.json`:**
  - `name: squoosh-mcp`, `type: module`, `bin: { "squoosh-mcp": "dist/index.js" }` (with a shebang), `files: ["dist"]`, `engines: { node: ">=22.17.0" }`, `mcpName: io.github.<owner>/squoosh-mcp`
  - exact dependencies: `sharp 0.35.5`, `@modelcontextprotocol/server 2.4.0`, `zod 4.x.y`, `@napi-rs/image 1.16.0`, `@jsquash/oxipng` (fallback only)
  - `npm-shrinkwrap.json` committed
- **Build:** `tsc`, then copy `ssim2.wasm` into `dist/`, then `chmod +x dist/index.js`.
- **CI:** a GitHub Actions matrix of Ubuntu, macOS and Windows on Node 22, 24 and 26 runs build, tests, and the WASM rebuild-and-compare check. The release workflow runs only on a tag you create: `npm publish --provenance`, then `mcp-publisher` with GitHub OIDC.
- **Notices:** `THIRD_PARTY_NOTICES` lists fast-ssim2 (BSD-2, bundled as WASM), and sharp/libvips (Apache-2.0 / LGPL-3.0, installed as dependencies, not bundled).

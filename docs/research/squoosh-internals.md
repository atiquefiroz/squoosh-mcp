# Squoosh, libsquoosh and successors: verified research

Date checked: 2026-11-02. Every claim below comes from source code (shallow clones), the GitHub REST API, the npm registry (`npm view`, `npm search`, api.npmjs.org download counts), or the live squoosh.app. Things I could not verify are marked **UNVERIFIED** and listed again in section 8.

Local clones (depth 1), kept for re-checking:

| Clone | Branch | HEAD |
|---|---|---|
| `repos/squoosh` | `dev` (default; matches the live app) | `e8d35e0f` 2024-08-19 |
| `repos/squoosh-update-codecs` | `ja/update-codecs` (open PR #1473) | `84e955b3` 2026-10-22 |
| `repos/jsquash` | `main` | `da47a2be` 2026-01-05 |

(These were shallow clones in a temporary research folder and are not kept in this repo; the commit hashes above pin what was read.)

---

## 0. Key facts

- **libsquoosh and the CLI were deprecated and then deleted on 2023-01-03**, because of staffing cuts. The last npm releases are `@squoosh/lib` 0.5.3 and `@squoosh/cli` 0.7.3, both dated 2023-01-03. Neither is flagged `deprecated` on npm, and `@squoosh/lib` still gets about 14k downloads a week. Its declared engines stop at Node 16.
- **The web app is "maintained" but has shipped nothing since August 2024.** `dev` was last touched on 2024-08-19, and squoosh.app still serves that build (checked via its service worker). In 2026, however, there is substantial *unmerged* work. Jake Archibald's PR #1473 (44 commits, May–Oct 2026) rebuilds every codec, makes **jpegli** the default JPEG encoder, adds **jixel** (a Rust JPEG XL encoder) and **SSIMULACRA 2**, and drops WebP2 and the browser encoders.
- **jSquash is the de facto successor for JS.** It has 8 packages and a combined ~2.2M downloads a week. It is browser-first, Node support is "limited/experimental", and **in Node every codec runs single-threaded** (enforced in code). It ships the *same old codec builds* as Squoosh `dev` (libwebp from 2020, MozJPEG 3.3.1 from 2018, a libjxl commit from Jan 2022). It has no palette-quantise (imagequant) and no rotate package. The one maintainer last merged on 2026-01-05, and community PRs from 2026 are sitting unmerged.
- **No libsquoosh fork is both healthy and widely used.** The candidates are @frostoven (last release Apr 2024), @bit-blazer (Jun 2026, ~33 downloads a week), @squoosh-kit (Sep 2026, Bun-first), squoosh-next (Jun 2025) and @movable (Feb 2026).

---

## 1. GoogleChromeLabs/squoosh: current state

### 1.1 Repo status (GitHub API, 2026-11-02)

| Field | Value | Source |
|---|---|---|
| Default branch | `dev` | api.github.com/repos/GoogleChromeLabs/squoosh |
| Archived | false | same |
| Stars / open issues+PRs | 26,088 / 262 | same |
| `pushed_at` | 2026-10-22T17:16:21Z. This is the PR #1473 branch push, not `dev`. | same + PR #1473 `updated_at` 2026-10-22T17:16:24Z |
| Last commit on `dev` | `e8d35e0f` 2024-08-19, Surma, "Replace deprecated terser plugin (#1423)" | `git log` in clone; /commits API |
| Previous | `5f72c2ed` 2024-08-13, Jamie, "Fix single threaded avif encoding (#1409)" | /commits API |
| `live` branch (deploy) | `5f72c2ed` 2024-08-13 | /commits/live API |
| Other 2024 work | oxipng → v9 (PR #1396, Mar 2024); libavif update (#1381, Jan 2024); QOI added (#1384, Oct 2023) | /commits API |

**Is the live app current?** squoosh.app returns HTTP 200 from Netlify with `cross-origin-opener-policy: same-origin` and `cross-origin-embedder-policy: require-corp`, which is what wasm threads need. Its `serviceworker.js` caches `mozjpeg_enc-*.wasm`, `wp2_enc_mt_simd-*.wasm`, `avif_dec-*.wasm` and similar files, with no jpegli or jixel. So the live site is the 2024 `dev`/`live` build.

### 1.2 2026 activity (not on `dev`)

**PR #1473 "Updating AVIF & JXL"** (https://github.com/GoogleChromeLabs/squoosh/pull/1473)
- Author: Jake Archibald. State: open, not merged.
- Created 2026-05-29, updated 2026-10-22.
- 44 commits, 265 changed files. Branch `ja/update-codecs`.
- Selected commits:
  - "Add SSIMULACRA 2 metric 'easter egg'" (06-01)
  - "Add JPEGLI" (06-01)
  - "Remove AVIF decoder and simplify encoder build" (06-02)
  - "Simple but modern JXL encoder & decoder" (06-03)
  - "Update all codec builds" (08-27)
  - "Make JPEGLI the default" (08-27)
  - "Update resizers" (09-09)
  - "Update quantizer" (09-10)
  - "Add JPEG to JXL transcoding" (09-14)
  - "Add jixel" (10-15)
  - "Order codecs, and remove browser ones" (10-22)
- Full details are in section 4.

**Branch `spike/ben2-ort-webgpu-netlify`**
- Surma, 39 commits ahead of `dev`, 2026-07-15 to 07-17.
- Adds `src/features/processors/ben2/*`, a background-removal processor using the BEN2 model.
- **UNVERIFIED:** "ort-webgpu" in the branch name suggests ONNX Runtime with WebGPU. I did not read the code.

Recent community PRs (all open): #1501 "Add alpha-only palette reduction", #1493, #1498–1500. #1505 "Vue rewrite" was closed on 2026-11-01.

### 1.3 libsquoosh and @squoosh/cli: deprecated, then removed

Two commits, both on **2023-01-03**:

**1. `918c596c` "Add no-longer-maintained message to cli and libsquoosh"** (jakearchibald)
- Bumps `@squoosh/cli` 0.7.2 → 0.7.3 and `@squoosh/lib` → 0.5.2.
- Adds this to `cli/README.md` and `libsquoosh/README.md`:

  > # Project no longer maintained
  >
  > Unfortunately, due to a few people leaving the team, and staffing issues resulting from the current economic climate (ugh), this package is no longer actively maintained. I know that sucks, but there simply isn't the time & people to work on this. If anyone from the community wants to fork it, you have my blessing. The [squoosh.app](https://squoosh.app) will continue to be supported and improved.

  Source: https://github.com/GoogleChromeLabs/squoosh/commit/918c596cba36a46ff3d7aa8ffd69580bd22528e2

**2. `13a185de` "Remove CLI / libsquoosh (#1321)"** (Jake Archibald). Commit message:

  > Unfortunately, due to a few people leaving the team, and staffing issues resulting from the current economic climate (ugh), I'm deprecating the CLI and libsquoosh parts of Squoosh. The web app will continue to be supported and improved. I know that sucks, but there simply isn't the time & people to work on this. If anyone from the community wants to fork it, you have my blessing.

  Source: https://github.com/GoogleChromeLabs/squoosh/commit/13a185de (found via `/commits?path=libsquoosh`)

**npm status** (`npm view`):

| Package | Latest | Published | engines | `deprecated` flag | Weekly downloads |
|---|---|---|---|---|---|
| `@squoosh/lib` | 0.5.3 | 2023-01-03 | node `^12.5.0 \|\| ^14.0.0 \|\| ^16.0.0` | **not set** | 14,071 |
| `@squoosh/cli` | 0.7.3 | 2023-01-03 | node `^12.20.2 \|\| ^14.13.1 \|\| ^16.0.0` | **not set** | 2,118 |

**What libsquoosh did at removal.** This is the source as of `918c596c`:
- https://github.com/GoogleChromeLabs/squoosh/blob/918c596cba36a46ff3d7aa8ffd69580bd22528e2/libsquoosh/src/codecs.ts
- https://github.com/GoogleChromeLabs/squoosh/blob/918c596cba36a46ff3d7aa8ffd69580bd22528e2/libsquoosh/src/auto-optimizer.ts
- https://github.com/GoogleChromeLabs/squoosh/blob/918c596cba36a46ff3d7aa8ffd69580bd22528e2/libsquoosh/src/index.ts

Its features:
- `ImagePool(n)`, a worker-thread pool. Its README warns to create only one pool, or it "can run out of memory and crash".
- Preprocessors: `resize`, `quant` (imagequant), `rotate`.
- Encoders: mozjpeg, webp, avif, jxl, wp2, oxipng. Each used Node-specific Emscripten builds (`*_node_enc.wasm`), and AVIF also had an MT build (`avif_node_enc_mt`).
- **Auto-optimiser.** Pass `'auto'` as the codec config and it binary-searches one parameter until the Butteraugli distance hits a goal.
  - Defaults: `butteraugliDistanceGoal = 1.4`, `maxRounds = 6`, `epsilon = 0.1` (auto-optimizer.ts:47,76; index.ts:258-261).
  - Parameter searched, per codec (codecs.ts `autoOptimize`):

    | Codec | Parameter | Range |
    |---|---|---|
    | mozjpeg | quality | 0→100 |
    | webp | quality | 0→100 |
    | avif | cqLevel | 62→0 (pre-libavif-1.0 API) |
    | jxl | quality | 0→100 |
    | wp2 | quality | 0→100 |
    | oxipng | level | 6→1 |

Stale Node builds from that era still sit in `dev`: `codecs/{mozjpeg,avif,jxl}/*/*_node_*.wasm` and `codecs/imagequant/imagequant_node.wasm`. PR #1473 removes them.

---

## 2. Web-app codecs and encoder defaults (`dev`, matching squoosh.app)

**Encoder directories:** `src/features/encoders/{avif,browserGIF,browserJPEG,browserPNG,jxl,mozJPEG,oxiPNG,qoi,webP,wp2}`.

**Wasm decoders** (`src/features/decoders`): avif, jxl, qoi, webp, wp2. JPEG, PNG and GIF decoding goes through the browser.

**Default output.** The right-hand side defaults to `mozJPEG` with its defaults (`src/client/lazy-app/Compress/index.tsx:310`).

**Browser encoders** are listed only if `canvasEncodeTest(mime)` passes (`Compress/Options/index.tsx:55`).

### 2.1 Codec overview

Library versions come from each `codecs/<x>/Makefile` or `Cargo.toml`. Threading comes from each `src/features/encoders/<x>/worker/*.ts`.

| Key | UI label | MIME / ext | Library (pinned) | Threads / SIMD in app |
|---|---|---|---|---|
| `mozJPEG` | MozJPEG | image/jpeg .jpg | mozjpeg **v3.3.1** (released 2018-03-17) | single-thread |
| `webP` | WebP | image/webp .webp | libwebp commit `d2e245ea` (**2020-11-24**) | SIMD build if `simd()`; no threads |
| `avif` | AVIF | image/avif .avif | libavif **v1.0.1** + libaom **v3.7.0**; libwebp sharpyuv | MT build if threads supported; `maxThreads = emscripten_num_logical_cores()` |
| `jxl` | JPEG XL (beta) | image/jxl .jxl | libjxl commit `9f544641` (**2022-01-18**) | `jxl_enc_mt_simd` / `jxl_enc_mt` / single |
| `wp2` | WebP v2 (unstable) | image/webp2 .wp2 | libwebp2 commit `413df7ca` | `wp2_enc_mt_simd` / `wp2_enc_mt` / single |
| `oxiPNG` | OxiPNG | image/png .png | Rust `oxipng` **9.0** (wasm-bindgen) | `pkg-parallel` + `initThreadPool(navigator.hardwareConcurrency)` |
| `qoi` | QOI | image/qoi .qoi | phoboslab/qoi `8d35d93` (2023-09-10) | single |
| `browserPNG` | Browser PNG | image/png | canvas `toBlob` | n/a |
| `browserJPEG` | Browser JPEG | image/jpeg | canvas `toBlob` | n/a |
| `browserGIF` | Browser GIF | image/gif | canvas `toBlob` | n/a |

Library dates were checked via the GitHub API: mozilla/mozjpeg release v3.3.1, plus the commit dates of webmproject/libwebp, libjxl/libjxl and phoboslab/qoi.

### 2.2 MozJPEG: `src/features/encoders/mozJPEG/shared/meta.ts`

| Option | Default | UI range / meaning (`client/index.tsx`, `codecs/mozjpeg/enc/mozjpeg_enc.cpp`) |
|---|---|---|
| quality | **75** | 0–100. Passed to mozjpeg `set_quality_ratings()` (enc.cpp:147-156). |
| baseline | false | |
| arithmetic | false | |
| progressive | **true** | |
| optimize_coding | true | |
| smoothing | 0 | 0–100 |
| color_space | **YCbCr (3)** | enum: 1 = GRAYSCALE, 2 = RGB, 3 = YCbCr |
| quant_table | **3 (ImageMagick)** | 0–8: Annex K, Flat, MSSIM-tuned Kodak, ImageMagick, PSNR-HVS-M Kodak, Klein, Watson, Ahumada, Peterson |
| trellis_multipass | false | |
| trellis_opt_zero | false | |
| trellis_opt_table | false | |
| trellis_loops | **1** | 1–50 |
| auto_subsample | **true** | When true, mozjpeg chooses. |
| chroma_subsample | 2 | 1–4. Used only if `auto_subsample=false` and YCbCr; sets h/v sampling of comp 0 (enc.cpp:158-164). |
| separate_chroma_quality | false | If true and YCbCr, the quality string becomes `"q,chroma_q"`. |
| chroma_quality | 75 | 0–100 |

### 2.3 WebP: `src/features/encoders/webP/shared/meta.ts`

These defaults mirror libwebp's `WebPConfig`:
- `quality: 75`, `method: 4`
- `sns_strength: 50`, `filter_strength: 60`, `filter_sharpness: 0`, `filter_type: 1`, `autofilter: 0`
- `partitions: 0`, `segments: 4`, `pass: 1`, `preprocessing: 0`, `partition_limit: 0`
- `target_size: 0`, `target_PSNR: 0`, `show_compressed: 0`
- `alpha_compression: 1`, `alpha_filtering: 1`, `alpha_quality: 100`
- `lossless: 0`, `exact: 0`, `image_hint: 0`, `emulate_jpeg_size: 0`
- `thread_level: 0`, `low_memory: 0`
- `near_lossless: 100`, `use_delta_palette: 0`, `use_sharp_yuv: 0`

UI (`client/index.tsx`):
- quality 0–100, step 0.1.
- method ("effort") 0–6.
- **Lossless** uses a preset slider 0–9 (default **6**). Each preset sets `[method, quality]`, copied from libwebp `kLosslessPresets`: `[0,0] [1,20] [2,25] [3,30] [3,50] [4,50] [4,75] [4,90] [5,90] [6,100]`.
- Near-lossless slider 0–100. It displays `100 - near_lossless`.
- Alpha quality 0–100; alpha filter 0–2.
- Filter strength 0–100; sharpness 0–7; passes 1–10; SNS 0–100.
- Preprocessing: 0 None, 1 Segment smooth, 2 Pseudo-random dithering.
- Segments 1–4; partitions 0–3.

### 2.4 AVIF: `src/features/encoders/avif/shared/meta.ts`

| Option | Default | Meaning (`client/index.tsx`, `codecs/avif/enc/avif_enc.cpp`) |
|---|---|---|
| quality | **50** | 0–100. UI caps it at 99; 100 means lossless. |
| qualityAlpha | -1 | -1 means "same as quality". |
| speed | **6** | 0 (slowest) to 10. UI shows **effort = 10 − speed**, so the default effort is **4**. |
| subsample | **1 (4:2:0)** | 0 = 4:0:0, 1 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4. Lossless forces 3. |
| chromaDeltaQ | false | Shown only for 4:2:0. |
| sharpness | 0 | 0–7 (aom `sharpness`) |
| denoiseLevel | 0 | 0–50 (`color:denoise-noise-level`) |
| tileRowsLog2 / tileColsLog2 | 0 / 0 | 0–6 (2^n tiles) |
| tune | **auto (0)** | auto/psnr/ssim. **auto means `tune=ssim` when quality ≥ 50** (enc.cpp:123). |
| enableSharpYUV | false | |

Lossless requires `quality == 100 && (qualityAlpha == -1 || 100) && 4:4:4` (enc.cpp:76-78).

### 2.5 JPEG XL: `src/features/encoders/jxl/shared/meta.ts` (label "JPEG XL (beta)")

| Option | Default | Meaning (`client/index.tsx`) |
|---|---|---|
| effort | **7** | 1–9 |
| quality | **75** | 0–99.9, step 0.1. 100 means lossless. |
| progressive | false | |
| epf | -1 (auto) | Edge-preserving filter 0–3 |
| lossyPalette | false | Lossless only ("slight loss") |
| decodingSpeedTier | 0 | 0–4 |
| photonNoiseIso | 0 | 0–50000, step 100 |
| lossyModular | false | **Forced true when quality < 7** |

### 2.6 WebP v2: `src/features/encoders/wp2/shared/meta.ts` (label "WebP v2 (unstable)")

Defaults:
- `quality: 75`, `alpha_quality: 75`
- `effort: 5` (UI 0–9)
- `pass: 1` (1–10)
- `sns: 50` (0–100)
- `uv_mode: UVModeAuto`. Enum: 0 Adapt ("Vary"), 1 420 ("Half"), 2 444 ("Off"), 3 Auto.
- `csp_type: kYCoCg`. Enum: YCoCg, YCbCr, Custom, YIQ.
- `error_diffusion: 0` (0–100)
- `use_random_matrix: false`

UI: quality 0–95 for lossy. Above 95 means "lossless with slight loss" (slider 0–5, `quality = 100 − slightLoss`).

### 2.7 OxiPNG, QOI and browser encoders

| Encoder | Defaults | Notes |
|---|---|---|
| OxiPNG | `level: 2`, `interlace: false` | UI level 0–6 (`oxipng::Options::from_preset(level)`). **`optimize_alpha = true` is hard-coded** (`codecs/oxipng/src/lib.rs`). Interlace means Adam7. |
| QOI | `{}` | No options |
| Browser JPEG | `quality: 0.75` | Canvas encoder, 0–1 |
| Browser PNG / GIF | `{}` | Canvas encoder |

---

## 3. Preprocessors and processors (`dev`)

All processors default to `enabled: false` (`lib/feature-plugin.js:237`).

### 3.1 Resize: `src/features/processors/resize/shared/meta.ts`, worker `.../worker/resize.ts`

| Option | Default | Values |
|---|---|---|
| method | **`lanczos3`**, or `vector` when the input is SVG (`Compress/index.tsx:713`) | worker: `triangle`, `catrom`, `mitchell`, `lanczos3`, `hqx`; browser: `browser-pixelated`, `browser-low`, `browser-medium`, `browser-high`; `vector` (SVG re-render) |
| width / height | set to the image size elsewhere | |
| fitMethod | `stretch` | `stretch` or `contain`. Contain crops the source to the target aspect ratio (centred), then scales. |
| premultiply | **true** | worker methods only |
| linearRGB | **true** | worker methods only |

Implementation:
- `codecs/resize` is the Rust crate **`resize` 0.5.5**, built with wasm-bindgen. The method index is triangle 0, catrom 1, mitchell 2, lanczos3 3.
- `hqx` comes from `codecs/hqx`: Rust `hqx` from `CryZe/wasmboy-rs` tag v0.1.3. Its scale factor is clamped to 1–4×, then a `catrom` resize makes up the difference to the target size.
- Browser methods use canvas on the main thread (`client/index.tsx`).
- **Caveat for porting:** `crop()` in `resize.ts` runs `copyWithin` on a `Uint32Array` view of the *input* buffer, so contain mode mutates the caller's pixels. This is harmless in Squoosh, because the worker gets a copy, but jSquash has the same bug (section 5.4).

### 3.2 Palette reduction (quantize): `src/features/processors/quantize/shared/meta.ts`

| Option | Default | UI |
|---|---|---|
| maxNumColors | **256** | 2–256 |
| dither | **1.0** | 0–1, step 0.01 |
| zx | 0 | ZX-Spectrum palette mode (`zx_quantize`) |

Implementation: `codecs/imagequant/imagequant.cpp` is **libimagequant 2.12.1** (C), built with Emscripten (`liq_set_max_colors`, `liq_set_dithering_level`).

### 3.3 Rotate (preprocessor): `src/features/preprocessors/rotate/shared/meta.ts`

`rotate: 0 | 90 | 180 | 270`, default 0. Implementation: `codecs/rotate/rotate.rs`, the Rust crate `squoosh-rotate`, compiled to a raw `rotate.wasm` that `worker/rotate.ts` loads by URL.

### 3.4 Other

`codecs/visdif` is Butteraugli (google/butteraugli `71b18b6`). It was used by libsquoosh's auto-optimiser. Grep of `src/` and `lib/` on `dev` finds no references, so the web app does not use it.

---

## 4. What's coming: PR #1473 branch `ja/update-codecs` (UNMERGED, may change)

**Encoders:** `avif`, `jixel`, `jpegli`, `jxl`, `mozJPEG`, `oxiPNG`, `qoi`, `webP`. **WP2 and browserPNG/JPEG/GIF are removed.**
**Decoders:** `jxl`, `qoi` only. AVIF and WebP decoding move to the browser.
**New codec directories:** `codecs/jpegli`, `codecs/jixel`, `codecs/ssimulacra2`, `codecs/brotli`, `codecs/visdif`.
**Default encoder:** **`jpegli`** (`Compress/index.tsx:438`).

| Library | dev | PR #1473 |
|---|---|---|
| libavif / libaom | 1.0.1 / 3.7.0 | **v1.4.2 / v3.15.0** |
| libwebp | 2020-11 commit | **v1.6.0** |
| libjxl | 2022-01 commit | **v0.12.0** |
| mozjpeg | 3.3.1 | **v4.1.5** |
| jpegli | n/a | commit `031a0077` (+ highway, libjpeg-turbo, skcms) |
| jixel | n/a | crate **0.4.2** (awxkee/jixel; Rust JXL encoder "ported and reworked from libjxl-tiny") |
| oxipng | 9.0 | **10.2 + zopfli** |
| imagequant | C 2.12.1 | **Rust `imagequant` 4.4**, single-threaded build |
| resize | `resize` 0.5.5 | **`fast_image_resize` 6.1** |
| brotli | n/a | v1.1.0 (used to report the Brotli size of SVGs) |
| ssimulacra2 | n/a | yes. Commit note: "Perform SSIMULACRA on resized but not quantized image." |

### 4.1 New defaults (from each `shared/meta.ts` on the branch)

**jpegli** (label "JPEG (jpegli)"):
- `quality: 75` (UI 1–100)
- `progressiveLevel: 2`
- `chromaSubsampling: YCbCr420`. Enum: 444 = 0, 422, 440, 420.

**AVIF:**
- `quality: 50`, `qualityAlpha: -1`, `speed: 6`
- **`subsample: 3` (4:4:4), changed from 4:2:0**
- `aqMode: 0`
- `tune: auto`. The enum now also has `iq`.
- `enableSharpYUV: false`, `channelDepth: 8`, `premultiplyAlpha: false`
- Progressive: `progressive: false`, `progressiveQuality: 25`, `scalingMode: 1`, `blur: 0`, `postBlur: 0`, `previewProgressiveFrame: false`, `independentMainLayer: false`
- `tiling: AVIFTiling.auto`

**JXL (libjxl):**
- `quality: 75`, `qualityAlpha: -1`, `mode: 'lossy'` (one of lossy, lossless, transcode)
- `effort: 7` (UI 1–10)
- `modular: false`, `progressiveAC: false`, `qProgressiveAC: false`, `progressiveDC: 1`, `groupOrder: 0`
- `photonNoiseIso: 0`, `decodingSpeed: 0`
- `storeJpegMetadata: true`, `keepMetadata: true`
- Adds JPEG→JXL lossless transcode.

**jixel:**
- `mode: 'lossy'`, `quality: 75`
- `effort: 3` (1–6)
- `progressive: false`, `progressivePasses: 2`
- `patches: true`, `splines: false`, `dots: false`
- `lossyModular: 'off'`, `codingTransform: 'xyb'`, `learnedRate: true`
- `preserveTransparentData: false`, `decodingSpeed: 0`, `progressiveDC: false`, `groupOrder: 'scanline'`
- `arbiter: 'ssimulacra2'` (or `'cvvdp'`)
- `storeJpegMetadata: true`
- Its README says ExtraSlow lossy can exceed wasm32's 4 GB at around 10 MP and abort.

**MozJPEG** (label "JPEG (MozJPEG)"): the same as dev, but `arithmetic` is removed and it adds `trellis_quant: true`, `trellis_quant_dc: true` and `overshoot_deringing: true`.

**OxiPNG** (label "PNG (OxiPNG)"):
- `level: 2` (UI 0–7; **7 = preset 6 + Zopfli**)
- `interlace: false`
- `preserveAlpha: false`. This is new: off means oxipng may rewrite the RGB of fully transparent pixels.

**WebP:** the same core defaults, with these changes:
- **`thread_level: 1`** (was 0).
- `target_size`, `target_PSNR`, `show_compressed`, `partition_limit`, `emulate_jpeg_size`, `low_memory` and `use_delta_palette` are removed.

**Resize:**
- New methods `box`, `hamming`, `nearest`; `browser-*` methods removed.
- `lanczosRadius: 3`. The key stays named `lanczos3` for saved settings.
- `centeringX/Y: 0.5` (crop anchor for contain).
- premultiply and linearRGB still default to true.

**Quantize:**
- `mode: 'rgba' | 'alphaOnly' | 'zx'` (default `rgba`)
- `maxNumColors: 256`
- **`dither: 0`** (was 1.0). Comment: dithering "trades file size for smoother gradients… Off by default".
- `effort: 7` (1–10; "Equivalent to libimagequant's own default speed of 4").

---

## 5. jSquash (https://github.com/jamsinclair/jSquash)

### 5.1 Repo status

| Field | Value |
|---|---|
| Last commit on `main` | `da47a2be` **2026-01-05**: magic-kernel upgrade, resize 2.1.1 |
| Before that | 2025-11-08 (CDN URLs in the README), 2025-07-12 (jxl lossless option) |
| Stars / open issues+PRs | 740 / 28 |
| License | Apache-2.0 |
| Open, unmerged 2026 PRs | animated WebP (#103), HEIC decoder (#101), JPEG XR (#107), GIF decoder (#104), **libwebp 1.6.0 upgrade (#114)**, **resize corruption fix (#109)**, jpeg autoconf build fix (#110), AVIF types (#115, 2026-10-16) |

Assessment: one maintainer, releases now and then, and the community PR queue is growing. "Maintained, slowly" is fair. I am inferring that from the dates above.

### 5.2 Packages: npm data (`npm view <pkg> version time dist-tags --json`; downloads from api.npmjs.org, last week)

| Package | Latest | Published | Weekly DL | Upstream codec (from `packages/*/codec/Makefile` or `Cargo.toml`) | Extra dist-tags |
|---|---|---|---|---|---|
| `@jsquash/avif` | 2.1.1 | 2025-05-20 | 238,785 | libavif v1.0.1 + libaom v3.7.0 | `single-thread-only: 1.1.2-single-thread-only` |
| `@jsquash/jpeg` | 1.6.0 | 2025-05-12 | 432,457 | MozJPEG v3.3.1 | `beta: 1.5.0-beta.1` |
| `@jsquash/jxl` | 1.3.0 | 2025-07-12 | 12,001 | libjxl `9f544641` (2022-01-18) | `single-thread-only: 1.0.2-…` |
| `@jsquash/oxipng` | 2.3.0 | 2024-06-18 | 72,604 | oxipng 9.0 | `single-thread-only: 1.0.1-…`, `next: 2.0.0-rc.0` |
| `@jsquash/png` | 3.1.1 | 2025-05-20 | 472,834 | Rust `png` 0.17.10 | |
| `@jsquash/qoi` | 1.1.0 | 2025-05-12 | 1,432 | phoboslab/qoi `8d35d93` | |
| `@jsquash/resize` | 2.1.1 | **2026-01-05** | 178,952 | `resize` 0.5.5 + hqx v0.1.3 + `magic-kernel` 0.1.1 | |
| `@jsquash/webp` | 1.5.0 | 2025-05-12 | 841,308 | libwebp `d2e245ea` (2020-11-24) | `beta: 1.5.0-animated-webp-support-beta.2` (2025-08-11) |

**Not packaged:** imagequant (palette reduction), rotate, WebP2 and the browser encoders. A grep for `imagequant|quantiz` across packages, examples and the README finds nothing.

### 5.3 Defaults (`packages/*/meta.ts`)

These are the same as Squoosh `dev`, with these differences:
- **avif:** adds `bitDepth: 8` and `lossless: false`. Decode can return `bitDepth` 8/10/12/16 (`ImageData16bit`).
- **jxl:** adds `lossless: false`.
- **jpeg:** decode option `preserveOrientation: false` (EXIF rotation).
- **oxipng:** `{ level: 2, interlace: false, optimiseAlpha: false }`. Note that **`optimiseAlpha` defaults to false here, while Squoosh hard-codes true.** `optimise()` accepts an encoded PNG ArrayBuffer *or* ImageData (`optimise_raw`).
- **resize:** adds methods `magicKernel`, `magicKernelSharp2013` and `magicKernelSharp2021`. The default is still `lanczos3`, with premultiply and linearRGB true and fitMethod `stretch`.

### 5.4 Node.js support, threading and caveats

- **Official stance** (root README): "⚠️ There is limited support for Node.js environments. The experimental Node.js support is provided for convenience and is not the primary focus of this project. For much better Node based alternatives please check out the Squoosh Node.js library and Sharp." Also: "the WASM modules are not optimized for speed with Node.js."
- **The packages are ESM only** (README).
- **Manual wasm init is required in Node.** You read the `.wasm` with `fs`, call `WebAssembly.compile`, and pass the result to `init()` (`examples/with-node/index.js`). If you skip it, Emscripten's fetch fails (issue #61: "TypeError: fetch failed … not implemented… yet").
- **ImageData:** the Emscripten glue polyfills `globalThis.ImageData` when `process.release.name === 'node'` (e.g. `packages/jpeg/codec/dec/mozjpeg_dec.js`). Basic Node support landed in PR #40 (2023-11-20).
- **Threads in Node are off for every codec:**
  - AVIF and JXL load the `_mt` build only if `!isRunningInNode() && !isRunningInCloudflareWorker() && threads()` (`packages/avif/encode.ts:28-55`, `packages/jxl/encode.ts:28-58`).
  - OxiPNG goes multi-threaded only inside a browser `WorkerGlobalScope` with `hardwareConcurrency > 1` (`packages/oxipng/optimise.ts:50-63`), because "This is a caveat of threading library we use (wasm-bindgen-rayon)".
  - WebP picks a SIMD build via `wasm-feature-detect` and has no threads.
  - Parallelism in a Node MCP would therefore have to come from our own `worker_threads` pool.
- **In the browser,** multithreading needs a Web Worker plus COOP/COEP headers (`packages/avif/README.md` "Activate Multithreading"). The single-thread-only tags exist to work around a Vite nested-worker bug (issue #19).
- **Bug (open PR #109, 2026-08-10):** `@jsquash/resize` `crop()` "writes through to the caller's ImageData"; "Any resize with `fitMethod: 'contain'` destroys the image it was given". The same PR reports that contain + hqx crops the wrong region.
- **Stale codecs:** issue #112 (2026-08-30) says `@jsquash/webp` "still compiles libwebp from a November 2020 snapshot". I confirmed the pinned commit is dated 2020-11-24. Releases up to 1.5.0 only changed the JS glue.

### 5.5 jSquash forks on npm

| Package | Latest | Date | Weekly DL | Repo |
|---|---|---|---|---|
| `@discourse/webp` (also jpeg, jxl, oxipng, png, resize) | 1.5.0 | 2026-05-07 | 21,934 (webp) | github.com/discourse/jSquash (fork) |
| `@kittl/jpeg`, `@kittl/png` | 1.6.2 / 3.1.1 | 2026-04-20 / 2026-03-25 | 4,123 (jpeg) | jSquash repo URL |

**UNVERIFIED:** what these forks change.

---

## 6. libsquoosh continuations for Node on npm

Data comes from `npm search` + `npm view --json` + api.npmjs.org (last week) + GitHub API.

| Package | Latest | Published | engines | Weekly DL | Repo / activity | Notes |
|---|---|---|---|---|---|---|
| `@frostoven/libsquoosh` | 0.4.8 | 2024-04-29 | node ≥16 | 653 | frostoven/Squoosh-with-CLI: 111★, last push 2024-12-08 (docs) | README: fixes the CLI eating all images at once (crash above ~500 MB); concurrency = CPU count; "confirmed to work with datasets exceeding 10GB". Maintained "in my spare time". |
| `@frostoven/squoosh-cli` | 0.9.1 | 2024-04-30 | node ≥16 | 651 | same | |
| `@investtal/libsquoosh` | 0.4.8 | 2025-11-15 | node ≥16 | 5 | Same repo URL as frostoven | Looks like a republish; one version |
| `@bit-blazer/squoosh-node` / `-cli` | 1.3.0 | 2026-06-14 | node ≥18 | 33 / 20 | Bit-Blazer/squoosh (fork, 1★, push 2026-06-14) | Commits: "fix(avif): add node build targets and recompile outdated WASM binaries", "Migrate to npm workspaces" |
| `@movable/squoosh-lib` | 0.8.1 | 2026-02-26 | node `…^20 \|\| ^24` | 3 | points at the GoogleChromeLabs URL | |
| `squoosh-next` | 0.1.3 | 2025-06-17 | none | 2,406 | points at the GoogleChromeLabs URL | "support any node version" |
| `remige` | 0.1.2 | 2024-09-30 | `*` | 68 | iamspdarsan/remige returns **404** | "fork of libSquoosh" |
| `@superbiche/squoosh-lib` | 0.5.0-node18 | 2023-11-10 | ≤18 | 0 | | |
| `@squoosh-kit/*` (core, runtime, avif, mozjpeg, webp, jxl, oxipng, png, qoi, resize, hqx, imagequant, wp2, visdif, vite-plugin) | 0.2.10 | 2026-09-02 | core: node ≥18, bun ≥1 | core 167, runtime 3,647 | bnowak008/squoosh-kit: 7★, push 2026-09-08, 74 versions | Not a libsquoosh fork: new "Bun-first" wrappers, MIT + Apache-2.0 wasm. In Bun/Node, "auto" mode runs wasm **on the calling thread**. Includes **imagequant** and visdif. **UNVERIFIED:** codec versions. Its README says `bun run sync-codecs # Download Squoosh codecs`, so probably the same `dev` builds. |

Conclusion: no fork has both recent releases and real adoption. The only ones with any traction are frostoven (about 650/week, but no release since April 2024) and squoosh-next (about 2.4k/week, one-off).

---

## 7. Implications for a "Squoosh, but better" MCP server

These follow from the facts above; they are not new research.

1. Taking codecs from jSquash or libsquoosh means inheriting codec builds from 2018–2022. The only modern, maintained set of Squoosh-style wasm builds is the unmerged PR #1473 (libavif 1.4.2, libwebp 1.6.0, libjxl 0.12, mozjpeg 4.1.5, jpegli, oxipng 10.2 + zopfli, imagequant 4.4, fast_image_resize). It is Apache-2.0 like the rest of the repo, but it is not published to npm, and it targets browser workers rather than Node.
2. In Node, jSquash is single-threaded for every codec, so batch speed has to come from our own `worker_threads` pool, with one wasm instance per worker.
3. Squoosh's quality heuristics for "intelligent per-image decisions" exist in two places. One is libsquoosh's Butteraugli-target binary search (goal 1.4, 6 rounds). The other is the PR #1473 direction: SSIMULACRA 2 as the metric, jixel's `arbiter: 'ssimulacra2'`, and quantize dither off by default.
4. The Squoosh UI defaults are a starting point, not best practice. PR #1473 itself changes AVIF to 4:4:4, the JPEG default to jpegli, quantize dither to 0, and WebP thread_level to 1.

---

## 8. Not verified / caveats

- The PR #1473 contents may change before merge, or never merge. I read the branch at `84e955b3` (2026-10-22).
- **BEN2 spike branch:** the ONNX Runtime/WebGPU reading comes only from the branch name. I did not read its code.
- I did **not** run any build or test any npm package in Node. Node behaviour comes from source reading and issues.
- Fork quality (@bit-blazer, @movable, squoosh-next, @squoosh-kit, @discourse, @kittl): I checked only npm metadata, READMEs and commit titles, not code or the codec versions they ship.
- `remige`'s GitHub repo returns 404, so its source could not be checked.
- AVIF `tune=auto` below quality 50 leaves libaom's default tune. I did not confirm what libaom's default is.
- Download counts are a single week's snapshot from api.npmjs.org (week ending around 2026-11-01).

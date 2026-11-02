# Engine and quality-metric research for a Squoosh-grade image MCP

Date: 2026-11-02. Versions come from `npm view`, from what the installed packages report, and from official docs and repos. Benchmarks were run locally (macOS, Apple Silicon, Node 24) in a temporary folder; copies of the scripts are in `docs/research/engine-bench/`: the scripts `bench*.mjs`, `wv.mjs`, `jx.mjs` and the results file `bench-results.json`.

## 0. Bottom line

| Question | Answer | Main evidence |
|---|---|---|
| Encoding engine | **sharp 0.35.5** for decode, resize, JPEG, WebP, AVIF, GIF and palette PNG. Add an **oxipng pass** for final PNGs. | JPEG output is within 31 bytes of jSquash/Squoosh mozjpeg. WebP output is byte-identical. AVIF is equal or smaller at equal SSIM. sharp is 1.3–12x faster on one image and about 7x faster in a 12-image batch. |
| PNG | sharp + oxipng. Use `@napi-rs/image` `losslessCompressPng` (native) or `@jsquash/oxipng` (WASM). | sharp's own lossless PNG is 4–15% larger than oxipng. Palette PNG plus oxipng saves another 8–11%. |
| JPEG XL | Not in sharp's prebuilt binaries. If wanted, load `@jsquash/jxl` or `wasm-vips` only when JXL is requested. | `sharp.format.jxl.output` is all `false`. wasm-vips 0.0.19 encodes JXL. |
| Quality metric for "auto quality" | **SSIMULACRA2**. There is no trustworthy npm package yet, so build our own small WASM module from the BSD-2 Rust crate `fast-ssim2` (imazen, v0.9.1, 2026-11-01, has WASM SIMD128). | It is the metric behind libjxl, Cloudinary and libaom `tune=iq`, and sharp 0.35's AVIF tuning uses it. Its 0–100 scale has documented anchors. It correlates best on CID22. |
| What not to use | ssim.js as the target metric (grayscale, downsampled, saturates). DSSIM (AGPL). jSquash as the main engine (old codecs, Node support "limited"). | See sections 3 and 5. |

---

## 1. sharp: what the installed binary actually contains

`npm install sharp@0.35.5` on darwin-arm64 with Node 24.14.0 and npm 11.9.0. No install script ran: sharp 0.35.0 removed it.

`require('sharp').versions` reported:

| Library | Version | Used for |
|---|---|---|
| vips | 8.18.7 | core pipeline |
| mozjpeg | commit `0826579` (2025-06-23, after v4.1.x) | JPEG encode and decode. The JPEG library itself is mozjpeg. |
| webp | 1.6.0 | WebP |
| heif / aom | 1.23.5 / 3.15.1 | AVIF (AV1 only. HEVC needs a custom libvips.) |
| png / zlib-ng | 1.6.58 / 2.3.3 | PNG. This is **libpng**: no libspng appears in the list. |
| imagequant | 2.4.1 | palette PNG and GIF. lovell's fork of the **BSD-2** libimagequant 2.4.1, with small speed patches. |
| cgif | 0.5.4 | GIF output |
| uhdr | 2.0.2 | Ultra HDR gain maps |
| highway | 1.4.0 | SIMD (`sharp.simd()` returned true) |
| lcms, exif, rsvg, tiff, … | various | colour management, metadata, SVG input |

`sharp.format` reported:

- Outputs: jpeg, png, webp, gif, avif/heif, tiff, dz and raw.
- **jxl: input false, output false.** jp2, magick and pdf are also unavailable.
- The docs confirm: "JPEG-XL needs libvips built with libjxl. The prebuilt binaries do not include it."

Other facts:

- **Kernels:** nearest, linear, cubic, mitchell, lanczos2, lanczos3 (default), mks2013 and mks2021 (Magic Kernel Sharp).
- **Concurrency:** `sharp.concurrency()` returned 6 on this 18-core Apple Silicon machine, which has 6 performance cores. `UV_THREADPOOL_SIZE` was unset, so Node's default of 4 applies. Cache defaults are 50 MB, 20 files and 100 items.
- **Node support:** `engines.node >=20.9.0`. The minimum is a Node-API v9 runtime, and Node 18 was dropped in 0.35.0.
- **Prebuilt platforms:**
  - macOS x64 and arm64
  - Linux glibc and musl on x64, arm64, arm, ppc64, s390x and riscv64
  - Windows x64 and arm64 (ia32 is deprecated)
  - FreeBSD through WebAssembly
  - Optional `@img/sharp-wasm32` fallback, which is multi-threaded and no longer experimental as of 0.35.0
- **Install size (unpacked, npm registry):**
  - sharp: 0.96 MB
  - linux-x64: binding 0.43 MB + libvips 18.7 MB, about **20 MB** in total
  - darwin-arm64: about 19.5 MB in total (measured on disk: 17 MB libvips dylib + 0.3 MB binding)
  - win32-x64: 19.8 MB
  - Quirk: npm 11.9 also pulled in `@img/sharp-wasm32` (9 MB) as an "extraneous" package here, which made `node_modules` 29 MB.
- **Licences:** sharp is Apache-2.0. The prebuilt libvips bundle is LGPL-3.0-or-later. The wasm32 package lists Apache-2.0, LGPL-3.0-or-later and MIT.

### sharp 0.35.0 changes that matter here (released 2026-06-10)

- "Lossy AVIF output is now tuned using SSIMULACRA2-based `iq` quality metrics". There is also a new AVIF/HEIF `tune` option: auto, iq, psnr or ssim.
- "Remove `install` script": there is no postinstall step any more.
- Also new: WebP `exact`, gain-map support (`keepGainMap`, `withGainMap`), `toUint8Array` and `limitInputChannels`.

### sharp output options that map to Squoosh controls (sharp api-output docs)

| Format | sharp options | Squoosh default | Setting that matches Squoosh |
|---|---|---|---|
| JPEG | `quality` (80); `mozjpeg` (false), which sets trellisQuantisation + overshootDeringing + optimiseScans + quantisationTable 3; `chromaSubsampling` ('4:2:0'); `progressive`; `optimiseCoding` (true); `quantisationTable` (0–8) | MozJPEG q75, progressive, quant_table 3, optimise_coding, trellis on by default, auto subsampling | `jpeg({ quality, mozjpeg: true })` |
| WebP | `quality` (80), `alphaQuality` (100), `lossless`, `nearLossless`, `smartSubsample`, `smartDeblock`, `preset`, `effort` 0–6 (4), `exact`, `minSize`, `mixed` | q75, method 4, sns 50, filter 60 | `webp({ quality, effort: 4 })` |
| AVIF | `quality` (50), `lossless`, `effort` 0–9 (4), `chromaSubsampling` (**'4:4:4' default**), `bitdepth` 8/10/12, `tune` | q50, speed 6, **4:2:0**, tune ssim when q≥50 | `avif({ quality, effort: 4, chromaSubsampling: '4:2:0' })`. The quality scales differ, so target a metric, not a number. |
| PNG | `compressionLevel` (6), `adaptiveFiltering`, `palette`; setting `quality`, `effort` (1–10, 7), `colours` (256) or `dither` (1.0) **turns palette on** | lossless with OxiPNG level 2, or "reduce palette" with libimagequant 2.12.1 then OxiPNG | sharp `png({ palette… })` then oxipng |
| GIF | `colours`, `effort`, `dither`, `reuse`, `interFrameMaxError`, `interPaletteMaxError`, `keepDuplicateFrames` | not offered by Squoosh | — |
| JXL | `distance` (1.0), `quality`, `effort` (7), `lossless`, `decodingTier` | JXL q75, effort 7 | Needs a custom libvips. Use `@jsquash/jxl` or `wasm-vips` instead. |
| Resize | lanczos3 by default. Gamma correction is opt-in through `.gamma(2.2)`. | lanczos3, `premultiply: true`, **`linearRGB: true`** | `resize({ kernel: 'lanczos3' }).gamma()` is the closest match. Check it visually. |

Metadata: by default `toBuffer` and `toFile` strip all metadata, including the ICC profile, after converting to sRGB. `keepMetadata()` and `withMetadata()` keep it.

---

## 2. Local benchmarks

**Setup:**

- Machine: Apple Silicon, 18 cores. Node 24.14.0. Median of 3 runs.
- Every encoder received the same raw RGBA pixels.
- Quality was measured with ssim.js ('weber') and PSNR against the input.

**Test images** (from the Squoosh repo):

- photo: `demo-large-photo.jpg` resized to 1732x1159 (2.0 MP)
- screenshot: `demo-device-screen.png`, 706x1442
- artwork: `demo-artwork.jpg` resized to 1800x696

### 2.1 Single image, 2 MP photo

| Format | Encoder | Size KB | ms | SSIM | PSNR |
|---|---|---|---|---|---|
| JPEG q75 | sharp `mozjpeg:true` | 210.2 | 77 | 0.9991 | 34.87 |
| JPEG q75 | jSquash mozjpeg (Squoosh defaults) | 210.2 | 140 | 0.9991 | 34.87 |
| JPEG q75 | sharp without the mozjpeg flag | 263.7 (+25%) | 8 | 0.9992 | 35.35 |
| JPEG q75 | @napi-rs/image `Transformer.jpeg(75)` | 320.6 | 27 | 0.9992 | 36.30 |
| WebP q75 | sharp effort 4 | 175.2 | 101 | 0.9981 | 35.10 |
| WebP q75 | jSquash method 4 | 175.2 | 128 | 0.9981 | 35.10 |
| WebP q75 | @napi-rs/image | 175.2 | 104 | 0.9981 | 35.10 |
| AVIF q50 | sharp effort 4, 4:2:0 | 100.7 | ~330 | 0.99815 | — |
| AVIF q50 | sharp effort 4, 4:4:4 (default) | 104.6 | 425 | 0.9982 | 34.41 |
| AVIF q50 | sharp effort 3 (= aom speed 6) | 107.2 | 88 | 0.9981 | 34.32 |
| AVIF q50 | jSquash speed 6 (Squoosh defaults, 4:2:0) | 101.7 | 1037 | 0.9975 | 34.44 |
| AVIF q50 | @napi-rs/image speed 6 | 112.1 | 121 | 0.9975 | 35.28 |

**Byte-level parity (`bench2.mjs`, sha1 of the outputs):**

- **JPEG:** sharp `mozjpeg:true` and jSquash differ by 10, 31 and 6 bytes on the three images (sharp is smaller on two of them), a difference of at most 0.02%.
- **WebP:** sharp and jSquash produced **byte-identical** files on photo and artwork, and the same length on the screenshot.

**AVIF at matched quality (photo; `bench3.mjs`; weber-SSIM is a weak metric for AVIF):**

| q | sharp e4 (4:4:4) | jSquash s6 (4:2:0) |
|---|---|---|
| 30 | 43.7 KB / 0.99375 | 44.5 KB / 0.99219 |
| 40 | 67.4 KB / 0.99677 | 68.7 KB / 0.99581 |
| 50 | 104.6 KB / 0.99817 | 101.7 KB / 0.99752 |
| 60 | 154.1 KB / 0.99883 | 152.0 KB / 0.99855 |
| 70 | 219.0 KB / 0.99913 | 198.5 KB / 0.99886 |

At equal file size, sharp scores the same or higher. This fits its newer aom: 3.15 with SSIMULACRA2-based `tune=iq`, against aom 3.7.0 in Squoosh and jSquash.

### 2.2 PNG

| Image | sharp lossless (level 9, adaptive) | jSquash oxipng L2 | @napi-rs/image `losslessCompressPng` | sharp palette (effort 7) | sharp palette, then oxipng L2 |
|---|---|---|---|---|---|
| photo | 3486 KB, 549 ms | 3067 KB, 1250 ms | 3042 KB, 571 ms | 943 KB, 1289 ms | 844 KB (+563 ms) |
| screenshot | 1455 KB, 203 ms | 1394 KB, 800 ms | 1398 KB, 470 ms | 427 KB, 655 ms | 389 KB (+273 ms) |
| artwork | 1313 KB, 168 ms | 1141 KB, 544 ms | 1143 KB, 289 ms | 416 KB, 201 ms | 381 KB (+265 ms) |

All three lossless outputs decoded to pixels identical to the input. **sharp alone does not match Squoosh on PNG.** Adding oxipng closes the gap. The native `@napi-rs/image` version runs about 2x faster than the WASM one.

### 2.3 Batch of 12 x 2 MP images (`bench3.mjs`)

| Job | sharp, one at a time | sharp, `Promise.all` | jSquash, `Promise.all` (WASM on the main thread) |
|---|---|---|---|
| mozjpeg q75 | 881 ms | **242 ms** | 1662 ms |
| AVIF q50 | 5072 ms | **1869 ms** | 12053 ms |

- With `UV_THREADPOOL_SIZE=12`, AVIF took 1838 ms at `sharp.concurrency(6)` and 2767 ms at `concurrency(1)`. A larger libuv pool gave no gain here.
- In Node, jSquash's AVIF picks the single-threaded build (its `init()` skips the `_mt` build when it detects Node). Running it in parallel would need our own `worker_threads` pool.

### 2.4 JPEG XL and wasm-vips (photo, `wv.mjs` and `jx.mjs`)

| Encoder | Result |
|---|---|
| wasm-vips 0.0.19 (libvips 8.18.7, 37 ms init, 18 threads) | JPEG mozjpeg-like q75: 210.4 KB in 318 ms (4x slower than sharp). WebP: 175.4 KB in 134 ms. **AVIF: 101.6 KB in 6434 ms (about 19x slower).** **JXL d1.0 e7: 336 KB in 602 ms.** |
| @jsquash/jxl 1.3.0 | q75 e7: 157 KB in 1140 ms. q90 e7: 312 KB in 1138 ms. |

---

## 3. Engine comparison

| | **sharp 0.35.5** | **jSquash (@jsquash/\*)** | **@napi-rs/image 1.16.0** | **wasm-vips 0.0.19** | @squoosh/lib / cli |
|---|---|---|---|---|---|
| Latest release | 2026-09-27 | jpeg 1.6.0 and webp 1.5.0 (2025-05-12), avif 2.1.1 (2025-05-20), oxipng 2.3.0 (2024-06-18), jxl 1.3.0 (2025-07-12), resize 2.1.1 (2026-01-05) | 2026-10-27 | 2026-09-29 | 0.5.3 / 0.7.3 (2023-01-03). README: "Project no longer maintained". |
| Weekly downloads (week of 2026-10-26) | 154.6 M | jpeg 432k, webp 841k, avif 239k, oxipng 73k | 249k | 192k | — |
| Codec versions | mozjpeg 2025 master, libwebp 1.6.0, aom 3.15.1 + libheif 1.23.5, libpng 1.6.58, imagequant 2.4.1 | **Same as Squoosh**: mozjpeg 3.3.1 (2018), libwebp `d2e245e` (2020-11), libavif 1.0.1 + aom 3.7.0, oxipng 9.0, libjxl pinned commit | mozjpeg-sys, libwebp-sys 0.14, libavif 0.14 (aom), oxipng, its own quantiser, fast_image_resize | libvips 8.18.7 with libjxl | Squoosh codecs |
| Output parity with Squoosh | JPEG ≈ identical (≤0.02%). WebP identical. AVIF equal or better at equal SSIM. PNG needs oxipng. JXL missing. | Identical by construction | WebP identical. `jpeg()` is not mozjpeg-tuned (+52%). Strong PNG tools (oxipng, quantise). | Same libvips encoders (JPEG 210.4 KB) plus JXL | n/a |
| Speed | Fastest. Native, multi-threaded, SIMD. | 1.3–2x slower on one image. About 7x slower in a batch. AVIF about 3x slower than sharp e4 and 12x slower than sharp e3. | Fast. Native. | JPEG 4x slower, AVIF about 19x slower | n/a |
| Install friction | Prebuilt binaries for about 14 targets, no scripts, about 20 MB per platform | Pure WASM (about 17 MB for all codecs). **ESM only. Node needs manual `WebAssembly.compile` of each `.wasm`.** README: Node support is "limited" and "not optimized for speed". | Prebuilt for 12 targets (incl. android, freebsd), about 22 MB on linux-x64 | Pure WASM, 13 MB, Node ≥17 | — |
| Resize | lanczos3, mitchell, mks2013/2021 | lanczos3, mitchell, catrom, magic-kernel; linear RGB + premultiply (the Squoosh defaults) | fast_image_resize | libvips | — |

### Why sharp and not jSquash as the core

- **Same bytes.** The JPEG and WebP outputs match, so Squoosh-grade quality is a matter of using the right sharp options.
- **Newer codecs.** sharp's aom has `tune=iq`. jSquash ships Squoosh's 2018–2023 codecs.
- **Faster, especially in batches.** sharp uses the libuv pool plus glib threads. jSquash would need a worker pool we build ourselves.
- **Fewer Node pitfalls.** jSquash is ESM-only and needs manual WASM loading in Node, and its own README calls Node support limited.

### Where jSquash is still useful

- An optional, lazy-loaded `@jsquash/jxl` for JXL.
- `@jsquash/oxipng` as a pure-WASM PNG optimiser, if we want to avoid a second native dependency.

---

## 4. Concurrency model (for batch design)

- Each sharp pipeline (`toBuffer` / `toFile`) is queued on **Node's libuv threadpool**. Node's default `UV_THREADPOOL_SIZE` is 4.
- Inside each task, libvips uses up to `sharp.concurrency()` glib threads. The default is the number of CPU cores, or 1 on glibc Linux without jemalloc.
- aom manages its own threads.
- `sharp.queue` and `sharp.counters()` expose queue depth.

Measured: firing 12 encodes at once gave a 3.6x speed-up for JPEG and 2.7x for AVIF over running them one by one.

What this means for the MCP:

- Run a bounded pool. Allow about `min(4, cores/2)` images in flight, with each encode's quality search running sequentially inside it.
- Watch memory per image. One 2 MP raw RGBA buffer is 8 MB.
- Keep metric scoring off the main thread with `worker_threads`.

---

## 5. Perceptual quality metrics

### 5.1 Packages usable from Node

| Metric | npm package | Latest (date) | Weekly downloads | Notes |
|---|---|---|---|---|
| **SSIMULACRA2** | `bytecut-ssimulacra2` | 0.1.0 (2026-10-11) | 18 | 62 KB WASM built from the rust-av `ssimulacra2` 0.5.1 crate. BSD-2. Worker-pool API. **No repo link, one maintainer.** I read its JS: it is clean and every WASM import is stubbed. Running it was **blocked by the session's permission policy** (code from an unvetted package), so its speed was not measured. |
| SSIMULACRA2 | `@nrs-binding/ssimulacra2` | 1.0.23 (2024-10-14) | 4 | napi-rs native binding of rust-av. Unknown maintainer. Stale. |
| SSIMULACRA2 | `calc-s2-rust`, `ssimulacra2-js` | 1.0.3 / 1.0.2 (2022-12-18) | 25 / 4 | Predate SSIMULACRA **2.1** (April 2023), so they use the old weights. |
| SSIMULACRA2 (Rust, for building our own) | `fast-ssim2` crate (imazen) | 0.9.1 (2026-11-01) | — | BSD-2 fork of rust-av. SIMD dispatch for "AVX2/FMA, NEON, **WASM SIMD128**". A precomputed `Ssimulacra2Reference` makes batch comparisons about 2x faster (author's claim). Matches pinned Cloudinary 2.1 scores on its test set. |
| Butteraugli | `@squoosh-kit/visdif` | 0.2.10 (2026-09-02) | 19 | Emscripten VisDif (the old google/butteraugli that Squoosh used). Small project. |
| Butteraugli | `butteraugli` | 0.0.2 (2017) | 7 | Binary wrapper. Dead. |
| DSSIM | none on npm | — | — | kornelski/dssim: Rust, C and WASM possible. **AGPL-3.0 or commercial**, which rules it out for an MIT npm package. |
| SSIM | `ssim.js` | 3.5.0 (2020-10-12) | 1.27 M | MIT. Measured **79–133 ms on 2 MP**. By default it converts to **grayscale** and **downsamples** (Matlab-style, `maxSize 256`), so it ignores chroma and fine artefacts. |
| SSIM | `image-ssim` | 0.2.0 (2015-07-10) | 6.3 M (transitive) | Stale. |
| SSIM | `@blazediff/ssim` | 1.7.1 (2026-01-11) | 27k | "Fast single-threaded SSIM … for CI visual testing". |
| Pixel diff | `pixelmatch` | 8.0.0 (2026-10-06) | 14.4 M | Counts differing pixels for visual regression testing. **Not a compression-quality metric.** |
| zensim (new) | Rust crate only, no npm | 0.2.7 | — | imazen, MIT/Apache. A new trained metric with `approx_ssim2()`: mean absolute error 4.4 points, r=0.974 against SSIMULACRA2. 22 ms per 1080p frame multi-threaded, 89 ms on one thread. WASM support not documented. Worth watching. |

### 5.2 Documented speed on about 2 MP (1920x1080 = 2.07 MP)

These are author-published figures from the zensim README: native code on a Ryzen 9 7950X, synthetic images.

| Implementation | Time |
|---|---|
| SSIMULACRA2, rust-av crate (rayon) | 1056 ms |
| SSIMULACRA2, libjxl C++ (single-thread) | 377 ms |
| SSIMULACRA2, fast-ssim2 (single-thread SIMD) | 350 ms (its own docs say 316 ms) |
| zensim | 22 ms (89 ms on one thread) |
| Butteraugli, libjxl C++ | 647 ms |
| Butteraugli, butteraugli-rs | 154 ms |

**WASM timings in Node were not measured** (see 5.1). Expect WASM SIMD to be slower than native.

### 5.3 What the industry uses

**SSIMULACRA 2 (Jon Sneyers, Cloudinary)**

- The canonical code is in libjxl `tools/ssimulacra2.cc` and in cloudinary/ssimulacra2. Version 2.1 dates from April 2023.
- Scale: 90 is visually lossless in a flicker test, 85 excellent, 80 very high (not noticeable side by side), 70 high, 50 medium, 30 low.
- Correlation with human scores on CID22 (KRCC/SRCC): **0.690 / 0.881**. Butteraugli scores 0.655/0.839, DSSIM 0.643/0.840, SSIM 0.563/0.758 and PSNR 0.347/0.500. On TID2013, DSSIM is slightly ahead (0.698). On KADID, MS-SSIM is slightly ahead.
- libaom 3.12.0 (Feb 2025) added `tune=iq`, which is "using the SSIMULACRA 2 metric as a guide". sharp 0.35.0 made this the default for lossy AVIF.

**Cloudinary `q_auto`**

- The current docs say only that it uses "perceptual metrics and heuristics", at levels best, good, eco and low, with a `:sensitive` suffix.
- Cloudinary's 2017 blog says SSIMULACRA was built because "the perceptual metric is such a crucial component of q_auto". A 2023 press release says the AI-enhanced q_auto was trained on CID22 human annotations.
- Exactly which metric runs today is not stated in the docs.

**imgproxy Pro autoquality**

- Methods are `size` (fit a byte budget), `dssim` (reach a target DSSIM; the examples use 0.02, quality 70–80, allowed error 0.001) and `ml` (an ONNX model predicts the quality, falling back to DSSIM).
- It "requires an image to be saved several times". The search algorithm is not documented.
- It supports per-format min/max quality and has ML models for JPEG, WebP, AVIF and JXL.

**Squoosh CLI (unmaintained)**

- Its experimental "auto" mode searched for a **Butteraugli** target, default `1.4`, in at most `6` rounds (`--optimizer-butteraugli-target`, `--max-optimizer-rounds`).

**JPEG XL**

- `cjxl -d` is a Butteraugli distance target. The SSIMULACRA2 anchors above are expressed as cjxl distances.

**Verdict:** SSIMULACRA2 is the de-facto standard for "is this compression visible", with Butteraugli as the older max-error alternative. DSSIM is used by imgproxy but is licence-blocked for us.

### 5.4 Measured cost of an auto-quality search (`bench5.mjs`, 2 MP photo, ssim.js as a stand-in)

| Format | Search range | Iterations | Total time | Result |
|---|---|---|---|---|
| JPEG (mozjpeg) | q 30–95 | 6 | 838 ms | q41 |
| WebP | q 30–95 | 6 | 1116 ms | q51 |
| AVIF e4 | q 20–90 | 6 | 2480 ms | q44 |

The target was weber-SSIM ≥ 0.997.

- **Encoding dominates when the metric costs about 100 ms.**
- **ssim.js is the wrong target.** It accepted JPEG q41, while q75 already scores 0.999. Grayscale plus downsampling makes it saturate.
- **SSIMULACRA2 timing (estimate):** at about 350 ms native per call, plus some WASM overhead, a 6-step search costs about 2–4 s per image per format.

Ways to cut that:

1. Precompute the reference pyramid once with fast-ssim2's `Ssimulacra2Reference` (about 2x).
2. Use 3–4 interpolation or secant steps from a predicted starting quality, instead of a blind binary search.
3. Run scoring in a `worker_threads` pool.
4. Search only the formats still in contention, using a quick fixed-quality probe first.

---

## 6. Competitors

Full details are in `competitors.md`.

Columns a–f are our goals: (a) batch, (b) per-image decisions, (c) perceptual target, (d) responsive variants, (e) AVIF/JXL, (f) local with no API key.

| Server | Stars / weekly downloads | Last publish | Engine | a | b | c | d | e | f |
|---|---|---|---|---|---|---|---|---|---|
| piephai/mcp-image-optimizer | 11 / 15 | Aug 2025 | sharp | loop, same settings for all | ✗ | ✗ | ✗ (blur placeholder only) | AVIF | ✓ |
| yaktool-image-mcp | no repo / 56 | Aug 2026 | jSquash WASM | ✗ | partial (keeps the original if smaller) | PSNR floor, PNG only | ✗ | AVIF | ✓ |
| InhiblabCore/mcp-image-compression | 34 / 22 | Apr 2025 | sharp | loop | ✗ | ✗ | ✗ | AVIF | ✓ |
| greatSumini/sharp-mcp | 11 / 8,968 (an automated spike, not adoption) | Nov 2025 | sharp 0.33 | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| getmochify/mochify-cli | 1 / not on npm | Oct 2026 | cloud API | CLI only | unclear "auto" | ✗ | ✗ | AVIF + JXL | ✗ |
| ShortPixel (official) | 0 / — | Oct 2026 | cloud API | up to 100 URLs | ✗ | ✗ | ✗ | AVIF | ✗ |

Gaps across the market:

1. Nobody targets a perceptual score.
2. No tool makes per-image format, quality or size decisions inside a batch.
3. No local npm server produces responsive width × format variants with markup or a manifest.
4. JXL is almost absent.
5. Batches are sequential or base64-heavy, with no dry-run or plan and no compact summary.

---

## 7. Open decisions

- **D1. PNG optimiser.**
  - `@napi-rs/image` `losslessCompressPng`: native, about 2x faster, +22 MB, 12 platforms.
  - `@jsquash/oxipng`: WASM, 0.5 MB, slower, runs everywhere.
  - *Lean: @napi-rs/image, with @jsquash/oxipng as a fallback if the native load fails.*
- **D2. JXL in v1.**
  - Skip it.
  - Or offer it as an optional, lazy-loaded encoder: `@jsquash/jxl` (5.8 MB) or `wasm-vips` (13 MB; also gives a full libvips fallback).
  - *Lean: skip in the MVP and keep a codec interface so it can be added later.*
- **D3. Where the SSIMULACRA2 implementation comes from.**
  - (a) Build our own WASM from `fast-ssim2` (BSD-2, SIMD128). Needs a Rust toolchain in CI and gives about a 100 KB artefact.
  - (b) Vet and adopt `bytecut-ssimulacra2`.
  - (c) A native napi-rs binding (fastest, more platform builds).
  - *Lean: (a).*
- **D4. Default target score and presets.**
  - For example: "high" 80, "web-default" 75, "visually lossless" 90.
  - Also whether to add Butteraugli as a second "max artefact" guard (not needed for the MVP).
- **D5. Resize in linear light** (Squoosh's default) through `.gamma()`, or sharp's default. Needs a quick visual check on high-contrast detail.
- **D6. AVIF settings.** Use 4:2:0 with effort 4 to match Squoosh, or keep sharp's 4:4:4 default, which is sharper on colour edges but a few % larger.

## 8. What I could not verify

- **SSIMULACRA2 speed and scores in Node/WASM.** Running `bytecut-ssimulacra2` was blocked by the permission policy. No Rust toolchain or ssimulacra2 binary was available locally, so speed figures are the authors' native numbers.
- **Benchmark coverage.** One Apple Silicon machine and three images only. Linux x64 performance and memory use were not measured. AVIF quality comparisons used luma SSIM, which is a weak metric.
- **Cloudinary's metric today.** The current q_auto docs do not name it. The SSIMULACRA link comes from the 2017 blog and the 2023 press release.
- **imgproxy's search algorithm** is not documented.
- **Star counts** for sharp and jSquash: the GitHub API rate limit was hit.
- **Platform list:** the sharp install doc lists the platforms but not install sizes. Sizes above come from npm `dist.unpackedSize` and from disk.

## 9. Sources

**sharp**

- Output options: https://sharp.pixelplumbing.com/api-output/
- Installation: https://sharp.pixelplumbing.com/install/
- Utilities (concurrency, queue, cache): https://sharp.pixelplumbing.com/api-utility/
- Resize: https://sharp.pixelplumbing.com/api-resize/
- Operations (`gamma`): https://sharp.pixelplumbing.com/api-operation/
- v0.35.0 changelog: https://sharp.pixelplumbing.com/changelog/v0.35.0
- sharp-libvips versions: https://raw.githubusercontent.com/lovell/sharp-libvips/main/versions.properties
- libimagequant fork: https://github.com/lovell/libimagequant (README)
- mozjpeg commit 0826579 and releases: GitHub API
- npm metadata: `npm view sharp time engines optionalDependencies dist.unpackedSize`; `@img/*` sizes

**jSquash and Squoosh**

- jSquash README and codec Makefiles/Cargo.toml (local clone, HEAD `da47a2b`, 2026-01-05): https://github.com/jamsinclair/jSquash
- Squoosh codecs (local clone, HEAD `e8d35e0`, 2024-08-19): https://github.com/GoogleChromeLabs/squoosh
- Squoosh CLI README (auto optimizer, unmaintained notice): https://raw.githubusercontent.com/GoogleChromeLabs/squoosh/918c596cba36a46ff3d7aa8ffd69580bd22528e2/cli/README.md

**Other engines**

- @napi-rs/image: https://github.com/Brooooooklyn/Image (`packages/binding/Cargo.toml`), plus `index.d.ts` in the installed package
- wasm-vips: https://github.com/kleisauke/wasm-vips (version probed locally)

**Metrics**

- SSIMULACRA2: https://github.com/cloudinary/ssimulacra2
- fast-ssim2: https://docs.rs/crate/fast-ssim2/latest
- zensim (benchmarks): https://docs.rs/crate/zensim/latest/source/README.md
- DSSIM: https://github.com/kornelski/dssim
- libaom 3.12 `tune=iq`: https://aomedia.org/blog%20posts/Libaom-3_12_0-Now-Available-from-Codec-Working-Group/
- AIC-3 metric evaluation (Sneyers et al., 2025): https://arxiv.org/abs/2509.13150 (abstract only; results not read)

**Auto-quality services**

- imgproxy autoquality: https://docs.imgproxy.net/features/autoquality
- Cloudinary q_auto: https://cloudinary.com/documentation/image_optimization#automatic_quality_selection_q_auto
- Cloudinary SSIMULACRA blog (2017): https://cloudinary.com/blog/detecting_the_psychovisual_impact_of_compression_related_artifacts_using_ssimulacra
- Cloudinary CID22 press release (2023): https://www.businesswire.com/news/home/20231115698449/en/

**Registries**

- npm downloads: https://api.npmjs.org/downloads/point/last-week/<pkg>
- MCP registry: https://registry.modelcontextprotocol.io/v0/servers?search=…
- GitHub search API
- Competitor sources: see `competitors.md` section 6

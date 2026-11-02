# Competitor scan: image optimisation / compression MCP servers

Date of scan: 2026-11-02. Research only: nothing was installed or run.

## How this was checked

- **GitHub:** `api.github.com/repos/...` for stars and `pushed_at` (unauthenticated limit of 60/hour ran out partway). Remaining star counts and last-commit months came from `img.shields.io/github/{stars,last-commit}/...json`. READMEs came from `raw.githubusercontent.com/<repo>/HEAD/README.md`.
- **npm:** `npm view <pkg> version time.modified time.created dependencies` and `api.npmjs.org/downloads/point/last-week/<pkg>`. The window is **2026-10-23 to 2026-10-29**.
- **Tool lists:** where a package is on npm, I read its **published code** on unpkg.com instead of trusting the README. Those packages are InhiblabCore, BoomLinkAi, piephai, tinypng-mcp and yaktool.
- **Wider sweep:** the official MCP registry (`registry.modelcontextprotocol.io/v0/servers?search=`), npm search, GitHub repo search, and the `punkpeye/awesome-mcp-servers` and `appcypher/awesome-mcp-servers` READMEs. Glama's public API returned nothing, and Smithery was not queried. See "Not verified" at the end.

Legend for the goal columns:
- (a) batch, many images in one call
- (b) per-image automatic decisions (format, quality, resize)
- (c) perceptual quality target
- (d) responsive variants or srcset
- (e) AVIF / JXL
- (f) local with no API key

## 1. Gap matrix (all candidates)

| Server | Stars | npm wk dl | Last publish / push | Engine | (a) | (b) | (c) | (d) | (e) AVIF / JXL | (f) |
|---|---|---|---|---|---|---|---|---|---|---|
| **InhiblabCore/mcp-image-compression** | 34 | 22 | npm 2025-04-23 / push 2025-06-14 | sharp | Partial: comma-joined string, sequential | No (README claims "smart", code has none) | No | No | AVIF yes / no | Yes |
| **BoomLinkAi/image-worker-mcp** | 18 | 18 | npm 2025-05-27 / push 2025-07-24 | sharp (+ libheif-js) | No | No | No | No | AVIF yes / no | Yes (cloud upload optional) |
| **greatSumini/sharp-mcp** (npm repo field: choesumin/sharp-mcp) | 11 | **8,968** | npm 2025-11-28 / push 2025-11-28 | sharp (+ @imgly bg removal) | No | No | No | No | No AVIF output / no | Yes |
| **piephai/mcp-image-optimizer** | 11 | 15 | npm 2025-08-08 / push 2025-11-25 | sharp | Yes, `batch_optimize` (sequential, one setting for all) | No | No | No (LQIP only) | AVIF yes / no | Yes |
| **yaktool-image-mcp** | no public repo | 56 | npm 2026-08-26 | **jSquash = Squoosh wasm** (mozjpeg, oxipng, webp, avif, resize) + upng-js | No | Partial: PNG lossy-vs-lossless guard, keeps original if bigger | **Partial: PSNR floor (PNG only)** | No | AVIF yes / no | Yes |
| **getmochify/mochify-cli** | 1 | not on npm | push 2026-10-26 | Mochify cloud API (C++ engine, Jpegli) | CLI yes; MCP `squish` is one image | Partial: "automatic" + saliency quality (opaque, server-side) | Partial (saliency, not a metric target) | No | **AVIF yes / JXL yes** | **No**: cloud, quota |
| **ShortPixel official** (com.shortpixel.mcp/optimize) | 0 | not checked | commit Oct 2026 | ShortPixel SPIO cloud API | **Yes: up to 100 URLs + per-URL `paramlist`** | No (lossy/glossy/lossless chosen by caller) | No | No | AVIF yes / no | **No**: API key, public URLs only |
| aiyogg/tinypng-mcp-server | 7 | (npm name `tinypng-mcp-server` 7, ownership unverified) | push 2025-11-05 | TinyPNG API | No | TinyPNG's own | No | No | AVIF via API / no | No (key) |
| cooliceman/TinyPNG-MCP (`tinypng-mcp`) | 0 | 11 | npm 2025-05-06 | TinyPNG API (`tinify`) | Yes, `batchProcess` | No | No | No | Code enum is jpg/png/webp only | No (key, 500/month free) |
| okooo5km/zipic-mcp-server | 5 | not on npm | push 2025-03-19 | Zipic macOS app | Yes (paths or folders) | No (levels 1-6) | No | No | AVIF, HEIC / no | Needs the Zipic app; macOS only |
| theluckystrike image server | 2 (monorepo) | 0 (`@theluckystrike/mcp-image` 0.22.6) | npm 2026-10-30 | jimp (pure JS) | `image_batch_resize`, `image_thumbnails` (5 files on free tier) | No | **Byte budget: `max_bytes` searches JPEG quality** | No | **No WebP/AVIF at all** | Yes, freemium |
| @mrfentmen/image-tools-mcp | 0 (awesome-servers monorepo) | 242 | npm 2026-10-28 | sharp | No | No | No | No | No | Partially paywalled |

Late finds from the extra sweep are covered in section 3.

## 2. Detailed profiles: the seven most relevant

### 2.1 piephai/mcp-image-optimizer: the most complete local sharp toolkit
- Links: https://github.com/piephai/mcp-image-optimizer, https://www.npmjs.com/package/mcp-image-optimizer
- Stats: 11 stars, 15 downloads/week, v1.0.4 published 2025-08-08, last push 2025-11-25. Needs Node 22+.
- Engine: sharp ^0.33.5.
- Tools: `optimize_image`, `batch_optimize`, `get_image_info`, `auto_crop`, `smart_crop` (attention/entropy), `create_placeholder` (LQIP), `add_watermark`, `generate_favicon`.
- How batch works (read in `dist/handlers/batch.js`): a plain `for` loop over `inputs[]` that calls `handleOptimizeImage` once per file. Every file gets the same `width`, `height`, `quality` and `format`.
  - The totals are rebuilt by regex-parsing each result's text message.
  - Default quality is a fixed 80 (JPEG/WebP). PNG uses `quality:100, compressionLevel:9`.
- Lacks:
  - (b) per-image decisions.
  - (c) any quality metric.
  - (d) multiple widths per call. You would call batch once per width, and it never emits srcset or a manifest.
  - (e) JXL.
  - No concurrency control.
  - No "keep original if bigger".

### 2.2 yaktool-image-mcp: closest in spirit (Squoosh codecs plus a quality guard)
- Links: https://www.npmjs.com/package/yaktool-image-mcp, https://yaktool.com/mcp. MCP registry name in package.json: `com.yaktool/image`. No source repo is listed.
- Stats: 56 downloads/week, v0.2.0 published 2026-08-26.
- Engine: the published bundle contains Squoosh's wasm codecs via jSquash: `mozjpeg_enc/dec`, `squoosh_oxipng`, `squoosh_png`, `webp_enc(_simd)`, `avif_enc/dec`, `squoosh_resize`. PNG quantisation uses upng-js.
- Tools:
  - `compress_image`:
    - Input is a PNG or JPEG path.
    - `mode`: `smart` or `lossless`.
    - `quality` (default 60) sets the PNG PSNR floor, or the JPEG/WebP/AVIF encoder quality.
    - `format`: `same`, `webp` or `avif`.
    - It returns a `report` with the measured PSNR dB.
    - Outcome `kept-original` if nothing beats the source.
  - `convert_image`: marketplace presets (`amazon-main`, `gmc`, `ebay`) with a rule re-check, and `allowUpscale` false by default.
- Verified in code: the bundle contains `psnrFloorDb`, `PsnrFloor` and `kept-original`. I found no SSIM or butteraugli.
- Lacks:
  - (a) It takes one file per call.
  - (c) The quality floor is PSNR, applied only to PNG quantisation. JPEG, WebP and AVIF still use a fixed encoder quality, with no metric target.
  - (b) It does not choose the format per image.
  - (d) No responsive variants.
  - (e) No JXL.
  - Input formats are limited.

### 2.3 InhiblabCore/mcp-image-compression: most stars, weakest code
- Links: https://github.com/InhiblabCore/mcp-image-compression, https://www.npmjs.com/package/@inhiblab-core/mcp-image-compression
- Stats: 34 stars, 22 downloads/week, v0.1.2 published 2025-04-23, last push 2025-06-14. Also listed in punkpeye/awesome-mcp-servers.
- Engine: sharp ^0.33.5. `shrinkpng` is a dependency but is not used in `dist/common.js`.
- Tool: `image_compression` only. Its inputs are `urls` (a comma-joined string of URLs or paths), `quantity` and `format`.
- Problems verified in the code, both in npm `dist/index.js` and GitHub HEAD `src/index.ts`:
  - The schema names the quality field `quantity`, described as "Number of transcripts to return". The handler reads `quality`. An agent that follows the schema can never set quality, so it is effectively always 80.
  - The README's "Smart compression: automatically select optimal compression parameters" has no backing code. It is a single `sharp().toFormat(fmt, {quality})`.
  - The batch is a sequential `for...in` loop. Outputs get random UUID filenames in `$IMAGE_COMPRESSION_DOWNLOAD_DIR` (or `/thumbs` when there is more than one input).
- Lacks: (b), (c), (d) and JXL. It is effectively unmaintained.

### 2.4 greatSumini/sharp-mcp: most downloads, but not an optimiser
- Links: https://github.com/greatSumini/sharp-mcp. npm's repository field points to https://github.com/choesumin/sharp-mcp. Package: https://www.npmjs.com/package/sharp-mcp
- Stats: 11 stars, **8,968 downloads/week**, v0.2.6 published 2025-11-28 (the only version being downloaded).
- Engine: sharp ^0.33.5, plus `@imgly/background-removal-node`.
- Tools: `create_session`, `create_session_by_path`, `list_session`, `get_dimensions`, `pick_color`, `remove_background`, `extract_region`, `compress_image`.
  - `compress_image` takes `sessionId`, `format` (jpeg/png/webp), `quality` (default 80) and `output_path`.
- Design: images are held as base64 in in-memory "sessions", and results come back as base64 unless `output_path` is set. That fills the model's context, so it does not scale to many images.
- Lacks: (a), (b), (c), (d) and (e). It has no AVIF output.
- **Why downloads are high (evidence):**
  - deps.dev reports `dependentCount: 0`. ecosyste.ms reports `dependent_packages_count: 0` and `dependent_repos_count: 0`. So the downloads are **not** coming from npm dependents.
  - Monthly downloads (api.npmjs.org range):
    - 2025-11: 665
    - 2026-01: 38
    - 2026-04: 386
    - 2026-05: 1,096
    - 2026-06: 1,659
    - Jul–Sep 2026: about 1.2k a month
    - **2026-10: 9,933**
  - Almost all of October falls on or after **2026-10-25**. The daily counts are 2,442 / 936 / 2,321 / 1,453 / 1,736, against about 40/day just before.
  - There was no new release (the last publish was 2025-11-28).
  - The per-version endpoint (`/versions/sharp-mcp/last-week`, which uses a slightly different window) reports 19,867 for 0.2.6. That suggests the spike is still going.
  - **Conclusion:** a step change with no release and no dependents points to an automated consumer re-fetching the package. Likely examples are CI jobs, ephemeral agent sandboxes running `npx -y sharp-mcp` with a cold cache, or a bundle or directory that auto-installs it. It does not point to organic adoption.
  - **I could not identify the specific source.** npm does not expose who downloads.
  - The earlier steady ~1k/month baseline is still the highest among image-optimisation MCPs. It plausibly comes from the Smithery listing and the obvious name. That is unverified.

### 2.5 BoomLinkAi/image-worker-mcp: resize plus cloud upload
- Links: https://github.com/BoomLinkAi/image-worker-mcp, https://www.npmjs.com/package/@boomlinkai/image-worker-mcp
- Stats: 18 stars, 18 downloads/week, v0.0.6 published 2025-05-27, last push 2025-07-24.
- Engine: sharp 0.34.1 and libheif-js.
- Tools (verified in `dist/index.js`, lines 901-903):
  - `resize_image`: one image (path, URL or base64). Takes `format`, `width`, `height`, `quality`, `fit`, `position`, `background`, `withoutEnlargement`, `withoutReduction`, `rotate`, `flip`, `flop`, `grayscale`, `blur`, `sharpen`, `gamma`, `negate`, `normalize`. Output formats include AVIF and HEIF.
  - `upload_image`: uploads to S3, Cloudflare R2 or GCS.
- Lacks: (a), (b), (c), (d) and JXL. Quality is a fixed default.
- Note: the README at `HEAD/README.md` returned 404 on GitHub raw, so I used the README on the npm registry.

### 2.6 getmochify/mochify-cli: the most capable, but cloud
- Links: https://github.com/getmochify/mochify-cli, https://mochify.app. Official MCP registry name: `app.mochify/mochify`. Hosted at `https://mcp.mochify.app`.
- Stats: 1 star, last push 2026-10-26. Ships through Homebrew, Scoop and cargo, not npm.
- Engine: a cloud API at `api.mochify.app`. The local `mochify serve` MCP only uploads to that API, so no encoding happens locally.
- MCP tools: `squish` (one image), `pdf`, `pdf_create`, `check_usage`.
  - `squish` params: `file_path`, `type` (jpg/png/webp/avif/**jxl**), `width`, `height`, `crop` (saliency), `rotation`, `quality` (default "automatic"), `smart_compress` (saliency-guided), `lossless`, `optimize_for_web`, `brightness`, `clarity`, `remove_background`, `background`, `strip_metadata`, `hdr`, `output_dir`, `output_name`.
- Batching exists only in the CLI (`-j` concurrency). The batch size is capped by plan:
  - Anonymous: 3 images.
  - Free account: 25 images/month.
  - Paid plans: from $2 a day up to $79.99 a month.
- Lacks:
  - (f) local processing with no key.
  - (a) batch in MCP.
  - (c) a stated metric. "Automatic" and saliency quality are opaque.
  - (d) responsive variants.

### 2.7 ShortPixel official MCP: real batch with per-URL parameters, but cloud
- Links: https://github.com/short-pixel-optimizer/com.shortpixel.mcp. Registry: `com.shortpixel.mcp/optimize`. Hosted at `https://mcp.shortpixel.com/mcp`.
- Stats: 0 stars, last commit October 2026 (shields.io).
- Engine: the ShortPixel SPIO API (`reducer.php`). The user's API key goes in the `Authorization` header.
- Tool: `optimize_image_urls`.
  - Params: `urls` (up to 100), `lossy` (0 lossless / 1 lossy / 2 glossy), `wait`, `upscale`, `resize` (with smart crop), `resize_width`/`resize_height`, `cmyk2rgb`, `keep_exif`, `convertto` (`+webp`, `+avif`, `+webp|+avif`, ...), `bg_remove`, `refresh`, `paramlist` (per-URL overrides), `returndatalist`.
- Lacks:
  - (f): needs a key, and accepts **public URLs only**, so no local files.
  - (b): the agent must choose everything itself.
  - (c) and (d).
  - JXL.

## 3. Others (brief)

- **TinyPNG wrappers.**
  - aiyogg/tinypng-mcp-server: 7 stars, tools `compress_local_image` and `compress_remote_image`, one file each.
  - cooliceman `tinypng-mcp`: `compressImage`, `convertImage`, `batchProcess`; the format enum is jpg/png/webp.
  - Both need `TINYPNG_API_KEY` (500 compressions/month free).
- **okooo5km/zipic-mcp-server.** Swift, macOS only, needs the Zipic app.
  - Tools: `quickCompress(urls[])` and `advancedCompress(urls[], level 1-6, format incl. avif/heic, width, height, suffix, directory)`.
- **theluckystrike image server.** Registry: `io.github.theluckystrike/image-resize-convert-compress-watermark`, plus mirrors under `com.bestremotetools/...`.
  - Engine: jimp, so there is **no WebP/AVIF**.
  - The only noteworthy feature: `image_compress` takes a `max_bytes` budget and searches JPEG quality ("quality 62, searched down from 80 in 5 encodes").
  - Free tier caps outputs at 4 MP and batches at 5 files; Pro is $19.
  - README: https://github.com/theluckystrike/mcp-servers/tree/main/servers/image
- **@mrfentmen/image-tools-mcp.**
  - Free tools: `resize_image` and `inspect_image`. Paywalled: `probe_url` and `convert_url_image`.
  - Its 242 downloads/week come mostly from spikes on publish days (09-27: 328; 10-18: 193; 10-28: 178). That looks like registry mirror or scanner traffic, not users.
- **Cleanor** (cleanor-app/cleanor-mcp, `@cleanor/mcp`, 116 downloads/week).
  - Hosted, zero-auth. `optimize_image` takes a public URL, `format` (webp/avif/jpeg), `width` and `quality`. It uses Cloudflare Images when hosted and sharp locally.
  - It also has `image_format_savings`: static benchmark data on WebP/AVIF/JXL savings at SSIM 0.95/0.98 on the Kodak set. It reports SSIM-matched savings but does not apply them per image.
- **PIMPfiction/squoosh-cli-mcp-2026** (1 star, push 2026-07-27, installed from GitHub, not npm).
  - It is a revived Squoosh CLI (libsquoosh, with MozJPEG/OxiPNG/WebP/AVIF/JXL/WebP2) plus an MCP.
  - But the MCP tool "always uses `--mozjpeg` and writes `.jpg`". It can rewrite filenames in HTML/JS/CSS (`updateReferencesIn`).
  - This is the only other Squoosh-based MCP found.
- **Pictly** (AbduljabbarBXR/pictly, 0 stars, Python + ffmpeg). Has a `responsive` tool ("width set plus JSON manifest") and `compress` with a target quality. Directory batch is on its roadmap.
- **AuraImage** (`@auraimage/mcp-server`, 21 downloads/week). Tied to its own CDN.
  - `audit_lcp` scans a project for unoptimised images and estimates LCP savings.
  - `generate_responsive_tag` returns a `<picture>` with AVIF and WebP srcsets for images on their CDN.
- **Feather** (FirasLatrech/feather, 3 stars). A macOS app whose `feather-cli mcp` covers mozjpeg, oxipng, WebP and AVIF in batches, and "never produces a larger file". Not npm.
- **img-convert** (`@dutchbase/img-convert`, 18 downloads/week, sharp). The CLI has a batch manifest with per-file settings, but the MCP exposes only `convert_image` and `get_image_info`.
- **QuokkaPix** (`quokkapix-mcp`, 16 downloads/week). Drives quokkapix.com in local Chromium through Playwright. Has e-commerce batch "recipes" and x402 paid unlocks.
- **Iminify** (hosted, OAuth, plan quotas).
- **micompress**: registry `com.micompress/mcp`, cloud.
- **crper/py-image-compress-mcp**: Python, `compress_universal` over a directory, fixed quality.
- **TOBYCAI/image-mcp**: Pillow.
- **Adityaaery20/media-mcp**: Python plus ffmpeg.
- **com.ecommerceimageoptimizer/image-optimizer**: URL-based, e-commerce.
- **Not relevant:** shinpr/mcp-image (188 stars, the largest "mcp image" repo) is AI image *generation*, not optimisation.

No optimisation MCP was found with more than 34 stars. GitHub search for "mcp image compression" returned 21 repos in total.

## 4. Gaps across the market

1. **No server targets a perceptual quality.**
   - None exposes SSIM, SSIMULACRA2 or butteraugli as a target ("smallest file at SSIMULACRA2 ≥ X").
   - The closest attempts:
     - yaktool uses a PSNR floor, for PNG quantisation only.
     - theluckystrike uses a byte budget, by searching JPEG quality.
     - Mochify has opaque "automatic" or saliency quality, run in the cloud.
   - Everything else uses a fixed quality, usually 80.
2. **No per-image decisions inside a batch.**
   - Every batch tool applies one format, quality and size to all files (piephai, InhiblabCore, Zipic, TinyPNG `batchProcess`). ShortPixel's `paramlist` only lets the *agent* set per-URL values.
   - Nobody classifies each image (photo vs graphic vs alpha vs screenshot) and picks the codec itself.
   - Only yaktool and Feather keep the original when the re-encode is not smaller.
3. **Responsive variants and srcset are missing from local npm servers.**
   - Only Pictly (Python + ffmpeg, 0 stars) builds width sets plus a manifest. AuraImage builds `<picture>` markup, but only for its own CDN.
   - No one produces width × format variants plus ready-to-paste markup or a manifest in one call.
4. **JXL is almost absent, and AVIF quality is basic.**
   - JXL output exists only in Mochify (cloud) and in the PIMPfiction Squoosh fork's CLI (its MCP forces MozJPEG).
   - AVIF is common through sharp, but always at a fixed quality.
5. **Batches do not suit agents.**
   - Some loop sequentially with no concurrency (piephai, InhiblabCore).
   - Some route base64 through the model's context (sharp-mcp sessions, BoomLink base64).
   - Some are capped by quota (Mochify 3-25, ShortPixel 100 URLs, theluckystrike 5 free).
   - None offers a dry-run or plan, resumable runs, or a compact per-folder summary for hundreds of files.
   - The two best-known projects are stale (InhiblabCore last on npm 2025-04, BoomLink 2025-05), and InhiblabCore's README claims are not backed by its code.

Taken together: there is no local, keyless, npm-installable MCP that does "many images in, per-image codec/quality/size chosen to a perceptual target, responsive variants plus a manifest out". The two closest building blocks prove the pieces are feasible in Node:
- yaktool already ships Squoosh's wasm codecs.
- piephai has the broadest local sharp tool surface.

## 5. Not verified

- **Why sharp-mcp downloads spiked:** the cause of the 2026-10-25 step change. I only ruled out dependents and a new release. The rest is inference.
- **Smithery and Glama:** Glama's public API (`glama.ai/api/mcp/v1/servers?query=`) returned empty for every query, and Smithery's registry was not queried (it needs a token). Listings there were not checked directly. Several READMEs carry Smithery or Glama badges.
- **Star counts:** for ShortPixel, theluckystrike, Cleanor, QuokkaPix, mrfentmen, TOBYCAI and cooliceman these came from shields.io, because the GitHub API limit was exhausted. Last-commit values for them are month-level only.
- **yaktool:** has no public source repository, so stars and push date are not available. Its behaviour comes from the README plus the published bundle (files and identifiers only; I did not read the full 1.5 MB bundle).
- **Mochify:** behaviour of "automatic" quality and `smart_compress` is not documented beyond the README.
- **npm package `tinypng-mcp-server`:** I did not confirm it is aiyogg's.
- **ShortPixel and Zipic on npm:** not checked.
- **Runtime behaviour:** nothing was executed, so all behaviour claims come from READMEs or static reading of published code.

## 6. Sources

- GitHub repos (README via raw.githubusercontent.com/<repo>/HEAD/README.md, metadata via api.github.com/repos/<repo>):
  - https://github.com/InhiblabCore/mcp-image-compression
  - https://github.com/BoomLinkAi/image-worker-mcp
  - https://github.com/greatSumini/sharp-mcp
  - https://github.com/piephai/mcp-image-optimizer
  - https://github.com/aiyogg/tinypng-mcp-server
  - https://github.com/cooliceman/TinyPNG-MCP
  - https://github.com/okooo5km/zipic-mcp-server
  - https://github.com/getmochify/mochify-cli
  - https://github.com/short-pixel-optimizer/com.shortpixel.mcp
  - https://github.com/theluckystrike/mcp-servers/tree/main/servers/image
  - https://github.com/cleanor-app/cleanor-mcp
  - https://github.com/quokkapix/quokkapix-mcp
  - https://github.com/PIMPfiction/squoosh-cli-mcp-2026
  - https://github.com/AbduljabbarBXR/pictly
  - https://github.com/auraimage/mcp-server
  - https://github.com/FirasLatrech/feather
  - https://github.com/dutchbase/img-converter
  - https://github.com/mozex/iminify-plugin
  - https://github.com/crper/py-image-compress-mcp
  - https://github.com/TOBYCAI/image-mcp
- Published code read on unpkg:
  - https://unpkg.com/@inhiblab-core/mcp-image-compression@0.1.2/dist/index.js and /dist/common.js
  - https://unpkg.com/@boomlinkai/image-worker-mcp@0.0.6/dist/index.js
  - https://unpkg.com/mcp-image-optimizer@1.0.4/dist/handlers/batch.js and /dist/handlers/optimize.js
  - https://unpkg.com/tinypng-mcp@1.0.2/server.js
  - https://unpkg.com/yaktool-image-mcp@0.2.0/package.json and /?meta
- npm downloads: https://api.npmjs.org/downloads/point/last-week/<pkg>, https://api.npmjs.org/downloads/range/2025-11-01:2026-11-01/sharp-mcp, https://api.npmjs.org/versions/sharp-mcp/last-week
- npm registry docs (README fallback): https://registry.npmjs.org/@boomlinkai/image-worker-mcp, https://registry.npmjs.org/yaktool-image-mcp, https://registry.npmjs.org/@mrfentmen/image-tools-mcp
- Dependents: https://api.deps.dev/v3alpha/systems/npm/packages/sharp-mcp/versions/0.2.6:dependents, https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/sharp-mcp
- Official MCP registry search: https://registry.modelcontextprotocol.io/v0/servers?search=compress (also searched `optimize`, `squoosh`, `avif`, `webp`, `sharp`)
- Awesome lists: https://github.com/punkpeye/awesome-mcp-servers, https://github.com/appcypher/awesome-mcp-servers
- GitHub search: https://api.github.com/search/repositories?q=mcp+image+compression (also `mcp image optimization`, `mcp squoosh`, `mcp avif webp`, `mcp responsive images`, `mcp srcset`, `mcp ssim image`)

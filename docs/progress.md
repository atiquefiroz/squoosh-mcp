# squoosh-mcp: progress

This file tracks what has been built and documented. **This file owns the task IDs.** [plan.md](plan.md) describes the phases and their "done when" checks.

**Status values:**

| Status | Meaning |
|---|---|
| `todo` | Not started |
| `doing` | In progress |
| `done` | Finished; its check passed |
| `waiting Dn` | Blocked on decision Dn |
| `blocked` | Blocked for another reason; see notes |
| `n/a` | Dropped; see notes |

**How to update:**
- Change a row's status when the work lands, and fill in **Where** with the file or folder.
- Add a line to the [log](#log) for anything that changes a decision or a number in the plan, such as a measured WASM speed.

## Overview

| Phase | Status | Done when (short; full checks in plan.md §5) |
|---|---|---|
| Plan | done (D3 changed by you to WebP) | Decisions answered and folded into plan.md |
| P0 Foundation | done, except CI (waiting D7) | Build works with the WASM copied in; Inspector lists 5 stub tools; CI passes on 3 operating systems |
| P1 Core engine | done, except the real kill-and-resume check | Fixtures, including collision cases, optimised at fixed qualities; a killed run resumes cleanly |
| P2 Quality | done; P2.3 and P2.8 moved to T1 | Score parity ±0.5; ≤ 1 s per score; ≤ 6 s per 2 MP per width; within 3% of an exhaustive sweep |
| P3 MCP layer | done, except the 200-image Inspector run | 200-image batch in the Inspector; repeat call returns the same `jobId`; cancel leaves no temp files |
| P4 Delivery features | done | Per-image sizes are right; markup is correct; re-runs skip or redo correctly |
| P5 Docs | done | Every doc except `benchmarks.md` written, and snippets checked against client docs |
| T1 Test and tune | todo | All seven T1 checks in plan.md pass |
| R1 Release | doing | Repo `atiquefiroz/squoosh-mcp` is public, CI is green, 0.1.0 is on npm, and later releases publish from CI |

## Tasks

### P0 Foundation
| ID | Task | Status | Where | Notes |
|---|---|---|---|---|
| P0.1 | `git init`; `main` holds released code only; `develop` plus a branch per phase | done |  | You chose to commit the first release straight to `main` (D8). Later work goes on branches |
| P0.2 | `package.json` (exact versions, `engines >=22.17.0`, `bin`, `mcpName`), shrinkwrap, strict `tsconfig`, prettier | done | package.json, tsconfig*.json | `mcpName` is `io.github.atiquefiroz/squoosh-mcp`; `repository`, `homepage` and `bugs` point at the GitHub repo. TypeScript 7 with `erasableSyntaxOnly`. No prettier yet |
| P0.3 | vitest, and an in-memory MCP client test harness | done | vitest.config.ts, test/ | 47 tests, including an end-to-end MCP test over `InMemoryTransport` |
| P0.4 | Stub server: `serveStdio` and 5 stub tools; Inspector connects | done | src/index.ts, src/server.ts | Real tools rather than stubs |
| P0.5 | `wasm/ssim2` crate skeleton; build script; copy into `dist/` | done | wasm/ | `wasm/ssim2.wasm` is 190 KB; build.sh uses `cargo --locked` |
| P0.6 | GitHub repo; Actions matrix (Ubuntu, macOS, Windows × Node 22, 24, 26) | doing | .github/workflows/ci.yml | Public repo per D8. Actions are `checkout@v7` and `setup-node@v7`, the latest on 2026-11-02. Runs on the first push |
| P0.7 | LICENSE, NOTICE, README stub with the "Unofficial" line | done | LICENSE, README.md | Apache-2.0 text from apache.org |

### P1 Core engine
| ID | Task | Status | Where | Notes |
|---|---|---|---|---|
| P1.1 | `paths.ts`: sandbox, refusing the home folder and filesystem roots, and its tests | done | src/core/paths.ts | test/paths.test.ts |
| P1.2 | `discover.ts`: `fs.glob`, input allow-list, skipping our output folders (by marker) and `*.tmp-*`, limits, Windows glob handling | done | src/core/discover.ts |  |
| P1.3 | `analyze.ts`: header facts; features, class, normalised confidence; dimensions from `autoOrient` | done | src/core/analyze.ts | Wide gamut read from the ICC primaries; libvips names its P3 profile "sP3C" |
| P1.4 | Codec adapters: JPEG, WebP, AVIF (`tune: 'iq'`), PNG, GIF; codec dimension limits | done | src/core/codecs.ts | AVIF capped at 16,384 px (sharp's HEIF writer) |
| P1.5 | OxiPNG and the second quantiser via `@napi-rs/image`, with the WASM fallback | done | src/core/codecs.ts | D9 |
| P1.6 | `resize.ts`: fit inside a box, never enlarge, linear light | done | src/core/pipeline.ts (`sourcePipeline`) | No separate resize.ts |
| P1.7 | `planner.ts` output map: case-folded collision handling, mirrored folders, input-root rules | done | src/core/planner.ts | test/planner.test.ts |
| P1.8 | `output.ts`: atomic writes with Windows retry, journal, lock file, manifest compaction, crash replay | done | src/core/output.ts | test/output.test.ts covers crash replay and a torn line |
| P1.9 | Metadata, colour, ICC and HDR gain-map reporting | done | src/core/analyze.ts, pipeline.ts | When the original is kept, the note says its EXIF/XMP stays |
| P1.10 | Fixture generator: the classes, plus collision cases, EXIF rotation, CMYK, 16-bit, P3, a panorama over 16,383 px, a long GIF | done | test/fixtures/generate.ts | 16 fixtures |
| P1.11 | Dev script that optimises the fixture folder at fixed qualities, plus a kill-and-resume check | doing |  | Fixture folder optimised end to end (15/15). Journal replay is unit-tested; killing a real process mid-run is still to do |

### P2 Quality
| ID | Task | Status | Where | Notes |
|---|---|---|---|---|
| P2.1 | Build `wasm/ssim2`: fast-ssim2 (exact version), SIMD, RGBA, P3 and 16-bit input | done | wasm/ssim2 | C-ABI exports; SIMD128 |
| P2.2 | Metric worker pool; reference processed once; tile scoring above 16 MP | done | src/core/metric.ts | Tiles above 2.3 MP (two 1024 px); one session per worker; recycled above 512 MB |
| P2.3 | Score check against the reference tool (±0.5) | todo |  | Moved to T1 |
| P2.4 | Measure WASM speed and memory on a 2 MP image, and log them | done |  | See log |
| P2.5 | `search.ts`: interpolation with a bisection fallback, `targetNotMet` handling, colour-count search, tests on synthetic curves | done | src/core/search.ts | test/search.test.ts |
| P2.6 | Candidates per class, the chroma rule, pruning, starting-quality tables | done | src/core/planner.ts, pipeline.ts | The runner-up format is searched only within 1.15× of the best; +10 on presets for flat classes |
| P2.7 | `pipeline.ts`: global pool, pixel budget, `sharp.concurrency`, per-image time budget, keep-original guard | done | src/core/pipeline.ts, jobs.ts, engine.ts | Fixed a pool bug that admitted every waiter (regression test in jobs.test.ts) |
| P2.8 | Efficiency check: auto against an exhaustive sweep (within 3%, at most 6 encodes) | todo |  | Moved to T1 |

### P3 MCP layer
| ID | Task | Status | Where | Notes |
|---|---|---|---|---|
| P3.1 | `schemas.ts`: zod input and output schemas | done | src/schemas.ts |  |
| P3.2 | `server.ts`: allowed folders in descriptions, honest annotations, refusal when no folders are set | done | src/server.ts |  |
| P3.3 | `analyze_images` (header mode, plus `deep` mode with paging) | done | src/core/engine.ts |  |
| P3.4 | `optimize_images` (inline budget, `dryRun` as plan-only) | done | src/server.ts |  |
| P3.5 | `jobs.ts`: module-wide store, queue, duplicate check, overlap refusal, TTL; `get_job`, `cancel_job` | done | src/core/jobs.ts | test/jobs.test.ts |
| P3.6 | `compare_images` with bands and optional preview images | done | src/core/engine.ts |  |
| P3.7 | Progress (at most 4 per second), cancellation, paging, concise and detailed responses | done | src/server.ts | Progress throttled to 250 ms |
| P3.8 | Error messages that say how to fix the call | done |  |  |
| P3.9 | 200-image batch in the Inspector; repeat call; cancel | todo |  | Done so far: 12 real photos and 15 fixtures over stdio, a repeat call returning unchanged, and an npm tarball install. A 200-image run in the Inspector is still to do |

### P4 Delivery features
| ID | Task | Status | Where | Notes |
|---|---|---|---|---|
| P4.1 | Responsive widths (`auto` or a list, dropping widths within 15% of the next), each starting from the larger width's result | done | src/core/planner.ts |  |
| P4.2 | Crop strategies (attention, entropy, center) at the top level or per file | done | src/core/pipeline.ts |  |
| P4.3 | Markup: `urlBase`, `sizes`, lazy or `priority`, width and height | done | src/core/output.ts | D19 |
| P4.4 | Skip unchanged files using the full key from D15; fast size and modification-time check first | done | src/core/pipeline.ts |  |
| P4.5 | `files[]` per-file settings (top level, then per file) | done | src/core/engine.ts |  |
| P4.6 | `keep` and `picture` policies | done | src/core/planner.ts | Also `avif` (D3 change) |
| P4.7 | Animated images to animated WebP, with the pixel limit applied per frame | done | src/core/pipeline.ts |  |

### P5 Docs
| ID | Task | Status | Where | Notes |
|---|---|---|---|---|
| P5.1 | README: what it is, install for 6 clients (including the Codex start-up timeout note), examples, FAQ, "Unofficial" line | done | README.md |  |
| P5.2 | `docs/architecture.md`, recording what was actually built | done | docs/architecture.md |  |
| P5.3 | `docs/tools.md`, the tool reference from the schemas | done | docs/tools.md |  |
| P5.4 | `SECURITY.md`, `CONTRIBUTING.md` (including how to rebuild the WASM), `CHANGELOG.md` | done | SECURITY.md, CONTRIBUTING.md, CHANGELOG.md |  |
| P5.5 | `THIRD_PARTY_NOTICES` (fast-ssim2 BSD-2; sharp/libvips as dependencies) | done | THIRD_PARTY_NOTICES.md | fast-ssim2 BSD-2, BSD-3 and MIT texts; libm MIT |

### T1 Test and tune (after the build)
| ID | Task | Status | Where | Notes |
|---|---|---|---|---|
| T1.1 | BD-rate comparison against the pinned squoosh.app baseline, per format and class; palette against Squoosh's quantiser | todo | | Needs your 10–20 images |
| T1.2 | Measure squoosh.app's default scores per class, to calibrate `balanced` | todo | | D4 |
| T1.3 | HTML contact sheet of 100% crops for your review | todo | | |
| T1.4 | Tune thresholds, starting-quality tables, the chroma rule, AVIF chroma, dither and linear light | todo | | |
| T1.5 | 500-image run: ≤ 15 minutes and ≤ 2 GB on this Mac; timed on Linux; `npx` cold start measured | todo | | D13 |
| T1.6 | Real clients: Claude Code, Claude Desktop, Cursor, VS Code, Codex, Windsurf; README snippets copied and pasted as written | todo | | |
| T1.7 | Agent evaluation with 5 realistic requests; fix tool descriptions | todo | | |

### R1 Release (only on your go)
| ID | Task | Status | Where | Notes |
|---|---|---|---|---|
| R1.1 | Public GitHub repo `atiquefiroz/squoosh-mcp`; first commit on `main` | done |  | Public at github.com/atiquefiroz/squoosh-mcp. CI is green on 9 runs (macOS, Linux and Windows × Node 22, 24 and 26) |
| R1.2 | Publish 0.1.0 to npm | done |  | Published on 2026-11-02 by you from this Mac, after turning on 2FA for the npm account (npm refused to publish without it). Checked from an empty folder: `npx -y squoosh-mcp@0.1.0` starts, answers the MCP handshake and lists the 5 tools |
| R1.2b | Later releases from CI through trusted publishing (OIDC), then revoke the token | doing | .github/workflows/release.yml | Pushing a `vX.Y.Z` tag publishes to npm through trusted publishing and creates the GitHub release from CHANGELOG. Waiting on npmjs.com: Trusted Publisher → `release.yml`, then "Require 2FA and disallow tokens", then revoke the token (docs.npmjs.com/trusted-publishers) |
| R1.3 | MCP Registry (`server.json`, `mcp-publisher`, GitHub OIDC) | todo | | |

## Documentation

| Doc | Purpose | Status |
|---|---|---|
| [docs/README.md](README.md) | Index of the docs folder | done |
| [docs/plan.md](plan.md) | Build plan, design and decisions | approved; updated with build findings |
| [docs/progress.md](progress.md) | This tracker | done |
| [docs/research/](research/) | Research notes with sources, and the benchmark scripts | done |
| [README.md](../README.md) | User-facing: install and use | done |
| [docs/architecture.md](architecture.md) | What was built, and how | done |
| [docs/tools.md](tools.md) | Tool reference | done |
| `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE` | Project hygiene | done |
| `docs/benchmarks.md` | Comparison with Squoosh, and performance | todo (T1.1, T1.5) |

## Log

| Date | Entry |
|---|---|
| 2026-11-02 | Research done: Squoosh internals, engines and metrics (with a local benchmark), MCP conventions, competitors. Notes and scripts copied into `docs/research/` |
| 2026-11-02 | `plan.md` drafted, then revised after an independent review. Fixes: output-name collisions, journal and crash recovery, output-folder location, honest annotations, a speed and memory budget, a measurable T1 comparison (BD-rate), a palette-PNG fallback, and the phase order. Decisions are split into "need your answer" and "technical defaults" |
| 2026-11-02 | Plan approved ("build end to end"). P0–P4 built in TypeScript 7 / Node 22.17+; 47 tests pass; the npm tarball installs and runs over stdio |
| 2026-11-02 | SSIMULACRA 2 WASM measured at 0.23–0.33 s per MP. A 1 MP reference holds about 57 MB, plus 68 MB of scratch per comparison. Strip mode was 2.5× slower and was removed. Tiling replaces it: above 2.3 MP, two 1024 px tiles (centre plus most detailed), on average 1.4 points stricter than whole-image scoring and at most 0.6 more lenient (36 encodes) |
| 2026-11-02 | Bugs found end to end and fixed, each with a regression test: (1) the pixel pool admitted every waiter, giving 2.4 GB peak and 12 images in flight; (2) the tile grid covered 41% of a 1600×1600 image; (3) sharp buffers could not be transferred to the worker, so all images ≤ 2.3 MP failed; (4) P3 was missed by name matching; (5) AVIF over 16,384 px failed, and now falls back to MozJPEG |
| 2026-11-02 | Screenshot finding: palette WebP at a score of 80.7 dropped faint 1 px UI borders. Presets are now +10 for screenshots, graphics and icons (balanced → 85), at about +1 KB |
| 2026-11-02 | D3 changed by you: the default is WebP only (every current browser); `policy: "avif"` keeps AVIF. 12 photos (81 MB of PNG): WebP 5.04 MB (−93.8%), 17.0 s, 1.48 GB peak; AVIF 3.37 MB (−95.8%), 26.6 s, 1.89 GB peak. All scores 75–77 at target 75; checked visually at 100% |
| 2026-11-02 | Eight bugs found by an independent review while writing the docs, all fixed with regression tests (52 tests): probe quality outside the codec range under strict targets; duplicate-format `picture` groups; width-suffix clashes across sources (output paths are now owned per source); stale markup on `urlBase`/`priority` changes; files from interrupted writes blocking re-runs (claims are journalled before writing); a redundant final encode for WebP, JPEG and palette winners; no `offset` for `dryRun`; an unchanged key unaware of rule changes (`PIPELINE_REVISION`). 12-photo WebP run is now 14.3 s (from 17.0 s) with identical bytes |
| 2026-11-02 | Release prep (D7: owner `atiquefiroz`). Package metadata points at the repo. CI actions moved to v7. Added `release.yml` for trusted publishing. `.env` is now git-ignored, because it holds the npm token |
| 2026-11-02 | First CI run: the 3 macOS runs passed, and the 6 Linux and Windows runs failed in tests. (1) A real bug, seen on Windows: a missing path outside the allowed folders gave "Path not found", which revealed what exists outside. The sandbox now checks paths lexically first, against each folder as given and as its real path, as the official filesystem server does. (2) Two tests assumed macOS behaviour: names that ignore case, and `/` separators. 54 tests |
| 2026-11-02 | Second CI run: Linux green; Windows passed every test but could not delete `optimized/photo.webp` in clean-up (`EBUSY`). Cause: sharp's operation cache keeps files it read open; a WebP is memory-mapped (`lsof`: 3 handles with the cache, 0 without), and Windows cannot delete an open file. The CLI turned the cache off, but the tests built the engine without it. `sharp.cache(false)` and `concurrency` moved into the `Engine` constructor, so every caller gets them. 55 tests |
| 2026-11-02 | 0.1.0 published to npm, and the third CI run is green everywhere. `release.yml` now runs on `vX.Y.Z` tags, and creates the GitHub release |

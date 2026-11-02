# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0 - 2026-11-02

### Added
- First version of the MCP server: `analyze_images`, `optimize_images`, `get_job`, `cancel_job` and `compare_images`.
- Per-image decisions: classifies each image (photo, screenshot, graphic, icon, animated), tries suitable encodings, and searches for the lowest quality that meets a SSIMULACRA 2 target.
- WebP by default (lossy, lossless or palette), for support in every current browser; `policy: "avif"` adds AVIF, and `keep`/`picture` cover the source format and `<picture>` fallbacks.
- Responsive widths, crop strategies, `<picture>`/`<img>` markup, and `keep`/`picture` policies.
- Crash-safe output: atomic writes, journal, manifest, and skipping unchanged images on re-runs.
- Long batches return a `jobId` after 45 s and keep running, with progress notifications.

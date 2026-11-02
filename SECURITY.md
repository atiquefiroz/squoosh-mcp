# Security

## What the server can touch

- **Only the folders you allow.** Pass them as arguments (`npx -y squoosh-mcp /path/a /path/b`). With none, it uses the `CLAUDE_PROJECT_DIR` that Claude Code sets, but never your home folder or a filesystem root. Every path is resolved with symlinks followed and must stay inside an allowed folder. `..`, symlink escapes and null bytes are refused.
- **Reads** image files, and nothing else, inside those folders.
- **Writes** only new files in an `optimized/` folder (or the `outputDir` you give), plus `squoosh-manifest.json`, a journal and a lock file there. It never modifies or deletes source images, and it refuses to overwrite files it did not create.
- **No network.** The server makes no network requests. Image decoding and encoding happen in-process (sharp/libvips, OxiPNG) and in a WebAssembly sandbox (SSIMULACRA 2).
- **Limits:** 256 MB per input file, 268 MP per image, 10,000 files per call. Decoding goes through libvips with its pixel limit enabled.

Optimised outputs strip EXIF, GPS and XMP metadata by default (`metadata: "strip"`). One exception: when no re-encode is smaller than the source, the source file is copied as is, and the result says that its metadata was kept.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" (Security → Advisories) on this repository. Don't open a public issue. We aim to reply within 7 days.

Image decoders are the most likely attack surface. Vulnerabilities in libvips, libheif, libaom, libwebp or mozjpeg should also go to the [sharp](https://github.com/lovell/sharp) project, which ships those binaries.

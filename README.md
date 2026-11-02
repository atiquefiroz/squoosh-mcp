# squoosh-mcp

An MCP server that lets AI agents optimise images the way an expert would. It handles a whole folder at once, deciding format, size and quality separately for each image.

It uses the codecs and settings from [Squoosh](https://squoosh.app): WebP by default, plus AVIF, MozJPEG, OxiPNG and libimagequant on request. Each image gets the smallest file that still meets a visual-quality score, [SSIMULACRA 2](https://github.com/cloudinary/ssimulacra2), so you aren't guessing a quality number.

> Unofficial. Not affiliated with or endorsed by Google or the Squoosh team.

## Why

squoosh.app gives great results, but you do one image at a time, by hand, in a browser. Squoosh's batch tools apply one setting to every image, which doesn't suit a mix of photos, screenshots, logos and odd aspect ratios. squoosh-mcp lets your agent do what you would do by hand, for every image:

| For each image it… | How |
|---|---|
| Works out what it is | Photo, screenshot, graphic, icon or animation, from colour count, flat areas and edges |
| Tries the encodings that suit it | Photos: lossy WebP. Screenshots and graphics: lossless, palette or lossy WebP, whichever is smallest. Add AVIF with `policy: "avif"` |
| Finds the lowest quality that still looks right | Searches quality until the SSIMULACRA 2 score meets the target, usually in 3–6 encodes |
| Sizes it for the web | Fits a box, crops to a shape, or makes `srcset` widths, keeping each image's own aspect ratio and never upscaling |
| Never makes things worse | Keeps the original when nothing beats it; never touches your source files |
| Gives you the HTML | `<picture>`/`<img>` markup with `srcset`, `width`/`height` and lazy loading |

**Measured** on 12 phone photos (1792×2400 PNG, 81 MB in total), Apple Silicon Mac. Every image scored 75–77 against a target of 75, and at 100% zoom they're hard to tell apart from the originals.

| Policy | Output | Smaller by | Time | Works in |
|---|---|---|---|---|
| `auto` (default): WebP | 5.0 MB | 93.8% | 14 s | Every current browser (Safari 14+, iOS 14+) |
| `avif`: AVIF or WebP | 3.4 MB | 95.8% | 27 s | Safari 16.4+ and other current browsers |

## Install

You need Node.js 22.17 or newer. Give the server the folders it may read and write. It refuses everything else.

### Claude Code

```bash
claude mcp add squoosh -- npx -y squoosh-mcp /absolute/path/to/images
```

Inside a project, you can leave the path out. The server then uses the project folder (`CLAUDE_PROJECT_DIR`), but never your home folder or a filesystem root.

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "squoosh": {
      "command": "npx",
      "args": ["-y", "squoosh-mcp", "/Users/you/Pictures/site-images"]
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "squoosh": {
      "command": "npx",
      "args": ["-y", "squoosh-mcp", "${workspaceFolder}"]
    }
  }
}
```

### VS Code

`.vscode/mcp.json` (note the `servers` key):

```json
{
  "servers": {
    "squoosh": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "squoosh-mcp", "."]
    }
  }
}
```

### Codex CLI

```bash
codex mcp add squoosh -- npx -y squoosh-mcp /absolute/path/to/images
```

The first `npx` download can take longer than Codex's default 10 s start-up limit. Raise it in `~/.codex/config.toml`:

```toml
[mcp_servers.squoosh]
command = "npx"
args = ["-y", "squoosh-mcp", "/absolute/path/to/images"]
startup_timeout_sec = 30
```

### Windsurf / Devin Desktop

Same shape as Claude Desktop, in `~/.codeium/windsurf/mcp_config.json` (Windsurf) or `~/.config/devin/mcp_config.json` (Devin Desktop).

## Use

Ask your agent in plain words:

- "Optimise every image in `public/images` for the web."
- "Make the hero image responsive with srcset, and load it first."
- "Turn these product photos into 400×400 thumbnails."
- "Compress the screenshots in `docs/` losslessly."
- "What would you do with `assets/`? Don't write anything yet."

The agent calls these tools:

| Tool | What it does |
|---|---|
| `analyze_images` | Lists images with size, dimensions, transparency and animation. With `deep`, it also classifies each one and shows the plan |
| `optimize_images` | Optimises files, folders or globs. Top-level settings apply to all; `files[]` overrides them per image. `dryRun` shows the plan without writing |
| `get_job` | Waits on and pages through a long batch. Calls return after 45 s with a `jobId` and keep working |
| `cancel_job` | Stops a batch. Finished images stay and are skipped on the next run |
| `compare_images` | Scores an output against its original, with optional thumbnails |

Settings, at the top level or per file:

| Setting | Values | Default |
|---|---|---|
| `policy` | `auto` (WebP: lossy, lossless or palette, whichever is smallest) · `avif` (AVIF or WebP, whichever is smaller) · `keep` (same format as the source) · `picture` (AVIF/WebP plus a JPEG/PNG fallback for `<picture>`) | `auto` |
| `target` | `small` · `balanced` · `high` · `lossless-look` · a number 30–100 (100 = lossless) | `balanced` |
| `resize` | `{ maxWidth, maxHeight }`: fit inside, never upscale | none |
| `crop` | `{ width, height, strategy: attention \| entropy \| center }` | none |
| `widths` | `"auto"` (640/960/1280/1920/2560 up to the image's width) or a list | none |
| `priority` | `true` for above-the-fold images (eager loading, `fetchpriority="high"`) | `false` |
| `metadata` | `strip` (removes EXIF/GPS after auto-rotating) · `all` | `strip` |

The `balanced` preset targets 75 for photos and 85 for screenshots, graphics and icons. The metric is tuned on photos and doesn't weigh faint 1-pixel UI lines heavily enough, so flat content gets a higher target.

## Output

New files go to an `optimized/` folder inside each input folder, mirroring its subfolders; you can set `outputDir` instead. Originals are never modified.

```
images/
  hero.jpg
  logo.png
  optimized/
    hero-1920w.webp  hero-1280w.webp  hero-640w.webp
    logo.webp
    squoosh-manifest.json   ← every output, its score, and ready-to-paste markup
```

Re-running skips images whose source and settings haven't changed. If a run is interrupted, the next run picks up where it stopped.

## Supported formats

| Input | Output |
|---|---|
| JPEG, PNG, WebP, AVIF, GIF (incl. animated), TIFF | WebP (lossy, lossless, palette) by default; AVIF, JPEG (MozJPEG) and PNG (OxiPNG, palette) by policy |

Not supported yet: HEIC, SVG, BMP and ICO are skipped with a reason. Animated PNG is left as it is.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `SQUOOSH_MCP_CONCURRENCY` | min(4, cores ÷ 2) | Images processed in parallel (about 450 MB each for 4 MP images) |
| `SQUOOSH_MCP_INLINE_SECONDS` | 45 | How long `optimize_images` works before handing back a `jobId` |

## How it differs from Squoosh

squoosh-mcp runs Squoosh's codecs through [sharp](https://sharp.pixelplumbing.com) (libvips) with Squoosh's settings, plus [OxiPNG](https://github.com/shssoichiro/oxipng). That makes it fast and native rather than browser WASM. Libraries can differ in version from squoosh.app's frozen 2024 build, so outputs are close to squoosh.app's but not byte-identical. The quality score is [fast-ssim2](https://crates.io/crates/fast-ssim2), compiled to WebAssembly.

## Development

```bash
npm install
npm run build        # TypeScript → dist/, plus the prebuilt SSIMULACRA 2 WASM
npm test             # unit and end-to-end tests (in-memory MCP client)
npm run fixtures     # edge-case test images → test/fixtures/generated/
npm run inspector    # try the tools in the MCP Inspector
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

# Contributing

## Setup

```bash
npm install
npm run build     # TypeScript → dist/, copies the prebuilt wasm/ssim2.wasm
npm test          # vitest: unit tests plus an end-to-end MCP test over an in-memory transport
npm run typecheck
```

Node 22.17 or newer. The tests run TypeScript directly, including the SSIMULACRA 2 worker through Node's type stripping, so source files must use erasable syntax only: no `enum`, no `namespace`, no constructor parameter properties. `tsconfig.json` enforces this.

## Trying it

```bash
npm run fixtures                        # edge-case images → test/fixtures/generated/
npm run inspector                       # MCP Inspector against dist/index.js
node dist/index.js /absolute/folder     # plain stdio server
```

## Rebuilding the WASM metric

`wasm/ssim2.wasm` is committed, so most changes don't need Rust. To rebuild it (for example after bumping `fast-ssim2`):

```bash
rustup target add wasm32-unknown-unknown
npm run build:wasm     # cargo build --release --locked, then copies to wasm/ssim2.wasm
```

Commit `wasm/ssim2/Cargo.lock` along with the new `.wasm`, and update `THIRD_PARTY_NOTICES.md` if the crate list changes.

## Where things live

| Path | What |
|---|---|
| `src/server.ts` | The 5 MCP tools: descriptions, annotations, result shapes |
| `src/core/pipeline.ts` | Per-image decisions: classify → sizes → codec search → keep-original guard → write |
| `src/core/metric*.ts` | SSIMULACRA 2 worker pool and tiling |
| `src/core/output.ts` | Atomic writes, journal, manifest, lock, markup |

## Changes

- Keep pull requests small, with a test for every behaviour change. Bugs get a regression test.
- If a change affects the default output, show before and after numbers (bytes and score) on the fixtures.
- Update `CHANGELOG.md` under "Unreleased".

## Releasing

1. In `CHANGELOG.md`, move the "Unreleased" notes under a `## X.Y.Z - YYYY-MM-DD` heading and commit.
2. Run `npm version <patch|minor|major>`. This bumps `package.json`, commits, and creates the `vX.Y.Z` tag.
3. Run `git push --follow-tags`.

The tag starts `.github/workflows/release.yml`. It builds, tests and publishes to npm through trusted publishing, so no npm token is needed and npm adds provenance itself. It then creates the GitHub release with that version's CHANGELOG notes. Re-running it is safe: a version already on npm is not published again.

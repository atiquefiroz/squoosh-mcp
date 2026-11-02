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
| `docs/` | [Plan](docs/plan.md), [progress](docs/progress.md), [architecture](docs/architecture.md), [tool reference](docs/tools.md) |

## Changes

- Keep pull requests small, with a test for every behaviour change. Bugs get a regression test.
- If a change affects the default output, show before and after numbers (bytes and score) on the fixtures.
- Update `CHANGELOG.md` under "Unreleased".

## Releasing

1. Move the "Unreleased" notes in `CHANGELOG.md` under the new version, then run `npm version <patch|minor|major>`. This commits and creates the `vX.Y.Z` tag.
2. Push the commit and the tag: `git push --follow-tags`.
3. Publish a GitHub release for that tag. `.github/workflows/release.yml` builds, tests and publishes to npm through trusted publishing, so no npm token is needed and npm adds provenance itself.

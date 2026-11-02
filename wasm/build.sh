#!/bin/sh
# Rebuilds wasm/ssim2.wasm from the pinned fast-ssim2 crate. Needs rustup with the
# wasm32-unknown-unknown target. The built file is committed, so CI and users need no Rust.
set -eu
cd "$(dirname "$0")/ssim2"
PATH="$HOME/.cargo/bin:$PATH" cargo build --release --locked 2>&1 | tail -3
cp target/wasm32-unknown-unknown/release/squoosh_mcp_ssim2.wasm ../ssim2.wasm
ls -l ../ssim2.wasm

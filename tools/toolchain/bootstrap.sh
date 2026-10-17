#!/usr/bin/env bash
# Install the pinned core-build toolchain on macOS or Linux.
#
#   tools/toolchain/bootstrap.sh            # into ./.tools (WASM_TOOLCHAIN_DIR overrides)
#
# Everything comes from provenance/wasm-toolchain.lock.json:
#   - emsdk at a fixed commit, then `emsdk install <version>`, which resolves to
#     a fixed emscripten-releases build (checked below);
#   - a dated Rust nightly with rust-src and the wasm32-unknown-emscripten target
#     (rustup must already be installed; RUSTUP_HOME/CARGO_HOME are honoured);
#   - CMake and Ninja from hash-locked PyPI wheels in a private virtualenv.
# The script is idempotent. `npm run verify:toolchain` checks the result
# against the per-platform binary hashes in the lock.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lock="$root/provenance/wasm-toolchain.lock.json"
dir="${WASM_TOOLCHAIN_DIR:-$root/$(node -p "require('$lock').posix.toolchainDir")}"
field() { node -p "require('$lock').$1"; }

emsdk_repo="$(field posix.emsdk.repository)"
emsdk_commit="$(field posix.emsdk.commit)"
emsdk_version="$(field emscripten.version)"
releases_hash="$(field posix.emsdk.releasesHash)"
rust_toolchain="$(field posix.rust.toolchain)"
rust_target="$(field rust.target)"

mkdir -p "$dir"

echo "== emsdk $emsdk_commit / emscripten $emsdk_version"
if [ ! -d "$dir/emsdk/.git" ]; then
  git clone --quiet "$emsdk_repo" "$dir/emsdk"
fi
git -C "$dir/emsdk" fetch --quiet origin "$emsdk_commit" 2>/dev/null || true
git -C "$dir/emsdk" checkout --quiet --detach "$emsdk_commit"
resolved="$(node -e "
  const t=require('$dir/emsdk/emscripten-releases-tags.json');
  process.stdout.write(t.releases['$emsdk_version']||'')")"
if [ "$resolved" != "$releases_hash" ]; then
  echo "emsdk $emsdk_commit maps $emsdk_version to '$resolved', lock expects $releases_hash" >&2
  exit 1
fi
(cd "$dir/emsdk" && ./emsdk install "$emsdk_version" && ./emsdk activate "$emsdk_version" >/dev/null)

echo "== Rust $rust_toolchain"
rustup toolchain install "$rust_toolchain" --profile minimal \
  --component rust-src --target "$rust_target" --no-self-update

echo "== CMake / Ninja (hash-locked wheels)"
python="${PYTHON:-python3}"
if [ ! -x "$dir/python/bin/python" ]; then
  "$python" -m venv "$dir/python"
fi
"$dir/python/bin/python" -m pip install --quiet --disable-pip-version-check \
  --require-hashes --only-binary=:all: -r "$root/tools/toolchain/requirements.txt"

echo "Toolchain ready in $dir"

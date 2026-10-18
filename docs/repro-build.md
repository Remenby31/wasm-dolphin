# Reproducible upstream-core build

The repository fetches upstream Dolphin into the gitignored `vendor/dolphin/`
tree, verifies and applies the browser patch snapshot, configures an
Emscripten/Ninja build, and writes the browser core into `cores/dolphin/`.

## macOS, Linux and Docker: one command

```sh
npm run build:core:repro                      # native macOS (Apple Silicon) or Linux
npm run build:core:repro -- --docker          # same build in tools/toolchain/Dockerfile
npm run build:core:repro -- --clean           # discard the CMake tree first
npm run build:core:repro -- --install         # also replace cores/dolphin and the ABI manifest
```

The command installs the pinned toolchain if it is missing
(`tools/toolchain/bootstrap.sh`), verifies it, fetches and patches
`vendor/dolphin` from the source lock, configures, builds `dolphin_web_core`,
and compares the result with the committed core. Per host platform `P`
(`darwin-arm64`, `linux-x64`, `linux-arm64`) it writes:

| Path | Content |
| --- | --- |
| `build/repro/P/dolphin-wasm/` | CMake/Ninja tree, reused by the next run |
| `build/repro/P/core/` | `dolphin-core-upstream.{js,wasm,build.json}` |
| `build/repro/P/parity.json` | toolchain observed, timings, section and glue diff against `cores/dolphin` |
| `build/core-candidates/<sha256>/` | the candidate, loadable with `?coreid=sha256:<sha256>` |

Other flags: `--no-sync` builds `vendor/dolphin` as it stands (while you edit
it before regenerating a patch), `--allow-dirty` records a build from an
uncommitted tree, `--jobs N`, `--ccache` (compile through the pinned ccache,
see "Pull request CI"), `--reset-vendor` (discard every change under
`vendor/dolphin` before syncing; needed once main's patch series has changed
under an already patched tree, which `fetch:dolphin` otherwise refuses).
Docker only: `--docker-platform linux/amd64`, `--bind-mounts` (no named
volumes, used by CI), `--image-only`.

Safety rails:

- **One CMake tree per build identity.** The identity is the checkout path,
  the source lock and the toolchain lock. It is stamped into the CMake tree,
  and a tree with another stamp (or none) is emptied before configuring:
  Ninja trusts timestamps and would otherwise link objects compiled from other
  sources under this checkout's provenance. Docker volumes are named after it
  (`wasm-dolphin-cmake-<arch>-<identity>`, `wasm-dolphin-vendor-<source lock>`).
  The output directory carries its own stamp, written only after a successful
  build, so going from patch series A to B and back to A relinks A instead of
  keeping B's binary under A's record.
- **`--install` cannot leave `cores/dolphin` half-replaced.** It refuses a
  core whose glue loses an export, a runtime method or WORKERFS
  (`--force-install` overrides). It then backs up the five files it rewrites
  (the three artifacts, `core.lock.json` and the ABI manifest), renames
  the new artifacts into place, and runs `update:core-abi` and
  `verify:provenance`. On any failure every file is restored, and files that
  did not exist before are removed.
- **`verify:toolchain` checks the tools actually used.** It refuses
  variables that redirect emcc or cargo (`EM_CONFIG`, `EM_LLVM_ROOT`,
  `EM_BINARYEN_ROOT`, `EMCC_CFLAGS`, `RUSTFLAGS`, `RUSTC_WRAPPER`,
  `CARGO_BUILD_*`, `CARGO_PROFILE_*`, ...; `EMSDK_PYTHON` only when it points
  outside the locked SDK, since activating the SDK sets it). It also asks `em-config` for
  `LLVM_ROOT` and `BINARYEN_ROOT` and requires the hashed emsdk directories.
- **Paths with whitespace** (possible on Windows) cannot be carried by the
  CMake flag string. They are left unmapped with a warning, as before the maps
  existed, so the build still works but embeds that path
  (`unmappedPaths` in the configure record).

### What is pinned on macOS/Linux

`provenance/wasm-toolchain.lock.json` keeps the Windows record and adds a
`posix` block. Everything comes from it; nothing is taken from `PATH`.

| Input | Pin |
| --- | --- |
| emsdk | commit `bafd64c`, `emsdk install 5.0.7`, checked to resolve to emscripten-releases `6cd98e86` |
| Emscripten JS/Python layer | `emscriptenTreeSha256`: one digest over `emcc.py`, `src/`, `tools/`, `system/include`, `system/lib` (6,043 files). Identical on every host. This is the layer that decides what the JS glue contains (issue #13). |
| clang, wasm-ld, wasm-opt, rustc, cargo, cmake, ninja | SHA-256 of each binary, per platform |
| Rust | `nightly-2026-05-15` (rustc `7c3c88f`, the commit the Windows lock records), with `rust-src` |
| CMake 4.3.2, Ninja 1.13.0 | PyPI wheels installed with `--require-hashes` (`tools/toolchain/requirements.txt`) |
| Docker base | `node:24.12.0-bookworm` by digest, `rustup-init` 1.29.0 by SHA-256 |
| Naga crates | `Cargo.lock` checksums, `cargo build --locked` |

The `emdawnwebgpu` port is downloaded by Emscripten during the build; its
version and SHA-512 are part of the hashed Emscripten tree.

`npm run verify:toolchain` fails closed on any mismatch. After a deliberate
toolchain change, `npm run toolchain:record -- --write` records the current
host; review and commit the diff.

### Making the binary independent of where it is built

Absolute paths reached the core in three places: `__FILE__` in Dolphin
(about 300 strings), Rust panic locations from `rust-src`, and crate sources
under `$CARGO_HOME/registry/src/<source>-<hash>`. The last one even depends
on the host's cargo configuration (a crates.io mirror gets its own directory
name). `configure-upstream-wasm.mjs` now maps the checkout onto
`/wasm-dolphin`, `rust-src` onto `/rustc/<commit>` and every registry source
onto `/cargo/registry/src/crates.io`. It also takes the Naga archive cargo
reports for the build instead of whichever of two file names exists, which
let a stale archive win (issue #13, R6a).

### GPL corresponding source

`npm run dist:source` writes `dist/wasm-dolphin-corresponding-source-v<version>.tar.gz`
(about 220 MB). It holds every tracked file of the repository (the browser
front end included), the patched `vendor/dolphin` without history, and
`tools/naga-spirv-wgsl/vendor/`: every crate linked into the core through
Naga, std's own dependencies included (std is rebuilt from `rust-src`). It
keeps the repository layout. Extract it and run
`npm run build:core:repro -- --no-sync`: the crates build offline from the
vendored copy, and their paths map onto the same virtual root as registry
crates. A rebuild from the archive gives the same bytes as a rebuild from the
checkout (checked on macOS: `83514d0e…` both ways). Dolphin bakes the
output of `git rev-parse`/`git describe` on `vendor/dolphin` into `scmrev.h`;
the archive has no `.git`, so on macOS/Linux configure points Dolphin at a
shim that answers with the locked commit, exactly as git does on a checkout. CI rebuilds the core from
the published archive alone and fails if its hash differs from the checkout
build.

### Results (2026-10-17)

| Build | `.wasm` SHA-256 | Bytes |
| --- | --- | ---: |
| committed `cores/dolphin` | `d7395b3a…` | 15,175,335 |
| macOS arm64, native | `83514d0e…` | 12,950,792 |
| Docker linux/arm64 | `6eed0799…` | 12,950,791 |
| GitHub Actions linux/x64 (reference) | `046badc7…` | 12,950,793 |

- **macOS vs Linux.** The JS glue is identical. Relinking the macOS build
  against the Linux Naga archive gives `6eed0799…`, byte for byte the Docker
  core: all C++ and everything Emscripten contributes is bit-reproducible
  across hosts. What differs is the Rust part (Naga and the std it rebuilds);
  see "The Rust part depends on the build host" below. The CI build
  (linux/x64, `tools/toolchain/Dockerfile`) is the reference;
  `--docker-platform linux/amd64` reproduces it locally.

### The Rust part depends on the build host

Cargo hashes the output of `rustc -vV`, host triple included, into each
crate's metadata (`naga_spirv_wgsl-87cb3c…` on macOS, `-5dee1c…` on Linux).
That hash is part of every Rust symbol name, and symbol names decide the order
in which LTO lays out Rust functions and constants. So a core whose Naga was
built on macOS and one whose Naga was built on Linux, from identical sources
and toolchain versions:

- **differ in layout, not in content.** Comparing `83514d0e…` (macOS) with
  `6eed0799…` (same C++, Linux Naga): type, import, export, global and
  element-count sections are identical. The code section is 1 byte shorter
  and the data section is the same size with the same strings, but functions
  and constants sit in a different order, so most aligned byte positions of
  the code section differ. The function and element sections differ only by
  the resulting index shifts. The JS glue is identical. This is not a 1 or
  2 byte patch: the hashes differ completely;
- **behave the same.** Naga runs only in the WebGPU renderer, where it turns
  Dolphin's SPIR-V into WGSL. In `video=wgpu` on acube, gxSprites and lesson10
  (headed Chrome 155, Apple M4 Pro, load average 20 to 34, 3 alternating runs
  per core, `core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&metrics=1`):
  speed 96–107 % on both, unique visuals ~60/s on both, same JIT block
  counts, no shader, WGSL or WebGPU validation error on either. The static
  lesson10 frame is pixel-identical between the two cores in all three pairs.
  The software renderer does not call Naga at all;
- **change which hash is canonical.** A core is reproducible on the platform
  it was built on, so the canonical core is the one CI builds
  (linux/x64). A macOS build of the same sources gets another hash, and
  `core:fetch` and `?coreid=` must use the hash of the build in question.
  CI rebuilding from the source archive, the incremental-equals-clean check,
  and the publishing jobs all run on linux/x64, so main never mixes the two.

Removing the dependency would need Cargo not to hash the host into crate
metadata (no stable switch for that today) or building Naga in the pinned
Linux image on every host. Neither is done here.

- **Rebuilt vs committed.** Not byte-identical, and cannot be:
  1. the committed core carries a 2.2 MB `name` section (it was built with
     `PROFILING_FUNCS=1`); a default build has none;
  2. it embeds 360 Windows paths (`G:/wasm-dolphin/.claude/worktrees/…`,
     `C:\Users\…\.cargo\registry\…`, `G:\home\…\rustup\…`) with mixed
     separators; the data section is 18 KB smaller once they are mapped;
  3. its glue has `FS.filesystems={MEMFS}` where a macOS/Linux build has
     `{MEMFS,NODEFS,WORKERFS}`. Emscripten builds that registry from
     `LibraryManager.has('libworkerfs.js')`, an exact string comparison of
     library paths (`src/modules.mjs:248`). On Windows the path forms differ
     and the test fails; on macOS/Linux it passes. This is the issue #13
     symptom seen from the other side. It is harmless: the worker reaches
     WORKERFS through `Module.WORKERFS`, which patch 0052 exports and both
     builds have. Exports and runtime methods are identical.

  Type, import, function, global and export sections have identical sizes;
  the code section differs by 13 bytes. Behaviour and performance parity are
  measured below.

### Behaviour parity, committed vs rebuilt (macOS build `83514d0e…`)

Headed Chrome 155 on an Apple M4 Pro, 3 alternating runs per pair, served by
`tools/serve.mjs` on 127.0.0.1. Load average 11 to 32 during the runs (shared
machine). The rebuilt core is loaded with `&coreid=sha256:83514d0e…`; the
network log confirms the candidate JS and WASM were the ones executed. REC
config: `core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1`.
Mean (min to max) of 1 s samples after a fixed warm-up (25 s homebrew, 70 s
MKDD).

| Disc | Core | Speed % | Presented/s | Unique visuals/s | JIT blocks |
| --- | --- | --- | --- | --- | --- |
| acube | committed | 99.9 (97.6–101.5) | 54.9 | 35.7 (35.3–36.4) | 267 |
| acube | rebuilt | 100.5 (97.5–102.4) | 55.3 | 35.1 (34.1–36.4) | 267 |
| gxSprites | committed | 100.6 (100.0–101.0) | 57.8 | 48.5 (41.1–52.4) | 230–231 |
| gxSprites | rebuilt | 98.2 (96.7–100.7) | 58.5 | 51.3 (49.2–55.2) | 230 |
| lesson10 | committed | 99.4 (97.1–100.9) | 59.5 | static | 340–341 |
| lesson10 | rebuilt | 97.4 (97.0–97.8) | 59.7 | static | 340 |
| commercial disc (intro to title) | committed | 100.1 (99.4–101.0) | 56.4 | 18.3 (17.4–19.3) | 4,059–4,112 |
| commercial disc (intro to title) | rebuilt | 100.4 (99.6–101.0) | 57.1 | 18.0 (17.2–18.8) | 4,068–4,097 |

Same behaviour in every case: the discs boot, the JIT engages and compiles
the same number of blocks, frames are visually correct. Homebrew images are
the devkitPro examples wrapped by `homebrew/gcm/mkgcm.py`; the commercial
disc is the user's own and is not part of the repository or CI.

Unlimited-speed throughput, lesson10, `speed=unlimited&video=null&wasmjit=N&jitwarmup=700&metrics=1`,
6 pairs without JIT (3 in each order) and 3 with JIT:

| Config | committed (mean) | rebuilt (mean) |
| --- | ---: | ---: |
| `wasmjit=0` (CachedInterpreter) | 1,848 % | 1,758 % |
| `wasmjit=1` | 1,081 % | 1,059 % |

Without the JIT the rebuilt core was slower in 5 of 6 pairs (mean −4.9 %,
paired t ≈ 2.5, n = 6), inside the ±10 % run-to-run spread of this loaded
machine. It is not visible at `speed=1` nor with the JIT. Treat it as
unconfirmed; it should be re-measured on a quiet machine.


### Build times

Measured on the shared Apple M4 Pro (14 cores), `--jobs 10`, load average in
parentheses. Docker Desktop VM: 14 CPUs, 29 GB.

| Run | Total | Detail |
| --- | ---: | --- |
| macOS, clean (toolchain present, sources fetched) (80 to 107) | 1,205 s | sync 117 s, configure 610 s, compile and link 471 s |
| Docker linux/arm64, clean (25) | 534 s | configure 134 s, compile and link 392 s |
| Docker toolchain image, first build | 714 s | once per toolchain change; content-addressed tag |
| macOS, nothing changed, `--no-sync` (19) | 7.5 s | |
| macOS, one `.cpp` changed (shim or Dolphin), `--no-sync` (13 to 19) | 80 s | 75 s is the LTO link |
| macOS, Naga rebuilt, with sync (22) | 154 s | sync 37 s, configure 37 s, link 78 s |
| GitHub Actions `ubuntu-24.04`, 4 vCPU, clean | 1,419 s | sync 59 s, configure 252 s, compile and link 1,105 s |
| GitHub Actions, one `.cpp` touched | 151 s | link 146 s |
| GitHub Actions, whole workflow (cached image) | 32 min | build, incremental, check, test, test:contract, dist:source |

CI fails if the incremental rebuild's hash differs from the clean build's.

Rebuilding after touching a source without changing it produces the same
`.wasm` hash. For C++ work, edit `vendor/dolphin` or `core/upstream`, iterate
with `--no-sync`, then regenerate the patch and lock (`npm run update:provenance`)
and run once without `--no-sync`.

### Sharing one toolchain and one Dolphin tree between worktrees

The toolchain (2 GB) and the patched `vendor/dolphin` (1.3 GB) do not need a
copy per worktree:

```sh
export WASM_TOOLCHAIN_DIR=/path/to/shared-checkout/.tools
ln -s /path/to/shared-checkout/vendor vendor     # ignored by git
npm run build:core:repro
```

The sync step verifies that the shared tree is exactly the locked snapshot
and leaves it alone. Each worktree keeps its own `build/repro/` (0.5 to 0.7
GB), because the CMake flags embed the checkout path. A worktree that edits
Dolphin itself (patch work) needs its own `vendor/`.

## Who builds the committed core

Pull requests change sources and patches only. They never carry
`cores/dolphin/dolphin-core-upstream.{js,wasm,build.json}`, the default-core
hash in `cores/dolphin/core.lock.json`, or the binary-derived fields of
`provenance/dolphin-core-abi-v1.json` (`coreId`, `artifacts`, `moduleExports`,
`runtimeMethods`, `memoryContract`, `memoryContractStatus`). CI owns all of
these, so C++ pull requests no longer conflict with each other on a 13 MB
binary and can be merged in any order.

| Where | What happens |
| --- | --- |
| Pull request CI | If the pull request changes a core input, builds the core from the branch's sources (through ccache, see "Pull request CI" below), installs it in the workspace, runs `check`, `test` and `test:contract` on it, and publishes it as the artifact `core-<sha256>`. Otherwise runs the same tests on main's committed core. |
| Merge to main | The build job builds **main's tip as it is when the run starts** (so re-running an old run builds the current HEAD), with no cache, checks it against a ccache build and an incremental rebuild, publishes the GPL source archive, and rebuilds the core from that archive alone. Two jobs then publish it, see below. |
| Locally | `npm run build:core:repro -- --install` installs a core for testing. Do not commit it; `npm run core:restore -- --base origin/main` puts main's back. |

Why commit the core on main instead of keeping only a signed build record and
downloading the binary: the site and the agents serve the core from the
repository, same origin, under COOP/COEP. Actions artifacts expire after 90
days. And main's history is then the complete index from a core hash to its
exact bytes, with its build record next to it.

Commands (`tools/core-artifacts.mjs`):

| Command | What it does |
| --- | --- |
| `npm run core:status` | Says whether `cores/dolphin` is the build of this checkout's sources and locks: the build record's source identity, toolchain lock and Cargo lock against the tree, and the artifacts, ABI manifest and pinned hash against each other. On a branch that changes the C++ it is expected to say no. CI requires yes after installing its build and before committing on main. |
| `npm run core:check` | Lists core-derived content this branch changes. A file counts when it differs from both the merge base and `origin/main`, so a branch started before main's newer core is not flagged, and main's current core is allowed. |
| `npm run core:restore -- --base origin/main` | Puts main's core back on a branch and keeps the branch's source-side ABI changes. Exports the branch's own build added move to `sourceOnlyExportsPendingRebuild` (the existing mechanism for sources ahead of the core), and contract-source hashes are recomputed. |
| `npm run core:fetch -- <sha256> [--repo owner/name]` | Writes an exact core to `build/core-candidates/<sha256>/`, loadable with `?coreid=sha256:<sha256>`. It looks in local builds, then in every commit of git history, then in the `core-<sha256>` Actions artifact (needs `gh`). The `.wasm` hash is checked. |
| `npm run hooks:install` | Installs `tools/hooks/pre-commit`, which refuses a commit that stages core-derived content (`CORE_ARTIFACTS_ALLOW=1` overrides). Git keeps hooks per clone, so every worktree of the clone gets it. |

The hash of the core the browser accepts by default is data:
`cores/dolphin/core.lock.json` (`{"schemaVersion":1,"sha256":"…"}`), which
`src/upstream-worker-protocol.js` imports as a JSON module. Only
`update:core-abi` writes it (`tools/core-lock.mjs`), and no tool parses or
evaluates JavaScript to find it.

Publishing on main is split so that the job able to write runs no code from
the repository:

| Job | Can write | What it does |
| --- | --- | --- |
| `prepare-core-commit` | no | Checks out main's current tip and runs `publish-plan`, which decides on content: `none` (HEAD's committed core is already the build of HEAD's sources), `dispatch` (the build's sources or locks are not HEAD's; decided before anything is installed, so it cannot fail on a core HEAD no longer accepts), or `commit` (installs the core, regenerates the ABI manifest, commits; any inconsistency fails the job). The plan is one JSON file checked with `jq -e` under `set -euo pipefail`. For `commit` it also runs `core:status` and `verify:provenance`, and bundles exactly that commit. |
| `push-core` | yes | No checkout, no Node. A fresh `--no-checkout` clone of main with user and system git configuration off and `core.hooksPath=/dev/null`. It checks the bundle with git plumbing: one commit, parent = the planned base = main's tip, only the five core files changed, `.wasm` blob hash = the hash built = `core.lock.json`. Then it pushes. If main moved, or the plan is `dispatch`, it starts a new run on main with an `attempt` counter; after 3 hand-overs it fails the job instead. The token is passed only to `git push` and `gh workflow run`. |

Runs on main queue instead of cancelling each other. A push made with
`GITHUB_TOKEN` starts no new run, and the next run on main finds the core
current.

The pull-request guard warns until the repository variable
`CORE_ARTIFACTS_GUARD` is `enforce`. After that, a pull request carrying a
core fails:

```sh
gh variable set CORE_ARTIFACTS_GUARD --body enforce -R Remenby31/wasm-dolphin
```

### Moving an open pull request to this scheme

Once this scheme is on main, for each open pull request that carries a core
(or simply predates `core.lock.json`):

```sh
git fetch origin
git merge origin/main
# 1. Resolve your own source conflicts as usual (patches, src/, package.json).
#    Leave cores/dolphin/*, provenance/dolphin-core-abi-v1.json and the
#    DEFAULT_UPSTREAM_CORE_SHA256 hunk of src/upstream-worker-protocol.js alone.
# 2. Then, last:
npm run core:restore -- --base origin/main
git status                     # nothing left unmerged
npm run core:check             # "No core-derived changes"
git commit --no-edit           # or git commit -am "Leave the core to CI" outside a merge
git push
```

`core:restore` puts main's core files and `core.lock.json` back, resolves
the one conflict this scheme creates in `src/upstream-worker-protocol.js`
(the branch's old hash line against main's `core.lock.json` import; any
other hunk there is left to you), and rebuilds the ABI manifest from the
branch's side: main's binary fields, the branch's source-side fields,
contract hashes recomputed, and exports the branch's own build added listed
as `sourceOnlyExportsPendingRebuild`. Run it after your own conflicts are
resolved, so contract hashes describe the final files. Checked on a copy of
#11 (JIT, patch 0071) merged with this branch: only an unrelated
`package.json` hunk remained, `verify:provenance` passed, and the guard was
clean after the commit.

The branch then carries only its sources; its CI builds and tests its own
core, and the merge commits it. Tests that read the binary run in CI on the
branch's core. Locally they run on main's core unless you
`npm run build:core:repro -- --install` first; `core:status` saying "not
the build of these sources" on such a branch is expected.

### Turning the guard on

When no open pull request carries a core any more
(`npm run core:check` on each, or the warning in its CI log):

```sh
gh variable set CORE_ARTIFACTS_GUARD --body enforce -R Remenby31/wasm-dolphin
```

From then on the "No core binaries in the pull request" step fails instead of
warning. `gh variable delete CORE_ARTIFACTS_GUARD -R Remenby31/wasm-dolphin`
turns it back to warnings. The local hook (`npm run hooks:install`) is
optional and per clone.

## Pull request CI

A pull request is tested in the cheapest way that still tests what it changes;
main keeps every check.

| Pull request changes | CI path | Before | After |
| --- | --- | ---: | ---: |
| JavaScript, tests, docs only | `fast-tests`: no Docker, no core build | MEASURE_JS_BEFORE | MEASURE_JS_AFTER |
| a shim `.cpp` | `build`, everything cached | MEASURE_CPP_BEFORE | MEASURE_CPP_AFTER |
| a Dolphin patch | `build`, ccache warm, CMake tree rebuilt | MEASURE_PATCH_BEFORE | MEASURE_PATCH_AFTER |

MEASURE_NOTES

**Which path.** `tools/ci-changes.mjs` lists the paths that can change the
core, its build or CI: `core/`, `patches/`, `cores/`, `.github/`, the locks
under `provenance/` (not the ABI manifest, whose contract hashes follow
`src/`), `tools/toolchain/`, `tools/naga-spirv-wgsl/` and the build tools
themselves. A pull request touching none of them takes `fast-tests`, but only
if `core:status` also says main's committed core is the build of the pull
request's sources; otherwise (for instance right after a C++ merge, before CI
has committed main's new core) it builds. So the fast path can never test
against a core that does not match the sources.

**What is cached, and why the bytes cannot change.**

- ccache 4.14.1, pinned by SHA-256 in the toolchain lock and installed by
  `bootstrap.sh`, wraps `em++`. Its entries are keyed on the pinned toolchain
  (`CCACHE_COMPILERCHECK`), not on `em++`, a script that does not change when
  the compiler behind it does. `CCACHE_BASEDIR` is deliberately not set: it
  rewrites absolute paths in the compiler's arguments as relative ones,
  `-ffile-prefix-map` then no longer matches them, and 284 `__FILE__` strings
  and the core's hash changed (found on macOS: `57a375d2…` instead of
  `aa9e3e89…`).
- The CMake tree, keyed by build identity (checkout path, source lock,
  toolchain lock), so a C++ pull request skips the CMake probes. Every source
  is checked out fresh, so Ninja still recompiles everything, through ccache.
  A Dolphin patch changes the source lock, hence the identity: that pull
  request configures from scratch.
- Emscripten's cache (system libraries) and Naga's Cargo target directory,
  keyed by the toolchain and Naga's lock files.
- Only runs on main write these caches; pull requests only read them.

On main, a ccache build from a clean tree, a reference build with no cache of
any kind (no ccache, clean CMake tree, fresh Emscripten cache and Naga
target), and an incremental rebuild must all give the same bytes, or the run
fails before anything is published. The published core is the reference
build. Locally: two ccache builds of main's sources on macOS, one cold and one
warm (1,306 of 1,306 hits), both gave `aa9e3e89…`, main's committed core,
built without ccache.

| macOS, from a clean tree, `--jobs 10` | configure | compile and link | total |
| --- | ---: | ---: | ---: |
| `--ccache`, cold | 240 s | 361 s | 633 s |
| `--ccache`, warm (100 % hits) | 239 s | 90 s | 364 s |

The remaining cost of a cached build is the CMake probes (skipped when the
tree is restored) and the LTO link, which no cache helps.

## Toolchain record

The committed `provenance/wasm-toolchain.lock.json` pins the exact local
toolchain used for the research core. `npm run verify:toolchain` rejects a
version or executable hash mismatch before configuration.

| Component | Version/revision |
| --- | --- |
| Node.js | `24.12.0` |
| Emscripten SDK | `5.0.7`; compiler `263db4cffa6f9fc2ec514a70abac81362ea41849`; emsdk `bafd64c26bdaf10bd829163d1575b50b759a72d8` |
| CMake | `4.3.2` |
| Ninja | `1.13.0.git.kitware.jobserver-pipe-1` |
| Rust nightly | `1.97.0-nightly`; rustc `7c3c88f42ad444f4688b865591d84660be4ece2f` |
| Rust target | `wasm32-unknown-emscripten` |
| Naga | `26.0.0`, with the full Cargo graph locked |
| Chrome | `149.0.7827.201` for headed diagnostics; record each performance run separately |
| Upstream Dolphin commit | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |

The Naga static library uses nightly Rust because its Emscripten pthread build
rebuilds `std` with atomics and bulk-memory support. Install nightly plus
`rust-src`, add the `wasm32-unknown-emscripten` target, and build the crate as
documented in [the bridge guide](webgpu-naga-bridge.md) when the hardware
WebGPU shader path is required.

## Commands

From a clean repository checkout in PowerShell:

```powershell
npm install
npm test
npm run check
npm run verify:provenance
npm run verify:toolchain
npm run fetch:dolphin
npm run patch:upstream
npm run configure:upstream
npm run build:upstream:full-core
```

The final target produces:

- `cores/dolphin/dolphin-core-upstream.js`
- `cores/dolphin/dolphin-core-upstream.wasm`
- `cores/dolphin/dolphin-core-upstream.build.json`

The build script also packages an ignored, content-addressed candidate under
`build/core-candidates/<wasm-sha256>/`. It contains the JS, WASM, build record,
source/ABI/vendor/toolchain locks, Cargo lock, and a manifest of file hashes.
Use `?coreid=sha256:<wasm-sha256>` to test it. The browser checks the full WASM
SHA-256 before execution and rolls a rejected candidate back to the pinned
baseline before transferring the canvas.

`fetch:dolphin` reads `provenance/dolphin-source.lock.json`, fetches the exact
commit above, verifies the fetched object, and checks it out detached. It never
uses a moving branch head. `patch:upstream` verifies every active patch's
canonical SHA-256, byte size, order, target repository, and base commit before
applying it. The root `HEAD` remains the pristine upstream base after patches
are applied, so this command proves only the base commit:

```powershell
git -C vendor/dolphin rev-parse HEAD
```

The durable patched identity is the virtual result tree. Re-running the patch
command classifies the complete root and submodule status, rejects extra dirty
or untracked paths, rejects index flags that can hide changes (including
assume-unchanged and skip-worktree), recomputes every result blob and tree, and
reports:

```text
verified result tree 3cc63e7a1417574b2fab1ee0c6b483fc49343b91
```

The active lock contains eleven root snapshot patches and two patches applied
in the pinned SFML and xxHash submodules. It captures the complete forensic
delta, including the hardware-WebGPU/Naga call site, software-raster phase
profile, JIT emitter diagnostics, and WGPU upload watermark. The ordered
patch-set SHA-256 is
`05fc890838da65a459ad04a57ddc91259540e00d0571475d325ec32557d9dde0`.
The virtual vendor snapshot content SHA-256 is
`f2345b18d9345043727ef886e18d0c060080de753d68604b1d20fc32476c34ab`.
The older top-level
`0001`-`0009` files remain research history and are not applied by the locked
build. See [the bridge guide](webgpu-naga-bridge.md).

## Existing artifact and ABI identity

`provenance/dolphin-core-abi-v1.json` independently identifies the current
baked core:

| Artifact | Canonical size | SHA-256 |
| --- | ---: | --- |
| `dolphin-core-upstream.js` | 261,633 normalized bytes | `56c62ffc376806049b3442d66df5b72a8685796e39ab79931282fcb286a3b163` |
| `dolphin-core-upstream.wasm` | 12,815,061 bytes | `158dde37602442bf1dacf42328501082b46b47768b2455946fcb4c596fcdb5ea` |

The JS digest is calculated after CRLF-to-LF normalization, and
`.gitattributes` requires LF for core JS files. This prevents checkout line
ending policy from changing the identity of semantically identical glue. The
WASM digest is always over raw bytes. ABI verification also checks the public
Module exports and the 24,576-page (1.5 GiB) shared-memory contract in the JS
glue, WASM import, C++ dynamic-JIT wrapper, and active patch series.

Build success alone does not establish gameplay parity. Compare two independent
build records with `npm run compare:core-builds -- <left> <right>`, then run the
fixed Kirby-versus-Link save smoke on the candidate and on the default baseline.

Two independent builds of this core matched byte-for-byte. The independent
records include an identical 10,322,762-byte code section (SHA-256
`e7de8131567eba0b8f64e1d1fcc24e4d849f553a9e425c9ff82209fe9a2b5b02`)
and 2,451,983-byte data section (SHA-256
`aa01b9bc6d7892a16d3d8d692248e7646b6401232eba4d853fa4b1503ae91484`).
The current parity and gameplay evidence are summarized in the
[software-raster phase package](perf-results/melee-software-raster-phases-2026-07-10.md).

## Known local assumptions

The top-level lock record is Windows x64-specific; macOS and Linux use the
`posix` block described above. On Windows, scripts resolve common
Windows locations and accept `EMCC`, `EMCMAKE`, `CMAKE`, `NINJA`, `RUSTC`,
`CARGO`, and `RUSTUP` overrides only when the selected file still matches the
locked hash. `DOLPHIN_WASM_BUILD_DIR`, `DOLPHIN_WASM_OUTPUT_DIR`, and
`BUILD_PARALLELISM` select isolated build/output locations without weakening
the toolchain check.

The Rust bridge archive is generated beneath
`tools/naga-spirv-wgsl/target/` and is intentionally ignored. The patched
upstream source tree is also ignored; commit the patch inputs and the intended
build record, not `vendor/dolphin/`.

## Release/reproduction checklist

- [x] Record the upstream Dolphin commit.
- [x] Confirm the complete upstream patch snapshot is committed and replayable.
- [x] Record the Emscripten version and compiler/emsdk commits.
- [x] Record the Rust toolchain, Naga version, and Cargo lock.
- [x] Record the existing `.wasm` byte size and SHA-256 hash.
- [x] Record the Chrome version used for the current headed diagnostics.
- [x] Rebuild twice in separate clean directories and establish parity.
- [x] Run `npm test` and `npm run check` from the recorded checkout.
- [x] Store measured gameplay evidence separately from build success.

Useful artifact commands:

```powershell
npm run verify:provenance
(Get-Item cores/dolphin/dolphin-core-upstream.wasm).Length
Get-FileHash cores/dolphin/dolphin-core-upstream.wasm -Algorithm SHA256
```

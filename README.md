<p align="center">
  <img src="icon.png" alt="wasm-dolphin" width="168">
</p>

<h1 align="center">wasm-dolphin</h1>

The [Dolphin](https://github.com/dolphin-emu/dolphin) GameCube emulator,
compiled to WebAssembly with Emscripten and running in a browser tab. The
emulator core is upstream Dolphin at a pinned commit plus a numbered patch
series; around it sits a JavaScript host that owns the page, the workers,
audio, input, saves and the WebGPU renderer.

PowerPC code is translated to WebAssembly at run time, per block, and
optionally ahead of time per function region. Graphics go either through
Dolphin's software rasterizer or through a WebGPU backend whose commands are
replayed in a worker.

No games are included. Use discs you own and have dumped yourself.

## Status

Research project under active development. What is checked, and how:

| Target | State |
|---|---|
| Chrome / Edge on desktop (V8) | Main development and measurement target. All harness probes run on Chromium. |
| Safari on macOS and iOS (JavaScriptCore) | Runs, with engine-specific defaults chosen at load time (`src/wasm-engine.js`): mapped upload staging, bind group cache, a function size cap for region modules. A manual CI lane (`.github/workflows/webkit.yml`) boots homebrew `.dol` files in Playwright's WebKit with `aot=1`. iPhone tuning is in progress; no Safari or iPhone measurement results are committed yet. |
| Firefox (SpiderMonkey) | Detected by the engine probe, not tested. |
| Chrome on Windows without a GPU | Manual CI lane (`.github/workflows/windows-nogpu.yml`) checks the fallback chain: software renderer, WebGL or 2D presenter. |

| Component | State |
|---|---|
| Software renderer (`video=software`) | Default. Dolphin's rasterizer, presented through WebGPU (WebGL or 2D as fallback). |
| WebGPU renderer (`video=wgpu`) | Opt-in. Results depend on the title and the GPU. |
| PowerPC → WebAssembly block JIT | On by default (`wasmjit=1`). |
| Ahead-of-time regions (`aot=1`) | Opt-in. |
| Wii | Not a focus. There is no Wii Remote input. |

Open issues and investigation notes are in [`docs/`](docs); some of those
notes are dated snapshots and say so.

## Quick start

The core `.wasm` is committed and the host has no npm dependencies, so
playing needs no build:

```bash
git clone https://github.com/Remenby31/wasm-dolphin
cd wasm-dolphin
npm run play         # serve on http://localhost:8080 and open the browser
```

Then drop a disc image on the page. `npm start` serves without opening a
browser; `PORT=9000 npm start` picks another port.

The page needs `SharedArrayBuffer`, so it must be served with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. `tools/serve.mjs` sends both;
opening `index.html` from the file system does not work.

Every setting is a URL parameter (`?video=wgpu`, `?aot=1`, `?metrics=1`…),
so a configuration can be shared as a link. See
[`docs/rendering-modes.md`](docs/rendering-modes.md) and
[`docs/jit-flags.md`](docs/jit-flags.md).

### Controls

| GameCube | Keyboard |
|---|---|
| A / B / X / Y | `X`, `Z`, `V`, `B` |
| Start | `Enter` |
| L / R / Z | `Q`, `E`, `C` |
| D-pad | Arrow keys |
| Main stick | `W`, `A`, `S`, `D` |
| C-stick | `I`, `J`, `K`, `L` |

Browser gamepads are polled too, one port per pad, up to four. Stick
deflection follows the octagonal gate Dolphin emulates for a real controller
(`src/input.js`). [`docs/input.md`](docs/input.md) describes the
`setPad` / `connectPad` API for driving ports from code.

## Architecture

```text
page (main thread)
  src/app.js, src/core-host.js         UI, settings, input, audio worklet
  │
  └─ disc worker: src/upstream-discio-worker.js
       │  owns the core, the disc mount, the canvas (OffscreenCanvas)
       │  and the WebGPU device; replays the core's GPU command ring
       │
       └─ cores/dolphin/dolphin-core-upstream.wasm   (Dolphin + patches)
            Emscripten pthreads: emulated CPU thread, GPU thread, audio…

  helper workers
    src/aot-plan-worker.js       code discovery on the user's disc (aot=1)
    src/aot-compiler-worker.js   compiles and warms wasm modules off-thread
    src/aot-sw.js                service worker serving cached region modules
```

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the boot path in detail.

### CPU

Three tiers inside Dolphin's `CachedInterpreter`:

1. Dolphin's interpreter, as a fallback.
2. Dolphin's cached interpreter.
3. A PowerPC → WebAssembly JIT added by the patch series: hot blocks are
   emitted as wasm module bytes and compiled by the browser's engine. Modules
   are cached across sessions.

With `aot=1`, a fourth path compiles whole functions:

- **Discovery** (`src/aot-*.js`) reads the DOL, apploader and RELs of the
  user's disc in a worker and builds a compilation plan: addresses, edges and
  fingerprints, never guest bytes. See [`docs/aot-plan.md`](docs/aot-plan.md).
- **Region translator** (patch `0075` and later) turns each planned function
  into a wasm fragment; `src/aot-region-module.js` links fragments into region
  modules, which tail-call each other. See
  [`docs/region-translator.md`](docs/region-translator.md).
- **Cache**: compiled regions are stored in CacheStorage per disc, core and
  compiler identity, and installed before boot on the next launch.

Anything the plan misses or gets wrong stays the JIT's job: a region whose
fingerprint does not match guest memory is ignored.

A browser has no host memory traps, so there is no fastmem: every guest memory
access is bounds-checked in wasm.

### Video

- **Software** (default): Dolphin's software rasterizer writes the XFB; the
  host uploads it and presents it with WebGPU, WebGL or Canvas 2D.
- **WebGPU** (`video=wgpu`): the patched Dolphin WebGPU backend does not touch
  a GPU. It serializes Dolphin's `AbstractGfx` calls into a command ring and
  an upload arena in shared memory. The disc worker replays them on a real
  `GPUDevice`. Dolphin's GLSL is compiled to SPIR-V by glslang, then to WGSL
  by [`naga`](https://github.com/gfx-rs/wgpu) through the small Rust staticlib
  in [`tools/naga-spirv-wgsl`](tools/naga-spirv-wgsl), linked into the core.
  See [`docs/RENDERER-ARCHITECTURE.md`](docs/RENDERER-ARCHITECTURE.md) and
  [`docs/webgpu-naga-bridge.md`](docs/webgpu-naga-bridge.md).

The replay side (`src/wgpu-*.js`) includes:

- mapped staging buffers for uploads, with a queue-write fallback
  (`src/wgpu-mapped-staging-pool.js`);
- geometry packing, range uploads and a geometry content cache (patches
  `0023`, `0031`, `0204`);
- dense uniform-buffer packets (`src/wgpu-ubo-packet.js`);
- a bind group cache keyed on object identities
  (`src/wgpu-bind-group-cache.js`);
- integrity counters for anything that makes a picture wrong without failing:
  skipped draws, missing resources, dropped records, aborted batches
  (`src/wgpu-integrity.js`, patch `0207`);
- a new-frames counter that separates new XFB frames from repeated VI swaps
  (`src/wgpu-new-frames.js`, patch `0208`);
- per-window occupancy of the CPU thread, GPU thread and replay worker
  (`src/occupancy-stats.js`).

Defaults that differ between V8 and JavaScriptCore are chosen in one place,
from `src/wasm-engine.js`, and each can be forced with a URL parameter.

`src/game-profiles.js` holds a per-title renderer table inherited from the
original fork; titles absent from it keep the default renderer.

## Repository layout

```text
src/                 browser host: page, workers, WebGPU replay, AOT pipeline
core/upstream/       C ABI shim compiled with Dolphin
core/native/         standalone native core scaffold (not the default)
cores/dolphin/       committed prebuilt core (.js, .wasm, build record)
patches/dolphin-wasm/snapshot/    the Dolphin patch series
patches/dolphin-wasm/submodules/  patches for the SFML and xxHash submodules
provenance/          source, toolchain and core ABI locks
tools/               dev server, build drivers, provenance, analysis tools
harness/             browser QA and measurement harness, homebrew test discs
tests/               Node tests (node:test)
docs/                design notes, investigations, measurement reports
vendor/dolphin/      fetched and patched Dolphin tree (gitignored)
```

## The patch series

The repository never contains a copy of Dolphin. `npm run fetch:dolphin`
fetches upstream Dolphin at the commit pinned in
[`provenance/dolphin-source.lock.json`](provenance/dolphin-source.lock.json)
into `vendor/dolphin`, and `npm run patch:upstream` applies the locked series:
the numbered patches in
[`patches/dolphin-wasm/snapshot/`](patches/dolphin-wasm/snapshot), then the
two in [`patches/dolphin-wasm/submodules/`](patches/dolphin-wasm/submodules).

- Numbers are stable identifiers, not a contiguous range: a patch that was
  dropped leaves a gap, and later work references patches by number.
- Every patch's order, size and SHA-256 are in the lock;
  `npm run verify:provenance` checks a tree against it.
- To change Dolphin: edit `vendor/dolphin`, rebuild with
  `npm run build:core:repro -- --no-sync`, regenerate the patch, then run
  `npm run update:provenance`.
- `patches/dolphin-wasm/000*.patch` and the session notes next to them are
  early research history. The locked build does not apply them.

## Building the core

Only needed when changing C++ or Rust. One command fetches the pinned
toolchain if missing, syncs and patches `vendor/dolphin`, builds, and compares
the result with the committed core:

```bash
npm run build:core:repro                 # macOS (Apple Silicon) or Linux
npm run build:core:repro -- --docker     # same build in tools/toolchain/Dockerfile
npm run build:core:repro -- --install    # also replace cores/dolphin locally
```

A built core is also written to `build/core-candidates/<sha256>/` and can be
loaded with `?coreid=sha256:<sha256>`. The step-by-step commands
(`verify:toolchain`, `fetch:dolphin`, `patch:upstream`, `configure:upstream`,
`build:upstream:full-core`), the pinned toolchain and the known traps are in
[`docs/repro-build.md`](docs/repro-build.md).

Pull requests carry sources and patches only, never the core binary. CI
(`.github/workflows/core-build.yml`) builds the core on main twice (with and
without cache) and requires identical bytes, rebuilds it from the published
GPL source archive, and commits it.

## Tests and measurement

```bash
npm test               # Node tests; no vendor/ tree needed
npm run test:contract  # source-contract tests against the patched vendor/ tree
npm run check          # syntax check of every JS entry point
```

[`harness/`](harness/README.md) drives the emulator in headless Chrome and
writes JSON. Its gate judges correctness: crashes, swallowed errors, core
freezes, exact-frame captures, interpreter against JIT, controller ports.
Performance is reported, and only a confirmed regression blocks. Probes
include:

- `harness/probes/race-perf.mjs`: steady-state speed of one scene, baseline
  against candidate in alternating order;
- `harness/probes/drop-meter.mjs`: speed drops over a whole play-through,
  attributed by cause, with an A/A noise model used as a merge guard;
- `harness/probes/replay-gates.mjs`: picture and input-latency gates for a
  presentation change, base and candidate interleaved;
- the integrity gate (`harness/lib/integrity.mjs`), used by all three: a run
  whose fatal replay integrity counters moved is flagged and left out of the
  comparison.

CI and the harness use only the homebrew discs in
[`harness/homebrew/`](harness/homebrew), built from this repository's sources
(MIT): a GX scene, a CPU fuzzer, a pad test, a tone test and others.
Measurements on commercial discs stay on the developer's machine; those
matrices refuse to run under `CI`.

Workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|---|---|---|
| `core-build.yml` | pull requests, main | reproducible core build, `check`, `test`, `test:contract`, GPL source archive |
| `bench.yml` | manual, `bench/**` | A/A or A/B speed bench on homebrews, x64 and arm64 runners |
| `webkit.yml` | manual | homebrew boot with `aot=1` under JavaScriptCore |
| `windows-nogpu.yml` | manual | software path and presenter fallback on Windows without a GPU |

[`harness/QA-STATUS.md`](harness/QA-STATUS.md) lists what is measured
automatically and what is not yet.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Rules visible in the tree:

- Engine changes are generic. No title-specific code paths, hacks or asset
  packs. Dolphin's own GameSettings database is embedded as upstream ships it,
  filtered by `tools/gamesettings-filter.mjs`.
- No game content in the repository, in tests or in CI: no discs, savestates,
  FIFO logs or captures taken from games.
- Pull requests do not commit `cores/dolphin/*`; CI builds and publishes the
  core.
- A measurement comes with its full URL, the browser, the machine and GPU,
  and repeated runs. Raw results go in [`docs/perf-results/`](docs/perf-results).

## Origin and credits

- **Dolphin**: the emulator itself, © the Dolphin Emulator Project and
  contributors, GPLv2-or-later. This project is not affiliated with or
  endorsed by the Dolphin project.
- **Douglas Whittingham**: created
  [wasm-dolphin](https://github.com/dougchansan/wasm-dolphin), the Emscripten
  port, the PowerPC → WebAssembly JIT, the software-hybrid presentation path,
  the first WebGPU backend and the Naga bridge, the provenance and
  reproducible-build tooling.
  This repository started as a fork of his work.
- Since then this repository has added, among other things: the
  ahead-of-time region compiler, the WebGPU replay optimizations and
  integrity counters, JavaScriptCore support, the harness and its homebrew
  discs, and CI-built reproducible cores.
- **naga** (MIT / Apache-2.0) translates SPIR-V to WGSL. The homebrew discs
  link libogc (zlib licence); see [`harness/README.md`](harness/README.md#licences).

## License

GPLv2-or-later, as Dolphin. The combined work, including the prebuilt core
`cores/dolphin/dolphin-core-upstream.wasm`, is a derivative of Dolphin; the
full text is in [LICENSE](LICENSE). `harness/` is MIT.

### Corresponding source

The committed core is built from:

- upstream Dolphin at commit
  [`e22551ea`](https://github.com/dolphin-emu/dolphin/commit/e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1),
- the patch series locked in
  [`provenance/dolphin-source.lock.json`](provenance/dolphin-source.lock.json),
- the shim in [`core/upstream/`](core/upstream) and the build drivers in
  [`tools/`](tools).

`npm run dist:source` (after `fetch:dolphin` and `patch:upstream`) writes a
single archive with all of it, ready to build, and refuses to write anything
if the tree does not match the lock. CI publishes the same archive with each
core build.

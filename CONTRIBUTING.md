# Contributing

Help is welcome. This is a research prototype, and the two things it most needs
are **making the WebGPU hardware backend faster and more correct**, and
**smooth frame rates across more games** — which starts with knowing how more
games actually behave.

By contributing you agree your work is licensed GPLv2-or-later, like the rest
of the combined work. See **License and attribution** in the [README](README.md).

## The most useful things to work on

**Benchmark more titles.** The per-game renderer table in
[`src/game-profiles.js`](src/game-profiles.js) is built from two 45-disc sweeps
on a single machine. Every title measured on different hardware makes it less
of a one-machine artifact. You do not need to write code to help here — a
careful measurement with screenshots is a real contribution.

**Optimize the hardware WebGPU path.** It is dramatically faster than the
software rasterizer on some titles (60 vs 7–10 unique visual FPS) and visibly
wrong on others, which is the single biggest thing standing between this
project and smooth output everywhere. Open questions are logged in
[`docs/webgpu-hardware-renderer-bugs.md`](docs/webgpu-hardware-renderer-bugs.md).

**Optimize the software raster path.** Phase counters already attribute cost
across raster, TEV, texture, FIFO, and XFB, so the hot phases are known; see
[`docs/software-raster-profiling.md`](docs/software-raster-profiling.md).
Vectorizing or parallelizing them is the route to being crisp *and* smooth.

**Fix a broken title.** Anything on the software list in `game-profiles.js`
with a reason like "renders black on hardware" is a concrete, bounded bug.

## The evidence standard

This project's history is mostly a record of *rejected* optimizations, and that
is deliberate: a measured negative result is worth keeping. What makes a result
usable:

- **Headed Chrome, not headless.** Headless runs are always non-qualifying for
  renderer claims — the compositor behaves differently.
- **Save the complete URL** with every result. Every setting is a URL
  parameter, so the URL *is* the configuration; a number without one cannot be
  reproduced.
- **Say which machine and GPU.** Results here are GPU-, browser-, and
  machine-dependent, and a number without that context is not transferable.
- **Screenshots for anything visual.** A wrong frame can be fast. This is why
  a title only earns a `hardware` profile if its frame was checked *by eye*
  against the software render **and** it is materially faster — a large FPS win
  alone is not enough.
- **Prefer a repeated trial to a single run.** Scene, cache, and warmup effects
  are large here.

Put raw results in [`docs/perf-results/`](docs/perf-results) rather than only
in a pull request description, so the next person can re-read them.

## Running things

```bash
npm run play      # serve the app and open it
npm test          # Node unit tests; pass on a fresh clone, no vendor/ needed
npm run test:contract # source-contract tests against the patched vendor/ tree
npm run check     # syntax-check every JS entry point
npm run perf:gate # perf regression gate
```

The qualification harness loads an exact save state directly, verifies
ROM/save/checkpoint identities, sends no input, and writes JSON/CSV/events plus
screenshots:

```powershell
$env:ROM='<your Melee Rev 2 ISO>'; $env:SAVE_STATE_PATH='<your save state>'
$env:PERF_PROBE_HEADED='1'; npm run perf:gate
```

Bring your own disc images and save states — none are distributed here, and
none should be added to the repository.

## Changing the core

The core `.wasm` is committed, so most work needs no build. If you do change
the C++ or Rust, [`docs/repro-build.md`](docs/repro-build.md) has the full
prerequisites, and `npm run verify:provenance` checks that your vendored tree
is still the pinned upstream commit plus the locked patch series.

## Pull requests

- Keep a change and its evidence together.
- Say what you measured, on what, and what you did *not* verify. Stating the
  limits of a result is not a weakness here; overclaiming is.
- A negative result is a welcome pull request against the docs, even with no
  code change.

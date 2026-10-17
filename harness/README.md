# QA harness

Drives the emulator in a real Chrome and turns what it sees into JSON verdicts. It
replaces the evaluation's ad hoc scripts (`pw/`, `mkgcm.py`, `padtest`) and is the
judge for the other workstreams: perf claims, renderer correctness, JIT
correctness, multi-pad input.

Needs Node ≥ 22, Google Chrome, and Playwright (the one bundled with
`@playwright/cli` is found automatically, or set `PLAYWRIGHT_MODULE`). Building the
test discs needs Docker. No npm dependencies.

```sh
harness/run build-iso                      # rebuild the homebrew discs from source
harness/run fuzz                           # interpreter vs JIT on every homebrew
harness/run pads                           # 4 virtual gamepads → padtest ports 1-4
harness/run diff --iso harness/homebrew/out/gxscene.iso   # software vs wgpu, same frame
harness/run matrix harness/matrices/ci-homebrew.json      # games × configs × N runs
harness/run measure --iso disc.iso --config rec --runs 3  # one cell
harness/run savestate --iso disc.iso --steps steps.json --to state.sav
harness/run clean                          # old results, temp profiles, stopped containers
```

Every command starts `tools/serve.mjs` on `127.0.0.1:8082` (`--port`, or
`HARNESS_PORT`) unless this tree is already served there, launches Chrome
**headed** with a fresh `user-data-dir` per run (no JIT cache or IndexedDB
carried over), and stops both at the end. Exit code: 0 pass, 1 finding, 2 usage
or infrastructure error.

## Outputs

Results go to `harness/results/<command>-<time>/` (git-ignored; only the newest
8 are kept, `HARNESS_KEEP_RESULTS` to change; `harness/run clean [--keep N] [--all]`
also removes leftover Chrome profiles and stopped containers labelled
`gc-harness=1`). A run whose
disc is not one of the homebrews (a commercial game) writes to
`$HARNESS_PRIVATE_OUT`, by default `../measures/harness/` next to the checkout,
so captures of commercial games never land in the repo.

Each measured run records the full URL, the disc path, machine load before
and after (`uptime`, load average), 1 Hz samples of `window.__lastFrameInfo`
(speed, presentations/s, unique visual frames/s, p95/max present interval,
JIT blocks compiled, PC), Chrome CPU for that profile only (total, busiest
renderer, GPU process; 100 % = one core), console/page/worker errors, and
screenshots. `matrix` adds `summary.json` and `summary.md`: per cell, the
median ± sample stdev across runs of each run's mean, and the runs flagged
`crash` or `zero-presents` (presentationFps 0 throughout while the core
advances: a frozen picture, or a wgpu XFB-only path the counter does not see;
the capture tells which). `harness/run report <dir>` rebuilds the summary from
the per-run files.

## Commands

**matrix** `<spec.json> [--runs N]`. Spec: `runs`, `warmupSec`, `sampleSec`,
`shotEverySec`, `games` (`id`, `iso`, optional `steps`, `localOnly`) and
`configs` (`id`, and `preset` or `query`, optional `set` overrides). `iso` may
use `${ENV}`. Presets live in `lib/matrix.mjs` (`rec`, `rec-nojit`, `wgpu`,
`wgpu-nojit`, `sw-interp`, `sw-fast-jit`, `unlimited`); `metrics=1` is always
added. Runs are interleaved (run 1 of every cell, then run 2, …) so load drift
does not bias one cell. A `localOnly` game refuses to run when `CI` is set.

**diff** `--iso X [--ref cfg] [--cand cfg] [--frame N] [--state s.sav] [--steps f] [--pause]`
or `--ref-png a.png --cand-png b.png`. Boots the same disc twice, waits for core
frame N (or loads the savestate, then N more frames), grabs the frame through
`canvas.captureStream()` (falls back to an element screenshot), and scores the
candidate against the reference on a 160×120 grid:

| Field | Meaning |
|---|---|
| `ssim` | mean 8×8-block SSIM on luma |
| `lostDetail` | share of reference blocks with detail that are flat in the candidate |
| `extent` / `extentDelta` | horizontal and vertical span of non-black content |
| `verdict` | `match` (ssim ≥ 0.9), `missing-detail` (lostDetail ≥ 0.3: overlay drawn, 3D missing), `blank`, `geometry-mismatch` (span differs > 2 %), `different` |

Frame grabs prefer `captureStream()`. A canvas that has not repainted since the
stream opened yields no frame (seen with wgpu on XFB-only homebrews); the grab
then falls back to an element screenshot with the HUD hidden, which is scaled
to the page layout and less exact.

It writes `ref.png`, `cand.png`, `diff.png` (reference | candidate | block heat
map) and `diff.json`, and exits 1 on any verdict listed in `--fail-on`
(default: everything but `match`).

**fuzz** `[disc.iso …] [--interp q] [--jit q] [--timeout s]`. Runs each disc
with `wasmjit=0` and with `wasmjit=1&jitwarmup=120&forcejit=1`, each until the
homebrew reports done, the worker dies, the core stalls, or the timeout. Then
compares: JIT crash (with the first error and the PC, mapped to the cpufuzz
program and word; that PC is the last one the page received before the worker
died, so it can be stale and the mapping is then absent), each side's self-check, the final result hash across the
two runs, or for discs without markers the final frames. `jit-not-engaged` is a
warning: the JIT compiled nothing, so the run proved nothing.

**pads**. Boots `padtest` with the [gamepad mock](lib/gamepad-mock.mjs), holds a
different combination on each of the 4 virtual pads, and decodes what each
console port sees; then releases everything and checks keyboard X → port 1 A.

**savestate** `--iso X --to out.sav [--config c] [--steps f] [--wait s]`. Boots,
plays `steps`, waits, saves a version-matched state through `__saveStateFile`.
Feed it to `diff --state` to compare backends on the exact same scene.

Steps (`lib/steps.mjs`) are a JSON list: `{"wait": s}`, `{"tap": "KeyX",
"repeat": n, "every": s}`, `{"down": k}`, `{"up": k}`, `{"click": [x, y]}`,
`{"pad": i, "state": {...}}`.

## Test discs

`homebrew/` holds our own sources (MIT), built with devkitPPC + libogc in the
pinned `devkitpro/devkitppc` image by `homebrew/build.sh`, then wrapped by
`homebrew/mkgcm.mjs` in a 17 MiB GCM image with a tiny apploader (the app
does not boot bare `.dol` files). The build is reproducible: `out/SHA256SUMS`
is identical across rebuilds.

| Disc | What it checks |
|---|---|
| `padtest` | prints the 4 ports and encodes each port's buttons/sticks/triggers in a marker row |
| `consoletest` | deterministic `printf` workload, hash of the formatted text |
| `gxscene` | static depth-tested 3D scene (floor + 2 cubes) under a 2D overlay, for backend diffs |
| `cpufuzz` | 384 random PowerPC programs (integer, rotates, XER/CR, branches, CTR loops, loads/stores, FP) run every frame, self-checked against frame 0 |
| `cpufuzz-nomcrf` | the same without `mcrf`, which currently crashes the JIT, so the fuzz can go further |

Homebrews talk to the harness through **markers** painted into the XFB
(`homebrew/common/marker.h`, decoded by `lib/markers.mjs`): a status block
(blue idle, yellow running, green pass, red fail) and four rows of 32 bits.
Build cpufuzz with `-DONLY_PROGRAM=n` to run a single program while reducing a
finding; `out/cpufuzz*.symbols.json` maps a PC back to a program.

## CI

What CI can run without a GPU or a commercial disc (the first two run as is;
the browser steps have only been run headed on macOS so far, Xvfb is untested):

```sh
harness/homebrew/build.sh                 # Docker only
node --test tests/harness-*.test.mjs      # pure logic, no browser
xvfb-run harness/run fuzz                 # headed Chrome under Xvfb, software renderer
xvfb-run harness/run pads
```

Measurements on commercial games (`matrices/local-*.json`) stay local:
`localOnly` games refuse to run when `CI` is set.

## Licences

`harness/` is MIT. The discs link libogc (zlib licence, with BSD-licensed
RTEMS-derived parts; see devkitPro/libogc `LICENSE`) and use no devkitPro
example code or data. The devkitPro `gamecube-examples` used during the first
evaluation carry no licence file, so they are deliberately not part of this
corpus.

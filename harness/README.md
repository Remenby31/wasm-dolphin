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
harness/run diff --iso harness/homebrew/out/gxscene.iso   # two configs, same emulated frame
harness/run matrix harness/matrices/ci-homebrew.json      # games × configs × N runs
harness/run measure --iso disc.iso --config rec --runs 3  # one cell
harness/run savestate --iso disc.iso --steps steps.json --to state.sav
harness/run clean                          # old results, temp profiles, stopped containers
```

Every command serves the tree on `127.0.0.1:8082` (`--port`, or
`HARNESS_PORT`) from an **immutable in-memory snapshot**: at start, every file
the tree's own `tools/serve.mjs` allowlist would serve (ignored files
included) is read and hashed, and requests are answered from that snapshot
only. Results record the snapshot hash. The server belongs to the harness
process; a busy port is an error, never a server to reuse. Chrome runs
**headed** with a fresh `user-data-dir` per run (no JIT cache or IndexedDB
carried over). Exit code: 0 pass, 1 finding, 2 usage or infrastructure error.

## Exact frames

Rendering is judged on pictures the **core** captures at an exact VI output
(one per emulated field the game scans out), counted from boot or from the
last savestate load. The output index is the frame identity (emulated ticks
are recorded for information; they include the VI event's lateness).
`validationCaptureAtVi` in the worker arms `DolphinWeb_HarnessArmCapture` in
`core/upstream/dolphin_web_discio.cpp`, which, at that output, waits for the
video thread to drain (`FlushGpu`: in dual core it may still be writing the
XFB) and decodes the guest XFB at native size, or reports the output as
missed. A capture that is not exactly the requested output is an error, never
a picture. Every VI output and every presentation also go into rings the
worker drains completely (`validationReadTimeline`), on one clock
(`timeOrigin + performance.now()`), with a sequence number per VI entry so an
overwritten entry counts as lost instead of being read.

The hooks are off in normal use (two counter increments and one atomic load
per VI output); `bootIso` turns them on with `validationEnableHarness` as soon
as the worker exists, before the core loads. OGL does not go through the VI
hook: its timeline and captures are reported as unjudged, not as frozen.

Limits: the capture is the guest XFB, which is what the software renderer
outputs. Hardware renderers (`video=wgpu`, `ogl`) keep their picture on the
GPU, so their exact capture needs a present-side hook (present tagged with the
VI output, read back in the worker); until then the harness refuses to judge
them rather than compare something else. The hooks need the core rebuilt
(`docs/repro-build.md`); a core without them makes every capture fail with
"core has no harness capture hook".

## Worker API for exact frames (stable contract)

Harness-only worker messages, sent through `window.__host.adapter.request(type, payload)`.
They are the interface other workstreams implement against (the wgpu exact
capture must answer `validationCaptureAtVi` the same way). Changing a field is
a breaking change: add, don't rename.

| Message | Payload | Answer |
|---|---|---|
| `validationEnableHarness` | `{}` | `{ enabled: true, coreHooks, coreLoaded }`. Turns the hooks on (also applied when the core loads). Send before anything else. |
| `validationCaptureAtVi` | `{ index?, ahead?, fromLoad = false, timeoutMs = 60000 }` | `{ index, fromLoad, ticks, width, height, pixels: Uint8Array RGBA (width×height×4), source }`. `index`: VI output to capture, counted from boot (or from the last savestate load if `fromLoad`); `ahead`: that many outputs after the latest one. Rejects (never answers with another frame) when the output has passed, was skipped, never arrives within `timeoutMs`, the hooks are off, or the backend cannot capture. `source` names what was captured (`"guest-xfb"` today; a GPU implementation must use its own value). |
| `validationReadTimeline` | `{}` | `{ presents: { t[], frame[], vi[], lost }, vi: { t[], ticks[], sinceBoot[], sinceLoad[], lost, supported, why }, now }`. Everything recorded since the previous read. Times are `performance.timeOrigin + performance.now()` (ms) on both rings. `presents.vi` is the VI output count at each presentation; `lost` counts entries overwritten before they were read; `supported: false` comes with `why`. |

Frame identity is the VI output index; `ticks` is informational.

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

**diff** `--iso X [--ref cfg] [--cand cfg] [--frame N] [--state s.sav] [--steps f]`
or `--ref-png a.png --cand-png b.png`. Boots the same disc twice, captures VI
output N (from boot, or from loading `--state`) in each, checks that both
captures carry the same emulated tick count, and compares them:
`identical` (byte for byte), else scored on a 160×120 grid:

| Field | Meaning |
|---|---|
| `ssim` | mean 8×8-block SSIM on luma |
| `lostDetail` | share of reference blocks with detail that are flat in the candidate |
| `extent` / `extentDelta` | horizontal and vertical span of non-black content |
| `verdict` | `identical`, `blank`, `missing-detail` (lostDetail ≥ 0.3: overlay drawn, 3D missing), `geometry-mismatch` (span differs > 2 %), `match` (ssim ≥ 0.9), `different` |

No spatial or temporal tolerance: both pictures are the same emulated frame.
It writes `ref.png`, `cand.png`, `diff.png` (reference | candidate | block heat
map) and `diff.json`, and exits 1 on any verdict in `--fail-on` (default:
everything but `identical` and `match`).

**fuzz** `[disc.iso …] [--interp q] [--jit q] [--frame N] [--timeout s]`.
Runs each disc with `wasmjit=0` and with `wasmjit=1&jitwarmup=120&forcejit=1`
and captures VI output N (default 1700, after every homebrew has frozen its
output). Failures: a crash on either side (JIT crash with the first error and
the PC, mapped to the cpufuzz program and word; that PC is the last one the
page received before the worker died, so it can be stale), a missing capture,
a JIT that compiled or ran no block, captures of different emulated frames, a
black capture, and any byte of difference between the two captures. The
checksum-verified marker rows are then decoded to name the diverging check or
program.

**pads**. Boots `padtest` with the [gamepad mock](lib/gamepad-mock.mjs), holds a
different combination on each of the 4 virtual pads, captures the picture 30
VI outputs later and decodes what each console port sees (checksum-verified);
then releases everything and checks keyboard X → port 1 A.

**savestate** `--iso X --to out.sav [--config c] [--steps f] [--wait s]`. Boots,
plays `steps`, waits, saves a version-matched state through `__saveStateFile`.
Feed it to `diff --state` to compare configs on the exact same scene.

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

Homebrews draw their results as **marker rows** in the XFB
(`homebrew/common/marker.h`, decoded by `lib/markers.mjs`): four rows of 32
bits plus a checksum row, read from exact captures only. Rows whose checksum
does not match are unreadable; nothing is decided from colours.
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

# QA harness

Drives the emulator in a real Chrome and turns what it sees into JSON. It
replaces the evaluation's ad hoc scripts (`pw/`, `mkgcm.py`, `padtest`) and is
the judge for the other workstreams. The **gate** judges correctness only
(crash, swallowed errors, core freeze, rendering at an exact emulated frame,
interpreter vs JIT, controller ports). **Performance is a report**: on this
shared, loaded machine it only blocks on a clear, confirmed regression
against the baseline, never through thresholds.

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
harness/run ab harness/matrices/ci-homebrew.json        # origin/main vs this tree: the gate
harness/run gate --baseline A --candidate B             # the gate on two existing results
harness/run report <result-dir>            # rebuild a summary from its run files
harness/run savestate --iso disc.iso --steps steps.json --to state.sav
harness/run clean                          # old results, temp profiles, stopped containers
```

Every command serves the tree on `127.0.0.1:8082` (`--port`, or
`HARNESS_PORT`) from an **immutable in-memory snapshot**: at start, every file
the tree's own `tools/serve.mjs` allowlist would serve (ignored files
included) is read and hashed, and requests are answered from that snapshot
only. Results record the snapshot hash. The server belongs to the harness
process; a busy port is an error, never a server to reuse. Chrome runs
**headless** (`--headless=new`, the only mode: no window ever appears on the
machine, which people use while it runs) with a fresh `user-data-dir` per run
(no JIT cache or IndexedDB
carried over). Exit code: 0 pass, 1 finding, 2 usage or infrastructure error.

## The console clock of single-core runs

The console's real-time clock sets the PowerPC time base at boot and formats
the memory cards; on the host's clock, two boots of one disc part from the
first frames. With one emulated CPU thread (`cpu=single`, or `cpu=auto` with
any renderer but OGL) every harness boot adds `rtc=1000000000` unless the
query sets `rtc`: the clock then starts there and follows emulated time
(patch 0081), and the run repeats exactly. `bootIso` checks, once the core
runs, that the core took the value and that its clock is that start plus the
emulated seconds; otherwise the boot fails (`rtc not applied` / `rtc not
followed`), so a host-clock run is never compared with a fixed-clock one in
silence. `rtc=host` keeps the host's clock, as players have it; the CI matrix
keeps one such cell (`sw-single-hostclock`). `probes/determinism.mjs` boots a
disc several times with a CoreTiming trace and compares every event, emulated
RAM and the picture: identical on the fixed clock, and with `--host-clock` it
expects the runs to differ.

Against a trunk older than 0081, a single-core cell boots on a clock that
trunk does not have: run that one comparison with `rtc=host` on both sides,
or accept the cell (`--accept game/config`).

## Which core a run used

Every run checks, once the core is loaded, that the bytes the harness server
handed out for `dolphin-core-upstream.wasm` hash to the core the run asked
for: the URL's `coreid=sha256:…`, or else the served tree's own
`cores/dolphin` core. Any other core, or a fallback reported by the app,
fails the run with `core-mismatch` (the app falls back to main's core when a
candidate is missing; a judge never measures that). Fetches are attributed
per request, through the run's own browser context (the emulator worker's
requests included), so several sessions on one server, with different
`coreid`s, each check only their own core. The loaded hash is in
every run's JSON (`core`). Candidate cores are served from
`build/core-candidates/<sha>/` of the tree, or from directories passed with
`--core-candidate <dir>`, and only when their wasm hashes to that sha.

## Race performance probe

`harness/probes/race-perf.mjs` measures the steady-state speed of one scene
(a savestate, a held key), trunk against head:

```sh
node harness/probes/race-perf.mjs --iso ../roms/<disc>.iso --state ../measures/harness/<race>.sav \
  --port 8082 --baseline origin/main [--candidate <ref|dir>] --runs 4 --warmup 25 --secs 20 [--warm] [--pcsample 0.25]
```

- Headless; the measured window makes no page call at all (no CDP), the
  rings are read once it ends. Speed is the core's VI timeline only.
- Trunk and head run back to back for each run, the order alternating; the
  change is the median of per-run ratios. With `--baseline` the runs must be
  even (default 4), and the change is withheld (exit 1) unless there are at
  least `--min-pairs` valid pairs, as many with trunk first as with head
  first. A `coreid` in `--query` is refused then (it would pin both sides to
  one core).
- Load, as in the matrix (`lib/env.mjs`): each side first waits up to
  `--load-wait` s for the 1-minute load to drop under `--max-load` (default
  a quarter of the cores); a window whose median load is above it fails.
- The shared perf lock (`~/projects/gc-web-emu/.perf-lock`, PROGRAM.md) is
  taken before the first launch and released on every exit, Ctrl-C
  included; `--lock-wait` bounds the wait (60 s polls). `harness/run ab`
  takes it too. A stale lock (its harness process is gone, or no owner file
  for 30 s) is taken over atomically: renamed aside, checked, then removed.
- Each run checks the core it loaded (core-mismatch otherwise) and records
  its hash, again after the `--warm` reboot.
- `--pcsample [ms]`: a worker of its own reads the guest PC in the shared
  heap (`DolphinWeb_HarnessPcAddress`, `validationPcSampler`) every `ms`
  during the window: a histogram of guest PCs (~3 kHz), per function with
  `--symbols functions.json` (`[[start, end, name], …]`, local only for a
  commercial disc). Real-time sampling: "more work" and "the same work,
  slower" look alike. Host-side shares (the dispatcher's) are not guest PCs
  and need a counter in the core.
- A local-only disc is refused when `CI` is set; its results go to
  `../measures/harness` (or `HARNESS_PRIVATE_OUT`), never into the repo.

`harness/matrices/local-kart-race.json` runs the same race through `ab`
(`KART_ISO`, `KART_STATE`; `measureFromState` starts the measured window
from the savestate; local only).

## Freeze probes

During the measured window the timeline is drained every second. When it
shows a freeze starting (no VI output for 2 s: core; or no presentation for
2 s while VI outputs go on: present), the harness reads the worker's WebGPU
replay and GPU sync state (`validationReadWgpuReplayState`) 4 times, 500 ms
apart, and stores it in the run's JSON as `freezeProbes` (at most 3
episodes per run, each state cut at 64 KB). A served worker without that
message gets none and the episode is recorded as `unsupported`. Evidence
only: freezes are judged by coreFreeze as before.

## Renderer crashes

A Chrome renderer crash ("Target crashed") in a matrix cell is run once
more, on the same side. If it does not happen again it is an **infra
crash**: shown in the gate report, appended to
`harness/results/infra-crashes.jsonl` (a cumulative counter), not blocking.
If it happens again the cell crashed: the crash check fails and blocks,
unless the baseline crashed the same way twice too. Renderer crashes on the
candidate only, twice or more in one comparison, are a regression. Chrome's
log (`--enable-logging --log-file`) and crash dumps of each crashed run are
kept in `<results>/<run>-crash/`.

## No windows

The harness never shows a browser window: people work on the machine it
runs on. Chrome runs `--headless=new` with the anti-throttling flags; after
launch and after boot, `lib/onscreen-windows.swift` (CGWindowList) checks
that no window of that Chrome is on screen, and a run that has one is closed
and fails. Checked on Apple M4 Pro: WebGPU gives the Apple metal-3 adapter
headless, and exact captures at VI 300 are byte-identical headless and
windowed, software (`a81fbfff…`) and wgpu (`b864c264…`). Windowed variants
were tried and all showed a window (an off-screen position is moved back on
screen; `open -j -g` still shows the window Chrome opens), so there is none.

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
(`timeOrigin + performance.now()`), with a per-entry seqlock (sequence odd while written,
checked before and after reading) so an overwritten or half-written entry
counts as lost instead of being read.

The hooks are off in normal use. What remains in production is two counter
increments and one relaxed atomic load per VI output: a reviewed decision
(about 120 cheap operations per second, nothing allocated, no timestamp), kept
so the VI indices exist from boot and stay correct when the harness enables the
rings later; `bootIso` turns them on with `validationEnableHarness` as soon
as the worker exists, before the core loads. OGL does not go through the VI
hook: its timeline and captures are reported as unjudged, not as frozen.

Sources: the software renderer is captured from the guest XFB
(`source: "guest-xfb"`). `video=wgpu` is captured by the worker from the
present tagged with that VI output (`source: "wgpu-present"`, PR #7); a
hardware renderer answering with the guest XFB is rejected, since that is
not what it shows. OGL has no exact capture.

Across renderers, VI output N is the same emulated frame only with one CPU
thread: in dual core a slower GPU thread makes each frame consume more
emulated time. `diff` between two renderers therefore runs both sides with
`cpu=single`.

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

Results go to `harness/results/<command>-<time>-<pid>-<nonce>/` (git-ignored).
The directory is created atomically and claimed with an owner marker
(`.harness-owner.json`, created with O_EXCL): a directory that exists is never
reused, and two processes cannot own one. Only the newest 8 finished result
directories of this checkout are kept (`HARNESS_KEEP_RESULTS`);
`harness/run clean [--keep N] [--all]` also removes leftover temp dirs whose
owner process is gone and stopped containers labelled with this checkout's
path. It never touches what another checkout made or a live run, and never
kills processes. A run whose disc is not one of the homebrews (a commercial
game) writes to `$HARNESS_PRIVATE_OUT`, by default `../measures/harness/` next
to the checkout, so captures of commercial games never land in the repo.

Each measured run records the served snapshot hash, the full URL, the disc,
machine load before, during and after, Chrome and GPU adapter, the complete
timeline of the measured window (every presentation and every VI output),
the counters the timeline lacks sampled at 1 Hz (unique visual frames, audio
underruns, JIT blocks, PC), Chrome CPU for that profile only (100 % = one
core), every swallowed error, the exact render capture, and screenshots for
people. `matrix` adds `summary.json` and `summary.md`.

## Gate and report

Per (game, config) cell, the **correctness checks** (`lib/correctness.mjs`):

| Check | Fails when |
|---|---|
| crash | the worker or page died, a WebAssembly compile/link/runtime error |
| errors | any swallowed error: uncaught, unhandled rejection, `console.error`, a worker message nobody handles, an unmatched worker error reply |
| coreFreeze | no VI output for 2 s while the run went on (from the VI timeline) |
| render | the exact capture is blank, or differs from the reference config's capture of the same run at the same VI output: byte-identical required for the same renderer, otherwise `match` (no missing detail, no squeezed picture) |
| audio | the game spec says `audio: true` and the output peak stays under 1e-3 |
| renderVsBaseline (ab) | per cell, the candidate's capture differs from the baseline's at the same VI output; catches what all configs of one commit get wrong together. Intended changes: `--accept game/config`. Each side must first agree with itself across runs. Baseline nondeterministic, candidate stable: known (not blocking) if the candidate's picture is one of the baseline's; otherwise, for a cell listed in `harness/known-failures.json`, known only if it differs from the closest baseline picture by no more pixels than the baseline's pictures differ from each other, else it blocks. Candidate nondeterministic, baseline stable: blocks. Both: blocks unless listed. A cell listed with `"mode": "set-equal"` (a `reason` is mandatory) is judged on picture sets instead: fail on a crash, a blank picture or a candidate picture the baseline never gave; inconclusive under 3 runs a side; pass when every candidate picture was seen on the baseline (a baseline picture the candidate did not sample is sampling, not a regression) |

Each check of each run is pass, fail or **unjudged** (with the reason: no VI
timeline in this core, capture refused for a hardware renderer, scripted
inputs without a savestate, …). Machine load changes none of them.

**`harness/run ab <spec>`** exports the served files of `--baseline-ref`
(default `origin/main`) with `git archive`, runs the matrix (and the spec's
`fuzz` discs and `pads`) on both sides, alternating which side goes first on
each run, and gates:

- correctness: a check the baseline passes and the candidate fails is a
  regression; a check the candidate cannot judge while the baseline could is
  INCONCLUSIF; a vanished cell is missing; an empty comparison is INCONCLUSIF.
  All of these block. A failure both sides share is reported as known.
- crashes are compared by signature (first line, numbers blanked): a
  candidate crash is "known" only if the baseline crashed the same way.
- performance: for speed, unique frames/s and frame p95, the median of the
  paired relative changes (run k of the baseline vs run k of the candidate).
  A median 15 % worse or more triggers `--confirm` more pairs (default 2) of
  those cells and of the reference config; it blocks only if confirmation
  pairs exist and the median over all pairs is still 15 % worse. A drop
  without confirmation runs is reported, never blocking.

Everything the decision uses is written to `baseline/` and `candidate/`, and
`gate.json`/`gate.md` hold it; `harness/run gate --baseline … --candidate …`
recomputes the same decision from those directories.

**Selftest** (`node harness/selftest/run.mjs [--only id,…] [--clean N]`): the
gate's acceptance test. Eight known regressions are applied to the candidate
side only, as in-memory patches of the served app or mutant homebrew discs
(geometry removed, one colour off by 3/255, JIT crash, gamepads cut from
port 1, core stopped 3 s, a swallowed worker message, output muted, emulation
at 70 %, a picture that changes from run to run); the gate must block each.
A mutant makes the baseline's picture vary (declared known) while the
candidate stably loses its geometry: blocks. A control makes the baseline's
picture vary against a stable, right candidate: the gate must pass it. Then N clean runs of this tree against
itself; the gate must pass each. It writes `selftest.md` with the table.
Ports 2-4 do not work on main yet, so the port mutant cuts port 1.

The **performance report** per cell (median ± stdev and IQR across runs):
emulated speed per second from the VI timeline (median, p5, min, dated dips
under 90 %; the app's sampled `gameSpeed` when the core has no VI timeline,
and labelled so), unique visual frames/s, frame time p50/p95/p99/max and
hitches over 2 frames per minute from every presentation, presentation freezes
of 500 ms or more while VI outputs kept coming, audio underruns per minute
(worst run) and peak/RMS, CPU, load. Runs above the load limit (`maxLoad`,
default the number of cores) are marked `overloaded`. It also gives the
QA-CHECKLIST §1 class (TEMPS RÉEL / JOUABLE / LENT / CASSÉ / INCONCLUSIF,
`lib/verdict.mjs`) as information: any correctness failure is CASSÉ, any class
above LENT needs a proven render, and the native cadence comes from the
game's `nativeFps`.

## Commands

**matrix** `<spec.json> [--runs N] [--max-load L]`. Spec: `runs`, `warmupSec`,
`sampleSec`, `shotEverySec`, `reference` (the config every render capture is
compared with), `renderFrame` (VI output of the render capture: after boot,
default 300, or after loading `state`, default 120), `maxLoad`, `loadWaitSec`,
`fuzz` (discs for `ab`), `pads` (true: `ab` runs pads too), `games` (`id`,
`iso`, optional `steps`, `state` (savestate for the render capture),
`localOnly`, `nativeFps`, `static` for still pictures, `audio: true` to require
sound) and `configs` (`id`, and `preset` or `query`, optional `set` overrides).
`iso` and `state` may use `${ENV}`. Presets live in `lib/matrix.mjs`;
`metrics=1` is always added. Runs are interleaved (run 1 of every cell, then
run 2, …). A `localOnly` game refuses to run when `CI` is set. Exit 1 when a
correctness check fails.

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
| `tonetest` | a continuous 440 Hz tone through the audio DMA, for the audio check |
| `gxscene-nocubes`, `gxscene-color` | selftest mutants of `gxscene` (`-DMUTATE_NO_CUBES`, `-DMUTATE_COLOR`) |

Homebrews draw their results as **marker rows** in the XFB
(`homebrew/common/marker.h`, decoded by `lib/markers.mjs`): four rows of 32
bits plus a checksum row, read from exact captures only. Rows whose checksum
does not match are unreadable; nothing is decided from colours.
Build cpufuzz with `-DONLY_PROGRAM=n` to run a single program while reducing a
finding; `out/cpufuzz*.symbols.json` maps a PC back to a program.

## CI

What CI can run without a GPU or a commercial disc (the first two run as is;
the browser steps run headless, so no display server is needed):

```sh
harness/homebrew/build.sh                 # Docker only
node --test tests/harness-*.test.mjs      # pure logic, no browser
harness/run fuzz                          # headless Chrome, software renderer
harness/run pads
```

Measurements on commercial games (`matrices/local-*.json`) stay local:
`localOnly` games refuse to run when `CI` is set.

## Licences

`harness/` is MIT. The discs link libogc (zlib licence, with BSD-licensed
RTEMS-derived parts; see devkitPro/libogc `LICENSE`) and use no devkitPro
example code or data. The devkitPro `gamecube-examples` used during the first
evaluation carry no licence file, so they are deliberately not part of this
corpus.

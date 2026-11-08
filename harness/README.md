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
expects the runs to differ. The trace is compiled only into a trace build
(`DOLPHIN_WEB_DET_TRACE=1 npm run build:core:repro`, loaded with `coreid=`):
the committed core and a player's have none of it.

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
- race-perf and ttff wait for a calm machine (load ≤ `--max-load`) before
  they take the perf lock, up to `--calm-wait` (default `--lock-wait`); not
  calm by then, they stop without the lock and without measuring. Under the
  lock, a run whose load gate does not open within `--load-wait` gives the
  remaining runs up (`gaveUp` in summary.json) and the lock goes back.
- The shared perf lock (`~/projects/gc-web-emu/.perf-lock`, PROGRAM.md) is
  taken before the first launch and released on every exit, Ctrl-C
  included; `--lock-wait` bounds the wait (60 s polls). `harness/run ab`
  takes it too. The lock is published whole (a private directory with its
  owner file, renamed to `.perf-lock`), and released by moving it aside
  before removing it, so `.perf-lock` never exists without its owner. A
  stale lock (its harness process is gone, or no owner file for 30 s) is
  taken over by one contender at a time, under the `.perf-lock.takeover`
  guard (abandoned after 10 s): judged again, renamed aside, checked, then
  removed.
  First come, first served: each contender drops a ticket named by its
  arrival time in `.perf-lock.queue` and tries the lock only once no older
  ticket of a live process is waiting, so a burst of short runs can no
  longer starve a long wait. Tickets of a gone process are removed by the
  next reader; older harnesses take none and can still pass ahead.
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
- Each run's window also lists its hitches (`cold.hitchList`, in `run<N>.json`):
  `[ms into the window, interval ms, VI outputs since the savestate load]`,
  the last being the place in the scene whatever the speed, so two runs or
  two sides can be lined up; over 200 the longest are kept, in time order,
  with `count`.
- `--display`: what the screen showed, not what the worker submitted
  (research/deep-frame-pacing.md §3.1: Chrome keeps only the last picture
  submitted between two BeginFrames). The worker counts its presents per
  BeginFrame (one rAF per BeginFrame, `src/wgpu-display-counter.js`, on
  only when asked). Each run gets `display` (`lib/timeline.mjs`
  `displayStats`): `vsyncMs` (median BeginFrame interval: 16.7 ms in
  headless Chrome, whatever the real screen), `displayedPerSecond`,
  `submittedPerSecond`, `dropped` / `droppedPerMin`, `displayedP50/P95/P99`
  (intervals between pictures shown), `judderPct` (shown intervals that are
  not the dominant number of vsyncs: a steady 30 fps is not judder),
  `offOneVsyncPct`, `noUpdatePct`. Per side: `cold.displayedPerSecond`,
  `displayedP95`, `droppedPerMin`, `judderPct`, `offOneVsyncPct`.
- `--phase steady|postload`: which part of the scene the window sees. The
  first ~15-20 s after a state load are a transient (regions installing,
  pipelines and GPU caches cold, the replay pump busy). On the Spark at 120 Hz
  a window 5 s after the load gave 23-38 pictures a second, ~200 ms display
  holes and 11-21 ms of GPU per present; 20 s after it, 60, none and 3 ms
  (2026-10-28, `20261028/x11-bis-oldnew-w20`). The "Spark display holes" of
  2026-10-27/28 were this transient, and a state load 2.5 s earlier (#325)
  then looked like a 37 -> 24 regression. `steady` refuses a warmup under
  20 s; `postload` measures the transient on purpose (warmup 0, window 15 s by
  default). Without `--phase`, the summary's `phase` follows the warmup, and
  `--display` under 20 s is warned about.
- `--unique-frames secs`: unique images, in a window of its own after the
  speed window (its GPU readbacks never weigh on the speed). At each WebGPU
  present the worker reads back 8 full rows of the presented rectangle,
  hashes them and compares with the previous present
  (`src/harness-unique-frames.js`, worker message `validationUniqueFrames`,
  off otherwise). Each run gets `presentsPerSecond` (speed window),
  `uniqueFrames` (`uniqueShare`: presents showing a new image; `skipped`
  past 6 readbacks in flight, `errors`) and `uniqueFpsEstimate` = the speed
  window's presents/s × that share; `cold.uniqueShare` and
  `cold.uniqueFpsEstimate` per side. WebGPU presents only (`video=wgpu`).
- **Scene protocols** (`lib/matrix.mjs` `SCENE_PROTOCOLS`, judge 2026-10-23):
  a KPI scene can pin how it is measured, by savestate name. The heavy intro
  (`heavy-intro-13s.sav`) is a short phase, about 9 guest seconds from that
  state: `--emulated-warmup 1 --emulated-window 6 --hold ""`, and with
  `--region-sample` the region stats are reset and read around that same
  window (not in a stats window after it, which would read another phase).
  race-perf refuses a window over 8 s on it (an ew20 read 100 % / headroom
  1.16 where 6 s read 57-62 % / 0.56) and warns about a longer warmup, a held
  key or a host-time window; `summary.sceneProtocol` records the protocol and
  the warnings.
- `--headroom [--frames-per-vi-ref R]` (patch 0113, research/deep-headroom-kpi.md):
  the program's main KPI, measured at `speed=1` where the game runs as the
  player sees it. The core counters (`DolphinWeb_HeadroomStats`: throttle
  sleep of the CPU thread, its FlushGpu waits, GPU-thread work, XFB copies)
  are reset just before the window and read just after, with the core ticks:
  `maxSpeedCpu` = guest s / (host s − sleep − FlushGpu wait) (Dolphin's
  "Max"), `maxSpeedGpu` = guest s / (GPU work − waits on the render worker
  for ring or upload space; null with the deterministic GPU thread),
  `headroom` = the smaller one; guest s from the core's own ticks, written
  at the same instant as its host window. PushBlockingEvent and SyncGPU
  waits (off by default) count as CPU busy time;
  plus `throttleSleepShare`, `xfbCopiesPerVi` and `gameFramesPerSecond`
  (XFB copies per host second: the game images the player gets, the product
  KPI while SyncOnSkipIdle is off, since the product's emulated time then
  runs ahead of its rendering) (`cold.headroom` per run,
  medians per side). Under 2 % of sleep the game runs below 100 %
  (`headroomApplies` false): the speed is then the number.
  Validity (every run, `lib/headroom.mjs` `invalidReasons`): a ring overflow
  (`complete` false), a speed above its target × 1.02, no unique image in
  the `--unique-frames` window, or game frames per VI off `--frames-per-vi-ref`
  by more than 10 % set the run aside, with the reasons. `speed=unlimited` is
  refused unless the query turns SyncOnSkipIdle on (`synconidle=1`): with it
  off, emulated time runs ahead of the rendering.
- `--mem-stats` (patch 0104): guest memory accesses per instruction, read in
  the stats window after the speed window (with `--region-sample`, the same
  window). `summary.json` → `memAccess` (and `baselineMemAccess`):
  `accessesPerInstruction` over the counted blocks, `coverage` (their share of
  the window's cycles), loads/stores per instruction, `byKind`
  (int/fp/psq load/store), `slowShare` (slow-path calls over all accesses),
  and, with aot=1, the region part estimated apart
  (`regionAccessesPerInstructionEstimated`, `withRegionsEstimated`), never
  merged into the counted figure; `flagsPerInstruction` (CR writes, CR
  reads, XER[CA] writes and reads per instruction, counted blocks, 0104 at
  4c6122e and later). A core without the export gives
  `memAccess: null` and `memAccessWhy`.
- `--chrome-args "--flag …"` adds Chromium flags on both sides;
  `--baseline-chrome-args` replaces them on the baseline side, so one tree is
  compared with itself under two Chromium configurations (e.g.
  `--baseline-chrome-args=--js-flags=--no-liftoff`; write a value that
  starts with `--` after `=`). Headless, debugging and profile flags are
  refused. The flags are recorded in `summary.json` (`chrome.sideArgs`), and
  kpi-report never takes such a result as stock Chrome. Each run records
  `bootMs` (Chrome launch to session ready); `cold.bootMs` per side.
- Region JIT counters (P4): off by default, the speed windows never carry
  them. With `--region-sample N`, a separate stats window of `--region-secs`
  (default 10) follows each speed window: it resets the core's
  `DolphinWeb_JitRegionStats` counters (layout v1 in `lib/jit-region-stats.mjs`,
  read through `validationReadJitRegionStats`, copied twice to refuse a torn
  read; host time sampled on 1 call in N, 0 = counters only) and reads them.
  `summary.json` carries `p4` (`regionCycleShare`, `regionTimeShare`,
  `dispatchTimeShare`, `blockTimeShare`, `interpTimeShare`, `regionCalls`,
  `regionNotEntry`, `regionStops`, `sampleEvery`, `windows`) as shares of the
  pooled counters, so the four time shares add up to 1, and `baselineP4`; a
  share outside [0, 1] is refused. Without counters, `p4: null` and `p4Why`
  gives the reason, never a failure. `p4Compare` withholds the comparison
  when only one side has counters.
  A core with the 256-byte struct (0075) adds its diagnostics: the
  idle-skipped cycles are taken out of `regionCycleShare` (the KPI since
  2026-10-20; `regionCycleShareRaw` keeps all cycles, `cycleBasis` says which),
  the time in CoreTiming::Idle is apart (`idleTimeShare`, `idleCycleShare`),
  and `p4.diagnostics` holds the region pipeline counts and the four costliest
  block starts outside regions (`topMisses`).

## Second bench: the DGX Spark

`harness/remote/spark-run.mjs` runs a race-perf pair on the DGX Spark
(`ssh spark`, Tailscale) instead of this Mac, and brings it back under
`../measures/spark/<date>/<name>/`:

```sh
node harness/remote/spark-run.mjs --candidate <ref|dir> --baseline <ref|dir> \
  --state ../measures/harness/<race>.sav [--name n] [--runs 6] [--detach] [-- <race-perf options>]
node harness/remote/spark-run.mjs --fetch <date>/<name>   # a detached or interrupted run
node harness/remote/spark-run.mjs --build <ref>           # its core built on the bench, then --candidate spark:<ref>
```

- **Relative only.** Playwright's Chromium (Google Chrome has no Linux arm64
  build), Cortex-X925 cores. Each summary is stamped `host: "spark"`,
  `chromium: "playwright"`, and `kpi-report` never reads it for trunk's
  rows (`lib/kpi.mjs` `thisMac`). Compare the two sides of a pair, nothing else.
- **`video=null` instead of wgpu.** Headless Chromium there offers WebGPU on
  SwiftShader only, where the wgpu device is lost (black picture). The
  software renderer in dual core lets the emulated CPU wait on it: the race
  sits at the speed limit (100 % at `speed=1`, 150 % at 1.5, even on two
  little cores), so a CPU change cannot show. `speed=unlimited` stalls the
  scene. With `video=null` the race runs (≈10 k JIT blocks compiled, as on
  the Mac) with the CPU thread saturated at ~60 %, the regime of wgpu on the
  Mac (where null is no faster). So every query's `video=wgpu` becomes
  `video=null` and its WebGPU presenter `2d`, the rest kept; the default
  query is the Mac's race query swapped the same way. `--keep-video` turns
  this off. It measures the CPU side only: a change to rendering needs the Mac.
- It pushes this checkout's harness and what each side serves
  (`snapshotTree`: a ref exported with `git archive`, a directory as it is,
  cores and local changes included), keyed by content under
  `~/salon-bench/{harness,trees}/`, so a later pair reuses them. The disc is
  never pushed: the bench holds its only copy (`~/salon-bench/roms`, 700/600,
  PROGRAM.md); `--state` is pushed next to it once.
- **One pair at a time.** Chromium is pinned to cpus 15-19 (the big cores
  of one cluster, its own L3) and node to 10-14: lane `a`, port 8090, lock
  `~/salon-bench/.perf-lock`. A second lane (Chromium on 5-9, the other
  cluster) was tried and failed its A/A next to a pair in lane `a`
  (2026-10-21: σ 1.86 pt, one pair at +4.8 %, both pairs 1-7 % slower and
  over the load limit), so pairs only run in lane `a`. Since 2026-10-29 (the
  user's decision) the Spark is shared: cpus 0-9 are Excalibur's evals, 10-19
  Salon's. `--lane b`, `--screen` and `--multi` are refused, the queue's
  `wait` takes only a pair in lane `a` or a build, and a build compiles on
  10-19 with 10 jobs. Lane `b`'s lock stays, taken by builds. The Mac's lock
  and MESURE slots do not apply. `--chrome-cpus` / `--node-cpus` override the
  pinning.
- **Noise and the rule for a fine pair.** With Salon alone on 10-19
  (`excalibur.slice` held to 0-9 since 2026-10-29), a race-perf A/A in lane
  `a` gives σ 0.55 % per pair (`seq-aa-lane-a-5` and `-6`, race savestate,
  default query: speed 73-74 %; no side bias, pairs −1.1 to +0.4 %). A
  conclusion at ±0.5 % needs at least 6 valid pairs balanced in order (3
  trunk first, 3 head first: a standard error of ~0.22 %); 4 pairs are not
  enough. The load gate (`lib/bench-load.mjs`) counts only cpus 10-19: a
  window is overloaded when the median of its foreign runnable threads
  there, or two samples in a row, exceed 2; each window's load1 and counts
  are in the summary (`windowLoads`). When Excalibur's evals load cpus 0-9
  hard, the cold baseline still varies by ~5 % between runs (memory
  bandwidth is shared; pair #361, load1 15-40): on such days 6 pairs may not
  be enough for ±0.5 %. Look at `windowLoads` and the cold spread before
  concluding, and prefer a quieter hour or more runs. The GPU is shared too
  (and on the GB10 its memory is the machine's): another user's process
  above 20 % of its SMs at a window's start or end makes the window invalid
  and the gate wait, for a run on the GPU only (headed, or `video=wgpu` on
  a side; a headless `video=null` pair keeps the reading, and the memory
  gate covers the unified memory) (`gpuNow`, `nvidia-smi pmon`; the bench's Xorg counts
  as ours); each window keeps `gpu` and `windowLoads` its `gpuForeignSm`
  and `memAvailMB`. Memory too (`memNow`, no root): a window is invalid when
  MemAvailable is under 8 GB or falls by more than 4 GB during it, or when
  the memory pressure (PSI "some", 10 s) is above 10 % at its end; its
  major faults and swap-ins are kept. The memory controller's bandwidth is
  not readable (system-wide counters need perf_event_paranoid <= 0; the
  bench has 2).
- **First come, first served** (`spark-queue.mjs`). The locks are polled, so
  a burst of builds once retook lane a for half an hour while a pair queued
  before them timed out. Every job now drops a ticket in
  `~/salon-bench/queue/` (arrival time, its pid) and starts only when no
  older waiting ticket could use a lane it wants and that lane is free; a
  build wants both. On the Spark, `node harness/remote/spark-queue.mjs list
  --eta` shows the queue with each job's estimated start and end (from its
  race-perf options; ~3 min a build). Pairs wait up to 4 h by default
  (`--lock-wait`).
- **Reordering is the judge's call:** `spark-queue.mjs move <name> --after
  <name|head> --as-judge` renames a waiting ticket between its new
  neighbours (logged in `queue/moves.log`). A waiting job finds its ticket by
  its pid at every poll, so it follows the move. Never rename a ticket by
  hand while a job from before this change waits on it: such a job keeps
  its old name and would wait for itself. Compare sides of one pair only, never a lane with the
  other. `--chrome-cpus` / `--node-cpus` override the pinning.
- `--build <ref>` (a commit of the fork; at most 3 builds of one agent,
  counted by its Mac worktree's name, wait or run at once, beyond which
  spark-run refuses: wait for one of yours to go through) builds its core on the bench with
  the pinned toolchain (`build-core-repro.mjs --install --reset-vendor
  --ccache`, linux-arm64) in one build checkout, `~/salon-bench/build/work`,
  whose CMake tree, Dolphin sources and ccache carry over (~7 min cold, 1-3.5
  min after another commit; the core's bytes do not depend on the path), and
  exports the tree it serves to `~/salon-bench/build/wt/<commit>`, in its turn, holding both
  lanes' locks (lane `b` also waits while a build of an older harness,
  without a ticket, exists);
  `--candidate spark:<ref>` / `--baseline spark:<ref>` then serve that
  worktree. A core built there differs in bytes from CI's and from a Mac
  build: compare it only with another core built on the bench.

## Drop meter (merge guard and nightly)

`harness/probes/drop-meter.mjs` measures speed drops over a whole
play-through, not a race in steady state: boot, menus, the race's load, a
race (`harness/probes/drop-scenario.json`, inputs at guest seconds so every
run presses the same buttons at the same place). Each run is a new profile,
played cold then warm (`--visits 2`). It keeps every VI output and present,
and every 50 ms the worker's counters (`validationDropSampler`) and the
page's stalls, then cuts them into 100 ms windows: drops with their cause
(JIT compiles, patch 0167; region installs; disc waits; GPU and EFB waits;
wgpu pipelines; late throttle wake-ups; worker and main-thread stalls;
`uncounted-busy` when the CPU thread hardly slept), loads (host against guest
time), and per run, visit and phase: time lost, time under 95/90 %, worst
second, hitches over 50/100 ms, present p99, load excess, audio underruns.
A timing measure: it takes the perf lock.

```sh
# A/A (noise of every metric) and the baseline report
node harness/probes/drop-meter.mjs --iso ../roms/<disc>.iso --port 8113 --runs 6
# merge guard: this tree against main. Gating metrics only: per phase the
# time the core stood still (stallMs, from the VI intervals) and the gaps
# over 50 ms, per visit the hitches over 100 ms and the worst second; each
# against its A/A noise (medians of n: t(n_AA - 1, 99.5 %) x 1.25 x sd x
# sqrt(2/n)). A failed run is played once more. A regression must reproduce on a second batch
# (--no-confirm skips it). Exit 0 none, 2 regression, 3 no verdict (too few
# usable runs, gave up, a phase without a verdict, sides sampled differently)
node harness/probes/drop-meter.mjs --iso ../roms/<disc>.iso --port 8113 --runs 3 --baseline origin/main --noise <A/A dir>/summary.json
# nightly on main, with its history (JSONL + table)
node harness/probes/drop-meter.mjs --iso ../roms/<disc>.iso --port 8113 --runs 3 --trend ../measures/drops/trend.jsonl
# --display: the worker's rAF records what each BeginFrame put on screen;
# the gating then reads the screen (per phase: distinct images' interval
# excess and intervals of 3 vsyncs or more; per visit: gaps over 100 ms and
# the worst second) instead of the presentation timeline, which a change to
# the presentation itself biases (present-vsync). Its A/A must be --display.
# --state scene.sav --state-delay-ms N: the savestate loads no earlier than
# N ms after the browser's launch (0, the default: as soon as the core runs,
# ~2 s; a first launch's region translation is then barely started, while
# at ~4.5 s about 50 regions are in). Recorded in the summary; the --noise
# A/A must have the same delay (an older summary counts as 0).
# The power source (macOS pmset: mains or battery) is read at each visit's
# start and end ("mixed" when it changed) and the batch's sources go in every
# summary (powerSources); --noise refuses an A/A on the other source or with
# mixed sources, and a batch mixing them gives no verdict (exit 3). Since
# PROBE_VERSION 3 an A/A from before the field is refused too (redo it).
# Decision measures: on mains. Every measuring probe's perf lock waits for
# it (acquirePerfLock requireMains: no ticket while on battery, the turn
# given back if unplugged meanwhile); unplugged under the lock, the next
# gate gives the lock back and the run is played again (race-perf a run,
# drop-meter a visit marked mixed). e2e and builds are not gated.
# A command under the lock (an e2e, a build, a custom probe):
#   node harness/lib/lock-run.mjs --name "<who>" [--measure] -- npx playwright test …
# follows the command's process tree while it runs and, once it exits,
# waits for every process it saw (10 s), then SIGTERM, then SIGKILL, before
# giving the lock back: a run's Chromes and dev servers never outlive it
# (2026-10-27, an e2e's Chromes at load 25 under the next measure).
# The --noise A/A must have run on the core of the base measured (the
# summary records each side's core): another core gives no verdict (exit 3),
# --noise-stale-ok for a study. Redo the A/A when main publishes a core.
# Known blind spots (review of #261): a single 50 ms stall at the race load
# on a COLD visit reads 34-50 ms against a 45 ms threshold there (noisier
# phase); repeated stalls under 25 ms each stay under the per-phase floors
# (the reported pctBelow95 per phase shows them, not gating). stallMs is
# the larger of the VI reading and the sampler's (50 ms rows under 0.6 of
# the local speed, the median within +-1 s), so a stall inside a long VI gap
# counts too (at least half of it when the core makes it up right after);
# a sustained slowness is no stall (slowRowsMs reports it). Images per
# guest second per phase (presents, or distinct images shown with --display)
# catch a cadence halved with the core at 100 %.
# presentExcessMs (gaps beyond max(two fields, 1.5 x the phase's median),
# summed) catches the presenter stalling while the core runs on, at 60 or
# 30 images/s. A --noise with no core recorded, or another core, stops the
# comparison before its first run (exit 3). Hitch counts never get an sd under Poisson's (sqrt(mean + 0.5)),
# judged at the normal 99.5 % quantile then. Measured on 12 runs of one tree
# (independent A/A noise): 0.0 % of batches flag a regression (3000 draws).
# Outlier runs of the A/A (beyond 5 robust sds, MAD not 0) are counted in
# the summary (outliers); they are left out of the threshold's sd only with
# an A/A of 10 runs or more and when a single run is off (degrees of
# freedom of the runs kept): from 6 runs the MAD is too noisy, and outliers
# that recur are part of the noise. The summary records the probe's version
# (PROBE_VERSION, what it runs in the page and worker); --noise must match.
# The ticks reading misses stalls of 1.5 s or more (the +-1 s median falls
# with them) and, where the core runs slow, any stall shorter than 3 rows
# nearly stopped: the VI reading covers both, outside VI gaps. With
# --display, a gap of the worker's rAF while the page's rAF goes on is no
# screen measurement (screenUnmeasuredMs, muteRafSpans), not a loss.
# beginFrameGaps: the longest gap without a BeginFrame, the worker's rAF
# (--display) and the page's (always), reported: headless, the worker's rAF
# sometimes stops 1-4 s while presents go on.
# the guard's false-positive rate from runs of one tree (A against A draws)
node harness/probes/drop-meter.mjs --false-positives <A/A dir>:candidate --noise <A/A dir>/summary.json
# again from the raw data, e.g. against a native reference (game frames per guest second)
node harness/probes/drop-meter.mjs --analyze <dir> --native <native-ref.json>
# dip attribution (runs recorded with --display): each second under 95 % or
# with a hitch over 25 ms split into causes that add up to its lost frames
node harness/probes/drop-meter.mjs --analyze <dir> --attribute
```

Attribution and the beat label (`harness/lib/drops.mjs`): the screen's
refresh and the core's VI rate are both fitted by regression
(`fitPeriod`). Blocks of 300 timestamps are each fitted alone. For the VI,
a block off the median block by more than 3.5 of its own standard errors
is cut out of the fit: slowdowns of 0.1 % over 12 s or 3-7 % over a few
seconds never bend the VI rate. For the refresh, such a block makes it null
(one screen rate or none: 60 → 59.94, 60 → 72, 60 → 120). A fit less
precise than 5 mHz is also null. This check is a fail-safe and sometimes
nulls a steady 60 Hz screen: from 1-2 runs in 20 up to 8 in 20 over 300 s
with 10 % of vsyncs missed (review of #414). A null refresh only means no
beat is proven in that run. On real Mac runs the VI fit keeps about
half the VIs: the game's speed varies a little from block to block.

A repeat is labelled `beat` only when the two rates drift, the repeat
falls at the common phase boundary within 3 sigma of the VI timestamps'
measured jitter (Mac: 0.7-0.95 ms, so about 2.1-2.8 ms), and it is a single
tick. **Read `beat` as an upper bound.** On a drifting screen, an isolated
random drop inside a crossing window cannot be told from the beat's own
jitter repeats: 21-26 % of such drops are labelled beat (synthetic
60 / 59.94 Hz at σ 0.7-0.9 ms). On a screen locked to the VI rate, nothing
is labelled beat (slowdowns from 0.1 % to 7 % included).

Render-starved (`render-starved`): the guest at full speed, the GPU thread
saturated, and the core rendering (XFB copies) under half the scene's
cadence (0.475). The VI and the presents keep their rate and the presenter shows
the old picture on every VI, so speed, `lostMs` and the pictures counted per
VI see nothing. Measured on the software renderer (Firefox without WebGPU,
2026-11-03): 7 copies a second at 100 % guest speed, "0 ms lost". In such a
second "shown" is capped at produced + 2. The run line prints `rendered
N/guest s` and RENDER-STARVED when the rendered rate is under 0.475 of the
presents' with the GPU thread ≥ 70 % busy over the run. A CPU-decoded movie
(few copies, quiet GPU thread) is not starved. parcours, without the
worker's produced counter (off WebGPU), takes the sampler's XFB copies a
second instead (`producedFrom: "xfb"`). A negative counter difference (the
counters reset at a state load) is unmeasured, never a loss, and left out
of `renderedPerGuestSec` and `gameFps`.

No-present causes (`harness/lib/no-present.mjs`, `--attribute` writes
`no-present.json`; record with `--pipeline` for the stages): every
BeginFrame of a phase that showed nothing new while an output was due,
classed fifo-behind (a 0211 hold), fifo-lag-minor, gpu-busy, replay-late,
beat-phase, swap-not-ready, other or unknown. **This is not the set the
attribution counts:** attributeDips counts its `no-present` frames over the
dip seconds only, after the proven beat and the presenter-blocked frames.
The `in dips` column restricts the table to those dip seconds. `beat-phase`
is a classification by the VI's phase on the BeginFrame grid (band 0.8-0.1
by default), not beatEvidence's frame-by-frame proof. Missing stages
(swap, tag or queued present absent, an excess no stage explains) are
`unknown`; a ring loss leaves the run out and is reported.

A second at full speed with a thread between 0.7 and 0.85 busy (no margin,
not saturated) is `marginal`: content or game, undecided. It is reported
apart (`marginalFrames`), not counted in the frames lost. The expected
cadence is capped at the run's standard VI rate (59.94 or 50, from the
median over the run of VIs × 100 / speed), never at a second's own VI
count: in a stall that count falls while the speed read may be stale, and
the frames owed must not fall with it.

## Parcours (the whole play-through)

`harness/probes/parcours.mjs` measures emulation speed and what the player
sees everywhere a player goes, not only on race savestates: it boots the
disc with no savestate and plays a pad film through the title, the menus, a
selection, a load, a full game round, its results and back to a menu. Once
a second (nothing per frame) it reads `__lastFrameInfo` (speed, new frames
shown and produced, occupancy of the CPU thread, GPU thread and replay
worker, the replay's draws), the drop sampler at 1 s (core ticks, disc
bytes, EFB→XFB copies), the timeline (every present and VI output) and the
replay's integrity counters, and every present gap past 25 ms with its VI
outputs and the presenting worker's stall inside it (the drop sampler runs
every 100 ms, drained once a second; PROBE_VERSION 2). `lib/parcours.mjs` (pure) derives per second
the speed (guest/host time from the core ticks), new frames per second
(analysis 4: every present of the timeline binned on a fixed 1 s grid, each
counted once whatever the readings' times; by frame tag and epoch when the
run recorded them, `newFramesBasis: "tag"`, a re-shown duplicate or an
older frame not new; else `"all"`, every present one; a second is unknown
when a reading that may hold its presents was not read whole, counted as
`smoothUnknown`, the phase's p5 marked unreliable past 5 %; A/Bs and noise
across bases refused; the worker's own 500 ms rate, kept as `newFpsWorker`,
saw half the second: one 50 ms hitch read 93.3 %),
smoothness (new frames against the game's cadence, learnt as the site
learns it: VI/n snapped, below the VI rate only with occupancy margin, else
the VI rate; in a content second, where the game itself made fewer frames
at full speed with margin on every thread, against what it made), present
hitches over 50 and 100 ms, and summarises each phase
and each film section: min, p5 and median of speed, new frames and
smoothness, the 3 worst seconds, hitches, integrity, occupancy, seconds.

A film may declare its phases on its own clock, `"phases": [{ "at": 1240,
"phase": "cinematic", "label": "intro" }, { "at": 2130, "phase": "menu" }]`
(each from its poll to the next one's; null: the detector's from there): each second then takes the declared
phase covering most of its film span, the same in every run, where a
detected boundary moves with what is measured. RESYNC markers are no
boundaries: one is recorded once the phase has been seen for 2 s. `--analyze
dir --film film.json` re-analyses runs recorded without them (the film's
markers must be the runs'). Before the first declared phase, and in a film
declaring none, phases come from generic signals only (thresholds in `lib/parcours.mjs`),
each lasting at least 2 s (a shorter run joins the phase before it):
`boot` before the first new frame; `loading` when the disc reads ≥ 2.5 MiB/s
while new frames fall under 90 % of the cadence; `cinematic` for new frames
without EFB→XFB copies, or with a disc stream (≥ 0.5 MiB/s) and almost no
draws (< 30 a frame: a movie decoded on the CPU and drawn as a quad, which
the GPU still copies); `game` against `menu` by the replay's draws per frame
made (≥ 200 by default; a film may set its own, `detect.gameDrawsPerFrame`).
Draws per frame are a weak signal: a lighter game mode can draw as little as
a menu, and then only the film's own threshold (data) separates them.

A film (local data, never in the repo, like the disc):

```json
{ "unit": "poll", "ports": [0, 1], "end": 34760, "detect": { "gameDrawsPerFrame": 200 },
  "steps": [
    { "at": 120, "port": 0, "mask": 1, "stick": [128, 128] },
    { "at": 1558, "phase": "menu", "label": "title", "timeoutSec": 60 },
    { "at": 5657, "port": 0, "auto": { "amp": 60, "periodPolls": 180, "recoverPolls": 300, "bias": 0 } } ] }
```

`at` counts the game's own SI polls (the lowest port's), so a replay presses
the same buttons at the same frames whatever the speed (salon's
measure-safari format, `harness/lib/pad-film-worker.js`, a worker writing
the core's direct pad block one poll ahead, ports 0-3). In dual core a
replay drifts after a minute or so, hence RESYNC markers: at a marker the
film holds (neutral pad; a port under the autopilot keeps driving) until the
phase found matches, or `timeoutSec` (default `--marker-timeout`) passes:
then the run is INCOMPLETE and never counts. `auto` drives a game round (A
held, the stick a sine around 128 + bias; when the picture stands still,
element screenshots compared every 2 s, B and the stick the other way) until
the port's next pad step. `--edge '{"0":[0,0,1,1]}'` lets it steer from the
picture instead (`lib/edge-follower.mjs`: the road's colour learnt at the
drive's start, the widest run of it on a few rows, per port view for a split
screen); on the first disc it stays on the road more often but still does
not finish a race (no sense of direction), and its capture stream makes such
runs another measure (`--noise` checks it). Menus drop a stick press made
while a screen is still opening: a film's steps wait for it to settle
(≥ 3 s after a pause, for instance). A run is COMPLETE when every marker was reached in
order and the phases found contain the markers' phases in that order.

```sh
# a first film without a human: a host-time step list (lib/steps.mjs kinds,
# Playwright key names mapped like the engine's keyboard, plus
# { "mark": "menu", "label": "title" } and { "auto": 240, "until": "menu" }),
# recorded on the polls it took effect; --shots keeps a picture per mark
node harness/probes/parcours.mjs --iso disc.iso --port N --record steps.json --film-out film.json --shots [--shot-every 5]
# replayed: summary.json (per second, per phase, per section, completed,
# probe version, machine, power, load), timeline-<side>-<run>.png (speed and
# new frames against time, phases as coloured bands, markers)
node harness/probes/parcours.mjs --iso disc.iso --port N --film film.json [--query "cpu=single…"]
# A/A, then A/B: runs alternate the sides; each phase kind (kind:game) and
# section (section:race) is compared on its own, never by timestamp
node harness/probes/parcours.mjs --iso disc.iso --port N --film film.json --runs 6
node harness/probes/parcours.mjs --iso disc.iso --port N --film film.json --runs 6 --baseline origin/main --noise <A/A dir>/summary.json
```

The query is the product's (`cpu=dual`) unless `--query` says otherwise. A
timing measure: load gate and mains only, the perf lock (`--no-lock` under
`lib/lock-run.mjs`); a watchdog started once the lock is held ends a probe
that overruns. Exit 0 complete, 1 a run failed or did not complete, 2 a
regression or a broken integrity, 3 no verdict. On the Spark:
`spark-run.mjs --probe parcours --film <local film.json> --headed :2 -- --query "<product query>"`
(the film is pushed private next to the disc). `lib/parcours.mjs` takes
samples from any source: the iPhone through the Safari agent's
measure-safari can feed it the same fields (its film player is this one's
origin).

## KPI probes and report

The program's KPIs (PROGRAM.md, « KPI du programme ») that race-perf does not
cover have their own probes. They are timing measures: they take the perf
lock and run in the MESURE slots only, headless, three runs by default.

```sh
node harness/probes/ttff.mjs --iso ../roms/<disc>.iso --port 8082 [--config wgpu] [--runs 3]
node harness/probes/first-launch.mjs --iso ../roms/<disc>.iso --port 8082 [--runs 3] [--timeout 600]
node harness/probes/first-launch-ramp.mjs --iso ../roms/<disc>.iso --port 8082 --scene race --steps race-steps.json [--sec 90]
node harness/kpi-report.mjs [--print]
```

- `ttff.mjs`: time to first frame. t0 is the moment the disc is handed to the
  engine page (the file input, as the Play click does). The KPI is the first
  non-uniform picture on the screen canvas (so neither black nor blank) after
  the first present of a core frame (vi > 0): the worker presents empty
  frames during the boot. Also recorded: first core frame, first empty
  present, core loaded. Cold is a new profile, warm the same profile
  relaunched. A launch without that picture within `--timeout` fails, and a
  phase with a failed launch does not pass, whatever the median.
- `first-launch.mjs`: duration of the first-launch optimisation (P7) and the
  regions recompiled on the second launch. It boots with `aot=1` and reads
  `validationReadAotProgress` (or `window.__aotProgressLog`), contract in
  `lib/aot-progress.mjs`. A launch without "done" (or a second launch without
  its compiled count) is a failure with its reason. An engine without P7
  answers `p7: null` and n/a, exit 0.
- `first-launch-ramp.mjs`: a player's very first launch with `aot=1`
  (added to `--config rec` unless the query says otherwise), on a new, empty
  profile (no seed, unlike aot-warm-launch): disc handed over, then
  `--steps` (to the race, or a click and the intro for `--scene heavy`),
  then `--sec` seconds. Every second it drains the VI ring, reads the region
  pipeline (`validationReadJitRegionStats`, read only) and the core's XFB
  copies (`validationReadHeadroomStats`, on once after the boot). The KPI
  is on useful game frames: the product runs decoupled, its VI speed stays
  at 100 % while the game frames fall behind. Per run (`lib/ramp.mjs`),
  from the scene's start: time to 90 % and to 95 % of the scene's native
  game frames per second (`SCENE_NATIVE_FRAMES_PER_VI`) held 5 s, the
  plateau (`--plateau FROM-TO` seconds, default the heavy intro 0-17 s, the
  race's last 10 s), the time to 90 % of that plateau; the VI speed ramp
  apart; the per-second game, VI and installed/queued region series. KPI:
  time to 90 %, target 15 s, one row per scene; a run that never reaches
  90 % fails the row.
- They all record the served tree (commit, dirty) and the Chrome that ran, and
  leave out runs started on an overloaded machine (listed). `--no-lock`
  checks the plumbing in a CORRECTION slot; such results are not measures.
- `stream-track.mjs`: what a streaming host would encode, with the local
  display at the same time. It attaches the worker's stream track
  (`window.__host.captureVideoTrack()`), reads it in the page through a
  `MediaStreamTrackProcessor`, and records over `--secs` the stream's rate,
  capture and arrival intervals and gaps over 25 ms (`lib/stream-track.mjs`),
  next to the core's VI intervals, the presents, the `--display` counter and
  the presentvsync counters. Takes the perf lock unless `--no-lock`.
- `kpi-report.mjs`: reads only. It classifies by content every `summary.json`,
  `gate.json` and `fuzz.json` under `../measures` and the worktrees'
  `harness/results`, and keeps only results measured on a clean commit of
  origin/main's first-parent history (`served`, or the run files next to an
  older summary; fetch origin first). Each KPI reads one result, the newest
  of its kinds on trunk (race-perf and first-launch-ramp: stock Chrome on
  this Mac and a load limit (`--max-load`) of 6 at most, whatever the hour;
  runs at a higher limit only compare two sides; trunk's side of an A/B), shown with its file, commit and date; it never falls back on an
  older one. Failed runs make the row KO with their reasons. Output:
  `../measures/kpi/latest.{md,json}` and a dated copy, in PROGRAM.md's order,
  each row measured, declared or n/a. What no probe measures yet (PC
  extrapolation, discovery coverage, aotcompiler memory) comes from
  `../measures/kpi/manual.json`:
  `{ "<kpi id>": { "value": <number>, "source": "…", "at": "…", "note": "…" } }`;
  an unreadable file turns those rows into n/a with the reason.
  `--candidate <race-perf summary.json>` adds a column beside trunk's; a
  candidate measured on another machine (`host`) or with other Chrome
  arguments than trunk's stock Chrome is shown but flagged as not
  comparable (`setupOf` / `setupDifferences` in `lib/kpi.mjs`: absent
  arguments count as none, so Spark summaries from before and after the V8
  flag of PR #145 never compare).
  A **candidate** column (a PR's head, measured before it merges) can sit
  beside trunk: `--candidate <race-perf summary.json> [--candidate-label …]`,
  or `../measures/kpi/candidate.json` `{ "summary": "<path from the program
  root>", "label": "…" }` so each refresh keeps it. The rows race-perf feeds
  read that result's candidate side; the column shows its own verdicts, its
  commit (and local changes) and query flags, and never changes trunk's.

`harness/matrices/local-kart-race.json` runs the same race through `ab`
(`KART_ISO`, `KART_STATE`; `measureFromState` starts the measured window
from the savestate; local only). In dual core the race gives several pictures
per commit, so `rec` and `wgpu` are listed `report-only` for renderVsBaseline
(kept for perf and the other checks); `rec-single` and `wgpu-single` run on the
fixed clock and carry the exact render comparison.

## AX HLE share of the CPU thread

`harness/probes/ax-hle.mjs` measures how much of the CPU thread goes into the
AX HLE audio synthesis, which runs a whole command list synchronously inside
the DSP mailbox MMIO write (research/deep-thread-budget.md §2). It reads the
core counters of patch 0099 (`DolphinWeb_AxHleStats`, layout in
`lib/ax-hle-stats.mjs`, worker message `validationReadAxHleStats`), off until
the probe resets them:

```
node harness/probes/ax-hle.mjs --iso ../roms/<disc>.iso --port 8092 \
  (--state ../measures/harness/race-after.sav | --steps harness/probes/local-menu-steps.json) \
  [--query "..."] [--runs 3] [--warmup 20] [--secs 20] [--max-load 6]
```

Per run: the scene (a savestate, or input steps such as the loaded menu of
`local-menu-steps.json`), `--warmup`, then a window of `--secs` with the
counters on (two clock reads per mail, a few hundred per second).
`summary.json` gives `shareOfWindow` (host time in the mail handling over the
core's window), `shareOfActive` (the same over the CPU thread's occupancy,
the busiest renderer thread sampled in the window, so a capped scene that
sleeps in the throttle is not understated), `msPerSecond`, `mailsPerSecond`,
`meanMailUs` and `mailMaxMs`, medians of the good runs. Calm machine first,
then the perf lock, as race-perf.

## CPU thread time per second (dip windows)

`harness/probes/cpu-window.mjs` splits the emulated CPU thread's host time,
second by second, into the parts the core counts, and says which part grows
in the seconds that dip (speed under 100 %, or the CPU thread saturated).
Headless, one tree (`--candidate <dir>` serves another exported tree), one
run, under the perf lock (calm machine first; a loaded or unplugged machine
gives the lock back while it waits; the watchdog counts only the measure,
with the lock held, and releases the lock when it fires):

```
node harness/probes/cpu-window.mjs --iso ../roms/<disc>.iso --port 8092 \
  --state ../measures/harness/race-after.sav [--hold KeyX] \
  [--warmup 25] [--secs 30] [--step 1] [--vi 1200-1500] \
  [--dip-speed 99] [--dip-busy 0.95] [--region-sample 64] [--mem-warm 5] \
  [--untimed-secs 5] [--config product | wgpu | --query "..."] [--out dir]
```

The query defaults to the product's (drop-meter's `PRODUCT_QUERY`, what
Salon runs: `aot=1&aotcompiler=1&jitoffthread=1`, so regions run);
`--config wgpu` (the race-perf preset) has no `aot=1` and no region ever
runs there. The header prints the query, the regions installed and their
mean coverage of guest cycles, and a WARNING when the query has no `aot=1`,
no region was installed, or they cover under 1 % of the cycles.

After `--warmup`, it turns on (one reset each) the region JIT stats
(`validationReadJitRegionStats`, `sampleEvery` = `--region-sample`), the
memory access stats (`validationReadMemAccessStats`; its first reset clears
the JIT cache, hence `--mem-warm` s before the first read: the blocks
recompile, the installed regions stay and are only checked again before
their next run, 0075 `ClearOffThreadAndRegionState`), AX HLE
(`validationReadAxHleStats`) and the headroom counters
(`validationReadHeadroomStats`). The region stats run `--untimed-secs`
untimed first (`sampleEvery` 0, the window that prices the timing, below),
then timed; the probe reads all four and the core ticks every `--step` s,
never resetting again. Each row is the difference of two
consecutive reads (`lib/cpu-window.mjs` `cpuWindowBreakdown`), with the VI
outputs since the load drained from the timeline in that step (`vi.from` to
`vi.to`, the index race-perf's `hitchList` gives). For a dip another probe
located, pass its VI range as `--vi FROM-TO`: only the rows overlapping it
are kept, classified and contrasted. A range no row covers, past the last
VI the run reached (a longer `--secs`), or before its first, FAILS the probe
(exit 1, the reason printed, `viError`) rather than reporting "no dip row";
rows without a VI range are left out and counted (`rowsDroppedNoVi`).
`summary.json` holds `rows` (and `allRows` with `--vi`), `dips`, `contrast`
and the decoded `snapshots` (to recompute any window). `--dip-busy` is a
share of host time, 0 to 1.

Each row: `hostMs` (the CPU thread's own window, headroom `windowUs`;
`hostSource: node` when the headroom counters are missing or reset),
`guestSeconds`, `speedPct`, `cpuBusyShare` (host minus throttle sleep minus
FlushGpu wait, as `src/occupancy-stats.js`), and `ms` / `shares` (of host
time) / `perGuestSecond` per part:

| part | what it is |
|---|---|
| `regions` | inside region calls |
| `blocksDispatch` (table `b+d`) | the rest of the slice loop: JIT'd blocks and the cached-interpreter callbacks between them, with everything they call (MMIO, memory slow paths, the gather pipe, AX HLE, the block compiles after a lookup miss), the block lookups and the loop itself |
| `interpreter` | null: the core does not separate it (interpreted instructions are in `blocksDispatch`) |
| `idle` | `CoreTiming::Idle`, less the FlushGpu wait it contains |
| `installs` | region module installs (slice boundaries and throttle-sleep windows) |
| `other` | busy time left: `CoreTiming::Advance` and its events (VI, SI, DSP and audio events), the throttle's bookkeeping, slice set-up, edge noise; clamped at 0 (`overAttributedMs` keeps a negative rest) |
| `sleep` | throttle sleep |
| `flushGpuWait` | waiting for the GPU thread in FlushGpu (SyncOnSkipIdle on only) |
| `axHle` | AX command lists in the DSP mailbox write: **nested** in `blocksDispatch` or `regions`, never added |

The parts but `axHle` add up to `hostMs`; the table's `over ms` column
shows `overAttributedMs` (parts past the busy time, `other` clamped at 0),
also counted in the verdict line.

Blocks and dispatch are ONE part. The core's split of the two (kept per
row in `split`, `reliable: false`, information only) is biased: per block
call, patch 0075 adds `max(call - its region time - its lookup time - its
Idle time, 0)` to blocks, the lookup time being 0 on the calls whose lookups
are not timed and N times one lookup on the sampled one, and dispatch is
the slice's residual. So the unsampled lookups stay in blocks, and on a
sampled call N lookups usually exceed the call: the clamp moves the block's
own time to dispatch. Their sum is exact; `contrast` and `grew` use it. Also per row: `regionCoverage`
(region cycles over all cycles, and outside idle skip), and `mem`: memory
slow paths per 1000 guest instructions (`slowPerKiloInstr`, counted blocks
plus the regions' estimate), `slowShare` of accesses and `slowByKind`
(counts only: their time is inside `blocksDispatch`/`regions`). A struct the core
lacks, or a counter that went back (a reset), gives null fields with the
reason in `why`, never zeros.

`contrast` compares the dip rows with the normal ones in host ms per guest
second (a dip has no throttle sleep, so every part's share of host time
grows; per guest second only what costs more for the same emulated time
does); `grew` lists the parts that did, largest first.

Sampling: with `sampleEvery` > 0 the core times every region call, every
block call and every Idle; only the block lookups are timed 1 in N, and the
core multiplies them by N itself. The struct's times are totals and are not
rescaled; `--region-sample 0` gives counters only (every time null). Two
clock reads per block call slow the CPU thread: the speed under the profiler
is lower than without it, so compare rows of the same run, never this speed
with race-perf's. The header's `timing cost` prices it on the same run:
busy CPU-thread ms per guest second in the timed rows over the untimed
window just before (`timingCost` in `summary.json`, with both speeds); the
scene moves between the two windows, so it is an estimate. With regions on,
fewer block calls are timed and the cost falls. The console says it in so
many words: "absolute numbers inflated x<cost> by the per-call timing,
compare within a run only". The headroom window moves at each Throttle and the region
times at each slice: about 1-2 % of a 1 s row is edge noise, in `other`.
Not separated by any counter: the gather pipe and FIFO writes, MMIO and the
memory slow paths' time (all in `blocksDispatch`/`regions`), and CoreTiming events
(in `other`).

## Profiling the generated wasm (regions)

Where the CPU thread's cycles go inside the generated code
(research/deep-region-profiling.md). One dedicated session, never a speed
measurement (jitdump on, no sandbox, sampling), on a perf lock only so it
does not overlap anyone's window:

```
# macOS: samply wraps the run, the window is filtered afterwards
samply record --save-only -r 2000 -o OUT/profile.json.gz -- \
  node harness/probes/profile.mjs --iso ../roms/<disc>.iso --out OUT [--query ...] [--warmup 40] [--secs 20]
node harness/probes/wasm-hot.mjs --jitdump OUT/jit/jit-<pid>.dump --samply OUT/profile.json.gz \
  --window OUT/window.json --top 30 --insns 12 --annotate 5 --out OUT/asm
# Spark (perf attached to the renderer for the window, FIFO queue, lane a)
ssh spark 'cd ~/salon-bench/<tree> && setsid nohup sh harness/remote/spark-profile.sh ~/salon-bench/profiles/<name> ~/salon-bench/roms/<disc> >/dev/null 2>&1 &'
```

`profile.mjs` runs Chrome with `--no-sandbox --js-flags=--perf-prof` (V8
writes a jitdump with every code object's address, name and bytes) and
writes `OUT/jit/` and `OUT/window.json`; `OUT` must be outside the
repository (≈ 400 MB for 75 s). `wasm-hot.mjs` maps the samples to the
jitdump's code objects, ranks the wasm functions by self time and
disassembles the hottest instructions; region functions are named
`r<id>_f<entry PC>` once the region modules carry a name section. On the
Spark, perf needs `kernel.perf_event_paranoid <= 2` for the bench user.

## Freeze probes

During the measured window the timeline is drained every second. When it
shows a freeze starting (no VI output for 2 s: core; or no presentation for
2 s while VI outputs go on: present), the harness reads the worker's WebGPU
replay and GPU sync state (`validationReadWgpuReplayState`) 4 times, 500 ms
apart, and stores it in the run's JSON as `freezeProbes` (at most 3
episodes per run, each state cut at 64 KB). A served worker without that
message gets none and the episode is recorded as `unsupported`. Evidence
only: freezes are judged by coreFreeze as before.

A third kind shows neither: the guest runs at speed, VI and presents go on,
and the game draws nothing (no EFB-to-XFB copy). `probes/savestate-cycles.mjs`
checks it around savestates: after the first load and after each of N loads
or save-then-load cycles, XFB copies (headroom) and DrawDone signals
(GPU sync) must move within `--settle` seconds; a stall fails the probe and
prints the CP FIFO. Before patch 0116, the first load after boot on
`video=wgpu` left the FIFO empty with commands pending (`rwDistance` 0,
read != write).

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

A **CDP pipe fault** is the harness losing Chrome, not the emulator crashing:
under heavy load (seen on 2026-10-19, several sessions at the same minutes)
Playwright receives an empty message from Chrome and its `JSON.parse` throws
outside any harness code, which used to kill the process with every run not
yet written. `lib/browser.mjs` catches that one exception (anything else
still ends the process), closes the browsers open at that moment and marks
them (`context.pipeFault`). A matrix cell is then recorded as an infra crash
(`kind: "cdp-pipe"`) and run once more; lost again, it stays unjudged. It is
never counted against a side. race-perf records the run as failed with `why:
"infra"`; ttff and first-launch leave the launch out and list it (`infra`,
`infraRuns`), as they do with overloaded runs.

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

## Replay gates under WebKit

`replay-gates --exact` holds the default rendering to the reference's very
pixels: in cpu=single the XFB at a VI is bit-exact, Chrome against Chrome is
0 pixel apart. Safari cannot meet that and should not be asked to: WebKit has
no dual-source blending, so the core blends with a fallback whose rounding
differs from Chrome's on blended edges. A real Safari 26 against Chrome (IR 2,
2026-11-01, two VIs, 1.09 M pixels each): 4 % of pixels 1 to 3 levels apart,
8 pixels more than 3 apart, one of them at 17, all on edges.

`--webkit-frames 'cap.vi{vi}.png'` (with `--exact`; comma-separated for
several runs) compares the frames a real Safari captured (measure-safari
`--capture-vi`, the same VIs, internal resolution and query) against the
Chrome reference, which this run plays and checks bit for bit across its own
visits. The criterion counts pixels by distance instead of trusting the single
worst one, a fragile statistic (one pixel at 17 says nothing a threshold of 16
would not get wrong the next scene). A bounded blending error gives many
pixels a little apart and almost none far apart; a real rendering error (a
wrong texture, a block drawn at the wrong place) gives a patch of pixels tens
to hundreds of levels apart:

| pixels more than | at most | why |
|---|---|---|
| 3 levels | 0.1 % | the blending rounding itself stays at 1-3 (measured: 0.0007 %) |
| 16 levels | 0.001 % (~11 px at IR 2) | an isolated pixel past the rounding passes |
| 64 levels | none | a wrong texel or a moved block is far above it |

The shares are of the frame's pixels, so what they let through grows with
the internal resolution: at IR 2 (1216x896, 1.09 M pixels) a 33x33 patch
16 levels off, or 10 pixels 64 levels off, passes; at native (608x448,
0.27 M) neither does. Compare at the same IR on both sides (a size that
differs fails), and read a pass at a high IR with that in mind. Every
reference visit must have its frame and the same hash (a visit without one
fails, it is never left out), and an integrity counter or an A-B-A under
`--flicker` fails the run as in `--exact`. The frames come from
`harness/probes/safari-capture.mjs` (a fresh Safari per run, the state
loaded, `run<k>.vi<VI>.png`).

`--webkit-tolerance "over=0.1%,big=0.001%,max=64"` changes them; raising one
to make a failing scene pass defeats the gate: look at the kept pictures
(`out/webkit-<VI>-reference.png`, `-run<k>.png`, `-run<k>-diff-x8.png`)
first. It never applies to the default `--exact` (Chrome against Chrome).

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
| renderVsBaseline (ab) | per cell, the candidate's capture differs from the baseline's at the same VI output; catches what all configs of one commit get wrong together. Intended changes: `--accept game/config`. Each side must first agree with itself across runs. Baseline nondeterministic, candidate stable: known (not blocking) if the candidate's picture is one of the baseline's; otherwise, for a cell listed in `harness/known-failures.json`, known only if it differs from the closest baseline picture by no more pixels than the baseline's pictures differ from each other, else it blocks. Candidate nondeterministic, baseline stable: blocks. Both: blocks unless listed. A cell listed with `"mode": "set-equal"` (a `reason` is mandatory) is judged on picture sets instead: fail on a crash, a blank picture or a candidate picture the baseline never gave; inconclusive under 3 runs a side; pass when every candidate picture was seen on the baseline (a baseline picture the candidate did not sample is sampling, not a regression). A cell listed with `"mode": "report-only"` (a `reason` is mandatory) gets the verdict it would have had unlisted, shown as `report-only (would be …)`, never blocking; its other checks (crash, errors, coreFreeze, render, audio, perf) still block |

Each check of each run is pass, fail or **unjudged** (with the reason: no VI
timeline in this core, capture refused for a hardware renderer, scripted
inputs without a savestate, …). Machine load changes none of them.

**Expected failures.** A test added before its implementation fails on main
by design. List it in `harness/known-failures.json` with `"mode":
"expected-fail"`, its `cell` (`game/config`), `check` (crash, errors,
coreFreeze, render or audio), `reason`, `until` (the follow-up that fixes it)
and `detail`, a regular expression the failure's detail must match (how it is
expected to fail). That failure is **XFAIL**, shown with the reason and never
blocking; any other failure of the cell, and a blank picture always, stays a
regression. A pass is **XPASS** and blocks, so the PR that fixes it also
removes the entry. An entry for a game the run has but a cell it does not is
stale and blocks; other matrices do not judge it.

The list is read from the candidate's tree, so a PR can break a check and
declare it expected-fail in the same change. The gate therefore marks every
XFAIL whose baseline passes the check (a new entry, or a feature main cannot
exercise) with a warning (⚠): the reviewer must find its justification in
the PR.

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
| `cpufuzz-nomcrf` | the same without `mcrf`, which once crashed the JIT (cpufuzz with it now matches the interpreter: `fuzz`, 2026-10-24) |
| `tonetest` | a continuous 440 Hz tone through the audio DMA, for the audio check |
| `gxscene-nocubes`, `gxscene-color` | selftest mutants of `gxscene` (`-DMUTATE_NO_CUBES`, `-DMUTATE_COLOR`) |

Homebrews draw their results as **marker rows** in the XFB
(`homebrew/common/marker.h`, decoded by `lib/markers.mjs`): four rows of 32
bits plus a checksum row, read from exact captures only. Rows whose checksum
does not match are unreadable; nothing is decided from colours.
Build cpufuzz with `-DONLY_PROGRAM=n` to run a single program while reducing a
finding; `out/cpufuzz*.symbols.json` maps a PC back to a program.

**FIFO logs.** `probes/fifo-record.mjs --iso homebrew/out/<name>.iso --port N`
boots one of our homebrews on the software renderer (cpu=single) and has the
core's FifoRecorder save the next frames as `homebrew/out/<name>.dff`
(FifoPlayer's format). With `?fifolog=1` (harness only: the app neither
offers nor boots a `.dff` otherwise) a log boots like a disc, and
`matrices/fifo-homebrew.json` replays the logs on each backend against the
exact software reference (`fastsw=0`): the same GPU commands, without the
homebrew's CPU side, so wgpu is compared with the software rasterizer at
SSIM ≥ 0.99 (the matrix's `renderMatch`; 0.9 by default).
Seven logs: gxscene and gxscene-nocubes, dstalpha, dstalpha-coplanar,
dstalpha-redraw, efbpeek and ramcopy. Not dstalpha-zinit: its one depth
clear to 0 happens before the recorded frames, so a replay starts from the
EFB's undefined initial depth (0 in software, far on GPU backends) and the
two references legitimately differ.
**Missing WebGPU features.** `?wgpumask=a,b` (harness only) creates the
WebGPU device without those optional features, as a browser that lacks them
would: Safari 26 has no `dual-source-blending` (Dolphin then takes its
`no_dual_src` path) and no WGSL `clip_distances`.
`matrices/wgpu-features.json` runs wgpu with and without them against the
exact software reference (`fastsw=0`, `cpu=single`, SSIM ≥ 0.99), on
`homebrew/dstalpha` (source-alpha blending while the destination alpha is a
constant: the dual-source case), the gxscene FIFO log, efbpeek and ramcopy.

**Chrome's Windows shader path, offline.** `probes/wgsl-corpus.mjs` boots a
disc on `video=wgpu` (savestate and steps optional) and writes the WGSL of
every shader module the replay created, one file per hash (harness request
`validationWgslCorpus`). `tools/wgsl-hlsl-corpus.mjs` then runs each module
through Tint to HLSL and DXC, with the Tint and DXC of the Dawn branch the
installed Chrome ships (`dawn chromium/<build>`, `DAWN_USE_BUILT_DXC`),
and reports failures and per-module times. A local disc's corpus stays
outside the repo. FXC (`d3dcompiler_47`) is Windows-only and not covered.

Record them after `homebrew/build.sh`. Only our homebrews are recorded; no
third-party FIFO logs (they contain game content).

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

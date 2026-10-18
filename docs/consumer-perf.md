# Race speed on a consumer machine (P9)

One command measures the local race on any machine (Windows, Linux, macOS)
in headless Chrome stable and writes a report: emulated speed, game frame
rate, VI and present p99, hitches per minute, busiest thread, and the WebGPU
adapter Chrome found. It drives the same harness as on the development Mac
(`harness/probes/race-perf.mjs`).

## What the machine needs

- Node ≥ 22, git, Google Chrome stable (the `chrome` channel Playwright
  launches), and Playwright: `npm i -g @playwright/cli`, or set
  `PLAYWRIGHT_MODULE` to a Playwright `index.mjs`.
- A checkout of the fork at the commit to measure (`git clone`, then
  `git checkout <sha>`). The core is committed under `cores/dolphin/`: no build.
- The disc, **already on that machine**, put there by the operator. The
  harness reads it in place. It never copies, uploads or commits it, and never
  runs it in CI (PROGRAM.md). The savestate the script makes contains game
  memory: it is written to a fresh temporary directory and deleted at the end.
- Nothing else running: the run waits for the 1-minute load average to drop
  under a quarter of the cores. Windows has no load average: there the guard
  is inactive, the report says so and gives the CPU busy measured before each
  backend; keep the machine idle.

## Run it

Over SSH or at the machine, from the checkout:

```sh
node harness/probes/consumer-perf.mjs --iso /path/to/disc.iso --label <machine>
```

```powershell
node harness\probes\consumer-perf.mjs --iso C:\path\to\disc.iso --label <machine>
```

- `--backend auto` (default) runs the WebGPU renderer when Chrome has a real,
  non-fallback adapter with the features it needs (`clip-distances`,
  `depth-clip-control`, `dual-source-blending`), the software renderer
  otherwise. `both`, `wgpu` and `soft` force the choice.
- The steps into the race (`harness/probes/local-race-steps.json`) are timed
  in emulated frames, not host seconds: a slower machine reaches the same
  scene, later.
- Before measuring a backend, a renderer check loads the state and captures
  an exact frame 3 s later: a blank picture or the wrong capture source means
  no numbers for that backend. The capture, `<backend>-check.png`, stays with
  the local results: look at it, it must show the race.
- `--runs 4 --warmup 25 --secs 20` (defaults): each run boots, loads the
  race, holds the accelerator, waits 25 s and measures 20 s, then reboots in
  the same profile and measures again (warm JIT and shader caches).
- Ctrl-C or a closed SSH session stops the runs and deletes the savestate and
  the Chrome profiles.
- The perf lock: on macOS the shared one of the development Mac
  (`~/projects/gc-web-emu/.perf-lock`, PROGRAM.md), a private one elsewhere;
  `--private-lock` / `--shared-lock` override.
- About 25 minutes for one backend at the defaults, 45 for `both`.
- Results go to `../measures/harness/consumer-<label>-<date>/` (or `--out`):
  `report.md`, `report.json` (adapter features, presenter, Chrome flags,
  load), the renderer-check captures, and race-perf's per-run JSON per backend.

## Machine-specific notes

- **Linux.** Headless Chrome needs access to the GPU (`/dev/dri`, user in the
  `video`/`render` groups). If the adapter comes out as fallback or missing,
  try `HARNESS_CHROME_ARGS="--enable-features=Vulkan --use-angle=vulkan"`.
  Per-thread CPU comes from `/proc/<pid>/task` over 500 ms.
- **Windows.** An SSH session (OpenSSH runs as a service) may not see the
  GPU: if `report.md` shows a fallback or missing adapter, run the same
  command from the logged-in user's session. There is no per-thread CPU on
  Windows (`n/a`).
- **macOS.** Per-thread CPU from `ps -M`. The harness also checks that no
  Chrome window ever appears.

## Reading the report

- **Speed** is the core's own: emulated ticks over host time from the VI
  timeline. 100 % means full speed.
- **Game fps** is what the game renders (visual changes). A slow renderer
  makes the game drop frames while the speed stays at 100 %. The software
  renderer shows exactly that, about 14 fps in the race. Read the two
  together; hitches per minute (present gaps over two 60 Hz frames) follow
  the game's frame rate.
- **Busiest thread** near 100 % means the emulated CPU thread is saturated.
- Write the result up in `docs/perf-results/consumer-<machine>.md`: the
  `report.md` table, the commit, and anything unusual (load, throttling,
  power plan, laptop on battery).

Check the script on the development Mac first, headless, in a CORRECTION
slot with a private lock (the shared one is for MEASURE slots):
`--backend both --runs 2 --max-load 100 --private-lock`.

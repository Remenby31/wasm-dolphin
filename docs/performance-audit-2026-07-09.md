# Performance audit — 2026-07-09

## Outcome

The current lack of smoothness is a combination, not one global FPS problem.

On the recommended software-hybrid path, this audit found no material
throughput-class separation between the three browser presenters in two trials
per backend. That is medium-confidence evidence, not a GPU-completion profile:
the current timers cover JavaScript submission work but not asynchronous
browser/GPU completion. The strongest measured limitation is the cadence at
which the software GPU produces distinct XFB content. In the fixed
reference battle, the balanced `fastsw=1` path reached 95.4–96.6% game
speed with the JIT disabled and about 57.4–57.8 source/XFB callbacks per second,
but only 10.7 distinct visual frames per second. The sampled WebGPU-presenter
JavaScript work was about 0.18–0.21 ms per presentation, and changing only the
presenter to WebGL or 2D did not materially change the performance class.

`fastsw=2` did increase distinct cadence to 17.3–20.6 FPS, but it also reduced
game speed to 63.6–66.1% in the same no-JIT scene. That tradeoff reproduced in
balanced order and therefore is not a safe “faster” default. It needs
GPU-thread/raster/backlog instrumentation before optimization.

The true hardware renderer, `video=wgpu`, is not currently a playable
alternative. A correctly routed smoke test registered the WebGPU command ring
and processed draw commands, but displayed the built-in color test pattern
rather than the game. Real XFB nonzero count, presentation FPS, visual FPS, and
audio output remained zero.

No emulator, renderer, JIT, or pacing default was changed by this audit.
Instrumentation and validation packaging were changed on
`perf/instrumentation-baseline`.

## Measurement semantics

- **Game speed** is derived from emulated core ticks and is the best current
  measure of emulation progress.
- The existing UI field named **Core FPS** is actually source/XFB callback
  cadence (`api.getFrame()` increments in the XFB callback). This report calls
  it **source/XFB FPS**. It is not an independent CPU-throughput metric.
- **Presentation FPS** counts recorded fresh-frame presentation events. In
  `pacing=tick`, duplicate tick repaints are not all counted, so this is not a
  literal monitor refresh rate.
- **Unique/visual FPS** is sampled XFB/canvas hash change cadence. It answers
  whether the image changed, not whether every pixel is correct.
- XFB callback interval is a period, not render duration. Current `swxfb`,
  `conv`, and `copy` values are the most recent encode sample, not an average.
- The CSV/result-sheet **p95 interval** is from only the final 500 ms worker
  window. **Lifetime max interval** covers the whole run and can precede the
  post-JIT or post-warmup averaging window. Neither should be read as the
  interval distribution of the selected average window.

These limitations are why the audit uses multiple signals and repeated A/B
runs rather than treating one counter as ground truth.

## Test record

| Field | Value |
| --- | --- |
| Machine | AMD Ryzen 9 9950X3D, 32 logical CPUs, 128 GB RAM, win32 / NT 10.0.26200 |
| Display adapters present | AMD Radeon RX 9070 XT, AMD Radeon Graphics, Parsec Virtual Display Adapter |
| Selected Chrome GPU adapter | Not captured; do not infer it from the adapters present |
| Browser | Headed Chrome 143.0.7499.4 |
| Base commit | `origin/main` at `a0d97ffb5e0318e56b3601926900531b6d233c68` |
| Timed-run harness commit | `4f60ddcbff3dce8ee5271623b6b078dacadc5cf6` |
| Later presenter/WGPU harness commit | `562a7a031213ac1042a161b010a4544254455009` |
| Core artifact | 12,800,707 bytes, SHA-256 `03df79d2eb4be6c1e05d58d79ad4ab9590a9407c19fa5ae70e088401f424af3f` |
| Game | Reference fighting game, NTSC-U Rev 2 NKit ISO, SHA-256 `<reference disc SHA-256, not tracked>` |
| Scene | Direct load into visually confirmed reference battle |
| Save state | 21,170,115 bytes, SHA-256 `<reference savestate SHA-256, not tracked>` |
| Input | None after load; SHA-256 of script is the empty-input hash `e3b0c442…b855` |
| Screenshots during timed runs | Disabled |
| Timed windows | 45 s for JIT-on raster runs; 30 s for no-JIT and presenter controls |

Representative exact URL:

```text
http://127.0.0.1:8083/?core=upstream&video=software&cpu=dual&speed=1&presenter=webgpu&pacing=tick&jittier=guarded&present=full&wasmjit=0&queue=4&jitwarmup=700&oc=1&fastsw=1&metrics=1&probe=menu-progress-1783639185868
```

Representative command:

```powershell
$env:ROM = "<path to the reference disc image>"
$env:BASE_URL = "http://127.0.0.1:8083/"
$env:BROWSER_CHANNEL = "chrome"
$env:HEADED = "1"
$env:VIDEO = "software"
$env:PRESENTER = "webgpu"
$env:CPU = "dual"
$env:SPEED = "1"
$env:WASMJIT = "0"
$env:JITWARMUP = "700"
$env:OC = "1"
$env:PACING = "tick"
$env:FASTSW = "1"
$env:DURATION = "30"
$env:CAPTURE_SCREENSHOTS = "0"
$env:SHOW_DEBUG_PANEL = "0"
$env:HASH_ROM = "1"
$env:SAVE_STATE_URL = "/__battle.sav"
$env:SAVE_STATE_PATH = (Resolve-Path ".\__battle.sav").Path
$env:SAVE_STATE_AT = "0"
$env:INPUT_SCRIPT = "none"
$env:SCENE_LABEL = "fixed-save-nojit-fastsw-1-trial-1"
node tools/menu-progress-validate.mjs --out-dir .omx/perf-audit/fixed-battle-nojit/fastsw-1-trial-1
```

### Executed matrix

All fixed-battle rows used the common environment above. The exact overrides
and execution order were:

| Group | Overrides and order | Output |
| --- | --- | --- |
| Guarded JIT raster | `WASMJIT=1`, `DURATION=45`; `FASTSW=1,2,3,3,2,1` | `.omx/perf-audit/fixed-battle-fastsw/fastsw-<mode>-trial-<1..6>` |
| No-JIT raster | `WASMJIT=0`, `DURATION=30`; `FASTSW=1,2,2,1` | `.omx/perf-audit/fixed-battle-nojit/fastsw-<mode>-trial-<1..4>` |
| WebGPU presenter control | The two no-JIT `fastsw=2` rows above | No-JIT raster outputs, trials 2 and 3 |
| WebGL presenter control | `WASMJIT=0`, `FASTSW=2`, `PRESENTER=webgl`, `DURATION=30`; two runs | `.omx/perf-audit/fixed-battle-presenters/webgl-trial-1` and `fixed-battle-presenters-v2/webgl-trial-2` |
| 2D presenter control | Same, with `PRESENTER=2d`; one pre-fix load attempt failed, followed by two valid runs | `.omx/perf-audit/fixed-battle-presenters-v2/2d-trial-1` and `2d-trial-3` |
| Hardware-WGPU classifier | `VIDEO=wgpu`, `PRESENTER=webgpu`, `WASMJIT=0`, `DURATION=20`, no save state; one diagnostic run | `.omx/perf-audit/wgpu-route-smoke` |

Requested or suggested arms **not run in this audit**:

| Arm | Status |
| --- | --- |
| `regalloc=0` | Wrapper corrected so a future run really passes 0; no current benchmark |
| `smearcompile=0` | Wrapper corrected so a future run really passes 0; no current benchmark |
| `wasmjit=2` / mixed tier | Not run; correctness-sensitive |
| `forcejit=1` | Not run; fuse bypass would change the safety comparison |
| `fastsw=0` | Not run; full-resolution baseline remains an evidence gap |
| No-JIT `fastsw=3` | Not run |
| Repeated `video=wgpu` performance trials | Not run; current output was not a real game frame |

Raw local artifacts contain `run-metadata.json`, `summary.json`,
`samples.json`, and `samples.csv` under:

- `.omx/perf-audit/fixed-battle-fastsw/`
- `.omx/perf-audit/fixed-battle-nojit/`
- `.omx/perf-audit/fixed-battle-presenters/`
- `.omx/perf-audit/fixed-battle-presenters-v2/`
- `.omx/perf-audit/wgpu-route-smoke/`

Raw `.omx` output is intentionally ignored because it includes large console
and browser-trace artifacts.

## Measured results

### Fixed battle, WebGPU presenter, JIT disabled

Each range contains two balanced-order runs. “Source” means XFB callback
cadence, not CPU FPS.

| Mode | Game speed % | Source/XFB FPS | Presentation FPS | Unique/visual FPS | Last XFB encode | Average XFB decode |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `fastsw=1` | 95.36–96.64 | 57.40–57.80 | 47.32–47.84 | 10.68–10.72 | 1.1–1.2 ms | 1.9 ms |
| `fastsw=2` | 63.60–66.08 | 38.40–39.64 | 35.28–40.36 | 17.32–20.64 | 0.5 ms | 1.5–2.0 ms |

This isolates the `fastsw=2` slowdown from the PPC-to-WASM JIT. It also shows
that lower XFB encode time does not imply higher game speed.

### Fixed battle, WebGPU presenter, guarded JIT

| Mode | Trials | Game speed % | Source/XFB FPS | Presentation FPS | Unique/visual FPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| `fastsw=1` | 2 | 89.71–93.58 | 53.79–56.32 | 45.53–45.82 | 10.68–10.82 |
| `fastsw=2` | 2 | 54.91–55.00 | 32.88–32.97 | 31.28–32.42 | 17.94–18.15 |
| `fastsw=3` | 2 | 53.94–80.46 | 32.44–48.35 | 32.47–48.19 | 17.59–24.41 |

Two aggressive-mode runs tripped the JIT presentation-regression fuse late in
the run. However, their slowdown began before JIT engagement, and the no-JIT
control reproduced the `fastsw=2` split. JIT/fuse behavior amplifies some runs
but is not the sole cause.

Cold ephemeral-browser `wasmjit=1` was not faster than `wasmjit=0` in this
scene. That does not disprove warm persistent-cache wins; it shows that “JIT
enabled” is not itself a performance result.

### Presenter control, no JIT, `fastsw=2`

| Presenter | Trials | Game speed % | Source/XFB FPS | Presentation FPS | Unique/visual FPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| WebGPU | 2 | 63.60–66.08 | 38.40–39.64 | 35.28–40.36 | 17.32–20.64 |
| WebGL | 2 | 60.64–65.72 | 36.64–39.76 | 36.24–37.28 | 18.08–18.20 |
| 2D canvas | 2 | 62.24–69.32 | 37.92–41.92 | 37.20–38.72 | 17.76–18.60 |

The ranges overlap. Final sampled JS draw/present work was 0.11–0.21 ms for
these fallback runs. Within two trials per backend, there was no observed
material throughput-class difference. Asynchronous GPU completion is not
timed, so this does not prove the browser presenter is free or non-dominant in
every scene.

### Audio and input

Software-path runs produced non-silent audio in 95.07–99.49% of 250 ms analyzer
samples. That is evidence of audio presence, not a proof of zero underruns.
The audio controller intentionally schedules about 120 ms ahead
([`src/audio.js`](../src/audio.js#L10)), so audio can sound robust while still
contributing noticeable latency.

No gameplay input was sent in the fixed-state runs. The input Event Timing
metric therefore cannot establish input-to-photon latency. Static inspection
found a 2 ms main-thread gamepad poll that allocates arrays and updates control
DOM even when state is unchanged ([`src/app.js`](../src/app.js#L819)). The
measured presentation queue age reached 0–52 ms across final samples, which is
an additional latency component, not a complete input-to-photon measurement.

### True hardware WebGPU classifier

The diagnostic used the required route:

```text
?core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=0&pacing=tick&metrics=1
```

Observed:

- route marker: `webgpu-cmd-ring: registered`;
- command stats: about 148,000 draws, 81 pipeline misses, 2,319 bind misses;
- game speed: 100.65% over the short post-warmup window;
- presentation FPS: 0;
- unique/visual FPS: 0;
- real XFB nonzero count: 0;
- audio active samples: 0;
- canvas: built-in color test pattern, not the game.

This proves route and command production, not a valid Dolphin draw/present
pipeline. It is a classifier run, not a performance benchmark.

## Bottleneck classification

| Bottleneck candidate | Evidence | Confidence | Next action |
| --- | --- | --- | --- |
| CPU/game speed | `fastsw=1`, no JIT reached 95.4–96.6%; aggressive modes fell to 63.6–66.1% even before JIT. CPU throughput is scene/path dependent, not a universal ceiling. | Medium | Add GPU lag and host-work attribution; repeat with persistent warm cache and `speed=unlimited`. |
| Software raster/XFB | Near-target game speed and ~58 source callbacks produced only ~10.7 unique FPS. Aggressive raster raised unique cadence. XFB encode/decode were only about 0.5–2.0 ms, so the unmeasured raster/TEV/backlog portion is the leading candidate. | High for the area; medium for the exact subphase | Time raster, block setup, TEV, texture samples, fast-fill, XFB generation, and GPU FIFO lag separately. |
| Presentation/canvas | WebGPU, WebGL, and 2D controls overlap in two trials each; sampled JS presentation was 0.11–0.23 ms. Final-500-ms p95 values were usually ~17–18 ms, but asynchronous GPU completion was not timed. | Medium; no material backend separation observed | Add browser GPU timing and repeat more trials before ruling the presenter out. |
| WebGPU hardware renderer | Correct route and large draw count, but only test pattern; XFB/presentation/visual/audio all zero. Historical runs also show shader failures and GPU-dependent behavior. | High that it is unusable; low/medium on one root cause | Implement clear → triangle → checker → translated shader → first Dolphin draw classifier. |
| JS worker/message/copy | Software presenter copies were around 0.5 ms and draw/present under 0.25 ms. Remaining avoidable work includes unconditional metrics serialization, 2 ms gamepad polling, redundant one-way acknowledgements, and unmeasured WGPU ring drain. | Medium | Gate metrics, count messages/bytes, profile gamepad polling, and include WGPU drain time. |
| Audio | Non-silent in 95–99% of software samples; no evidence that it limits game speed. Main-thread timer starvation and the deliberate 120 ms lead can affect feel. | Medium | Record underrun/overrun, pump-gap, mix-latency, and audio-to-video drift in every headed run. |
| Input latency | No post-load inputs were sent. Static path polls every 2 ms and the presentation queue can add tens of milliseconds. | Low | Add scripted timestamped input with an in-game visual response marker; measure handler and input-to-visible-frame separately. |
| Build flags | Release build already requests `-O3`, pthreads, SIMD, and LTO. The artifact cannot be reproduced from committed source because upstream is unpinned and patches are incomplete. | High on reproducibility; low on flag performance | Pin upstream, commit the full patch chain, emit `build-info.json`, then A/B one flag at a time. |

## Root-cause evidence from code

### Software GPU and XFB

Current committed instrumentation times XFB callback/decode and the last
software XFB encode in
[`core/upstream/dolphin_web_discio.cpp`](../core/upstream/dolphin_web_discio.cpp#L244),
but it does not time software raster, TEV, texture sampling, fast-fill, or GPU
backlog.

The ignored local `vendor/dolphin` tree shows that normal dual-core
`SyncGPU()` can return without fully catching up the GPU thread. The CPU can
therefore publish at VI cadence while reusing stale XFB content. That source is
not committed and must be turned into an ordered patch before it can be treated
as reproducible source evidence.

The ignored local raster implementation also corrects current documentation:

- `fastsw=0`: literal full-resolution upstream software raster;
- `fastsw=1`: one shaded sample per 2×2 cell plus replication;
- `fastsw=2/3`: one shaded sample per 4×4 cell plus replication;
- mode 2 duplicates skipped XFB rows;
- mode 3 interpolates skipped XFB rows.

Thus `fastsw=1` is the balanced/crisp recommended fast mode, not literal
full-quality rasterization.

### JIT

Historical local artifacts show high block reuse—roughly 11,500–26,000 runs per
compiled block in sampled runs. Within those unprovenanced runs, low
steady-state reuse was not the observed problem. Synchronous cold compilation
can still create transition hitches.

Historical, unprovenanced A/B data is not sufficient to validate any JIT
default. This audit preserved the existing defaults pending a
provenance-correct A/B. It fixed wrappers that previously claimed
`regalloc=0` or `smearcompile=0` without actually passing the default-on
flags, but it did **not** run either arm. No correctness-sensitive JIT default
was changed.

The persistent JIT cache uses a 32-bit key in the ignored local source. A prior
collision caused wrong-module execution. At up to 49,152 cached entries in a
2^32 key space, birthday-collision risk is non-trivial. Do not expand or ship a
prebuilt cache until it uses a wider key plus a secondary signature.

### JavaScript host

- [`src/app.js`](../src/app.js#L819) polls gamepads every 2 ms, creates filtered
  arrays, derives input, merges sets, and updates control DOM.
- Opening the debug panel starts a synchronous canvas snapshot and PNG download
  every three seconds ([`src/app.js`](../src/app.js#L490)); timed runs now keep
  it closed and read structured telemetry.
- [`src/upstream-discio-worker.js`](../src/upstream-discio-worker.js#L1128)
  serializes detailed helper/profile/video stats for every telemetry response.
  `metrics=1` is passed by the host but the worker does not currently use it as
  a collection gate.
- One-way input/audio messages still receive `{id: undefined}` acknowledgements
  from [`postResult`](../src/upstream-discio-worker.js#L2790), which the adapter
  discards.

### WGPU executor

[`runPresentationLoop`](../src/upstream-discio-worker.js#L1431) drains the WGPU
command ring before starting its loop timer and before pumping host jobs. Drain
time is invisible in current profiles, and the drain consumes the full
snapshot with no time/command budget.

The consumer can snapshot in the middle of a render pass, the 32 MiB upload
arena can wrap without consumer synchronization, arbitrary mip uploads can
target one-mip textures, and important submit/device errors are swallowed.
These are correctness risks; instrumentation must classify them before a
renderer rewrite.

### Build

- [`tools/fetch-dolphin.mjs`](../tools/fetch-dolphin.mjs#L23) fetches moving
  upstream `master`.
- [`tools/patch-upstream-wasm.mjs`](../tools/patch-upstream-wasm.mjs#L7)
  applies only `0001`–`0009`.
- The committed patch links 1 GiB/16,384 WASM pages, while the tracked wrapper
  and generated core expect 1.5 GiB/24,576 pages.
- JIT disable masks, later raster modes, cache work, and C++ WebGPU/Naga
  integration exist only in the ignored vendor tree or baked artifact.
- Existing flags already include `-O3 -pthread -msimd128 -flto`
  ([`tools/configure-upstream-wasm.mjs`](../tools/configure-upstream-wasm.mjs#L48)).

A clean rebuild is not a valid A/B arm until the source/patch provenance is
repaired.

## Ranked optimization backlog

Risk uses the requested definitions: Low is instrumentation/docs only, Medium
is a local reversible refactor with clear tests, and High is
correctness-sensitive emulator/rendering/JIT work.

| Rank | Optimization/refactor | Area | Risk | Expected gain | Measurement method |
| ---: | --- | --- | --- | --- | --- |
| 1 | Pin Dolphin SHA, commit the complete patch chain, and emit `build-info.json` | Build/repro | Medium | No direct FPS; makes every later claim valid | Clean clone applies patches, builds, and records source/tool/artifact hashes |
| 2 | Add structured raster/TEV/fast-fill/XFB-generation/GPU-lag timing | Software GPU | Low | Classification, not speed | Fixed-state randomized runs; phase sums and GPU generation lag |
| 3 | Add WGPU drain/error/batch/upload telemetry and the five-stage classifier | Hardware WGPU | Low | Classification; removes blind debugging | Clear, triangle, checker, translated shader, first draw with matched EFB/XFB/canvas hashes |
| 4 | Wire `metrics` through and skip detailed serialization/counters when off | JS/JIT observer | Medium | Unknown CPU/interval gain; removes observer effect | Same-state `metrics=0/1`, message bytes, stats-call time, core ticks, p95 |
| 5 | Split `fastsw` raster decimation from XFB encoding/reconstruction | Software GPU | High | Attribution; enables safe per-stage tuning | 0/0, 1/0, 0/1, 1/1, 2/2, 2/3 matrix with image hashes |
| 6 | Traverse only selected sample cells and avoid unused block construction in fast raster modes | Raster/TEV | High | Potential unique-FPS gain without additional selected-mode quality loss | GPU-thread phase time plus EFB/XFB hash parity |
| 7 | Reuse identical source rows in mode-1 XFB encode | XFB | Medium | Bounded by current ~1.1 ms encode; likely sub-ms | Byte-for-byte encoded XFB tests and encode sum/count/max |
| 8 | Add same-size paired-pixel/SIMD XFB decode path | XFB decode | Medium | Bounded by current ~1.5–2.0 ms average | Exhaustive scalar/SIMD output equality and callback timing |
| 9 | Early-out unchanged gamepad state and suppress discarded one-way worker replies | JS/input | Medium | Lower main-thread/message overhead; latency stability | Message count/bytes, LoAF, input handler p95, input-to-visible marker |
| 10 | Replace 32-bit JIT cache key with wider key and secondary verification | JIT correctness/cache | High | Safely enables larger/warm caches; fewer cold hitches | Collision injection, cache hit parity, state/screenshot hashes |
| 11 | Package a matching prebuilt JIT cache after key safety | JIT cold start | Medium | Fewer first-encounter compile bursts; no steady raster gain | Cold IDB, warm IDB, prebuilt cache; compile/instantiate time and memory |
| 12 | Make WGPU batches atomic and synchronize upload-arena lifetime | Hardware WGPU | High | Correct first Dolphin draws; possible large gain only after correctness | Batch sequence IDs, overwrite counters, GPU error scopes, first-draw ladder |

Do not default-enable `blockmerge`, `shortprefix`, `fastmemhoist`, mixed JIT,
fast math, smaller pthread pools, or new raster approximations from static
analysis.

## Immediate implementation plan

### Today: instrumentation and baseline runs

- Land the provenance/raw JSON/CSV changes and this audit.
- Keep the direct reference-battle save load; do not automate character
  selection for timed runs.
- Add the missing raster/TEV/GPU-generation counters and WGPU ring-drain timing.
- Repeat at least five trials per condition in randomized or Latin-square
  order. Control persistent JIT cache state explicitly.

### Next: low-risk wins

- Pin upstream and extract every ignored vendor delta into ordered patches.
- Wire the metrics flag and measure observer overhead.
- Early-out unchanged gamepad/UI work and eliminate discarded one-way replies
  on a separate behavior branch.
- Implement byte-identical XFB row reuse and identity-dimension decode fast
  paths, each behind an escape hatch until parity is proven.

### Then: high-impact renderer/JIT work

- Use phase timing to decide between raster traversal specialization and TEV
  state predecode.
- Harden the JIT cache key, then validate warm/prebuilt cache behavior.
- Build the WGPU first-draw classifier; only after it identifies the failing
  boundary should batch/upload/pipeline state be changed.

## Concrete code changes

| File and function/module | Exact problem | Proposed change | How to test | Rollback |
| --- | --- | --- | --- | --- |
| `tools/fetch-dolphin.mjs`; `tools/patch-upstream-wasm.mjs` | Moving upstream and incomplete patch list make core rebuilds non-comparable | Add a committed upstream SHA/patch manifest and assert clean apply | Fresh clone, `rev-parse`, `git diff --check`, full build hash | Restore old fetch path; keep last known core artifact |
| `core/upstream/dolphin_web_discio.cpp::DecodeXfbToPresentationBuffer` | Generic per-pixel scaling math is used for the common 640×480 identity case | Add a YUYV-pair identity loop, then optional WASM SIMD | Golden scalar/SIMD RGBA buffers over edge values and dimensions | Query/compile-time switch to generic loop |
| patched `Software/Rasterizer.cpp::Draw` and block traversal | Fast modes still build/traverse blocks whose pixels immediately return; raster/TEV time is unknown | Instrument first; then add selected-cell traversal/`BuildFastBlock` | Deterministic EFB/XFB hashes, GPU timings, gameplay state hashes | Runtime escape hatch to current traversal |
| patched `Software/SWEfbInterface.cpp::FastEncodeXFB` | Mode 1 recomputes rows that snap to the same source row | Copy the already encoded row when `src_y` repeats | Byte-identical encoded XFB across widths/scales; encode timing | Disable fast-row reuse |
| `src/upstream-discio-worker.js::framePayload` | `metrics` is ignored and expensive strings are serialized on every poll | Pass `collectMetrics`; return minimal counters when false | `metrics=0/1` A/B and metrics-on field parity | Always collect as today |
| `src/upstream-discio-worker.js::runPresentationLoop` / `drainWebGpuCmdRing` | Drain time is excluded and unbounded | Record drain duration/count/backlog/high-water and host-pump delay; add diagnostic budget only after measurement | WGPU classifier plus core/audio progress under backlog | Disable budget and retain counters |
| `src/upstream-discio-worker.js` WGPU setup/executor | Device/submit errors and stage boundaries are not observable | Add uncaptured errors and query-gated clear/triangle/checker/translated/first-draw stages | Each stage must record submit and matched readback/hash | Query gate leaves defaults unchanged |
| `src/app.js::wireGamepadPolling` | 500 Hz polling allocates and updates DOM when input is unchanged | Reuse selection storage and call `syncInput` only on quantized state/device changes | Gamepad regression tests, hotplug, analog sweeps, latency A/B | `?legacygamepadpoll=1` or revert local change |
| worker message handler / `postResult` | One-way `post()` calls generate replies with no pending request | Reply only when `id` is present; surface one-way errors as status | Mock-worker unit test and input-message count | Restore unconditional acknowledgement |
| patched `CachedInterpreter.cpp` cache | 32-bit-only module identity can collide | Dual hash or 64-bit key, byte length/signature, collision counter | Inject primary collision and prove rejection; state/hash parity | `nojitcache=1` |
| `src/audio.js::pump` | 15 ms main-thread timer and 120 ms lead trade robustness for latency; main-thread starvation remains possible | First make pump gap/mix latency/audio drift part of the result schema; consider AudioWorklet/SAB only after evidence | Headed audio underrun, drift, and input-to-audio latency tests | Current timer pump remains fallback |

The two XFB candidates are wired default-off for measurement. Use
`xfbfast=rows` (or `1`) for encoded-row reuse, `xfbfast=decode` (or `2`) for
the even-width identity decoder, and `xfbfast=both` (or `3`) for both. Omit the
parameter or use `xfbfast=0` for the exact pre-change paths. Video stats expose
`xfbfast`, `rowreuse`, and `identitydecode` so a run can prove which code
executed. No performance gain is claimed until repeated headed fixed-battle
A/B runs qualify it.

## Validation status

- `node --test tests/perf-artifacts.test.mjs`: 3/3 passed.
- `npm run check`: passed after the final source and documentation edits.
- `npm test`: 31 passed, 2 failed, 2 skipped. Both failures reproduce on clean
  `origin/main` and are existing gamepad expectation failures:
  `gamepad buttons and axes map into pressed controls` and
  `gamepad input exposes analog GameCube pad state`.
- `npm run perf:gate`: invoked, but exited before running because its
  hard-coded default ISO path was absent. The older gate also drives menus
  instead of using the fixed battle state, so no perf-gate result is claimed.
- Headed Chrome: six JIT-on fixed-battle raster runs, four no-JIT raster runs,
  six successful presenter controls across the three backends, one diagnosed
  pre-fix 2D state-load failure, and one WGPU classifier.
- No `.wasm`, generated core, emulator runtime algorithm, JIT default, renderer
  default, or pacing default was changed.

## Remaining uncertainty

The exact software-GPU subphase is still not measured. The current evidence
supports “software raster/TEV/GPU backlog limits distinct frames,” but not a
claim that TEV, block setup, texture sampling, fast-fill, or XFB generation is
individually dominant.

The timed runs are cold ephemeral browser contexts. They do not represent a
warm persistent JIT cache. The WGPU adapter selected by Chrome was not captured.
The save state and baked core are locally usable but the committed source cannot
currently recreate that core. Those are the next evidence gaps to close.

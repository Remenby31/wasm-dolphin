# Browser performance audit — 2026-07-10

## Outcome

The browser does not have one universal FPS bottleneck. The measured fixed
reference battle separates into two materially different paths:

1. On the recommended software-hybrid path, emulation and presentation can
   stay near 60 Hz while the software raster/XFB source changes much less
   often. Distinct-frame production is the primary smoothness limit.
2. On the true hardware-WGPU path, an older zero-error 120-draw smoke produced
   182,949 nonzero EFB color bytes and the battle is now visibly rendered. The
   current first one-draw post-load pass is Dolphin's restore of all-zero saved
   EFB color/depth, so its zero readback is expected. The prior green/checker
   screen was caused by legacy software repaint paths overwriting the
   WGPU-owned canvas.
3. Hardware WGPU is still not full speed. The clean fixed-work UBO screen ran
   at about 49-52% throughput with diagnostics enabled. Each run issued
   594k-820k buffer uploads; upload replay consumed 4.47-5.28 seconds, and
   three runs timed out and aborted one pass. Per-call upload replay is now the
   primary measured hardware bottleneck.
4. The eight observed JIT emit failures were eight attempts at one opcode,
   `addzex`, disabled accidentally at compile time. Removing that diagnostic
   disable produced zero emit failures in the rebuilt diagnostic. A correlated
   57.590 ms tuple measured 57.235 ms of throttle, 0.255 ms of video, 0.009 ms
   of execution, and no compile or DVD time.
5. A generation-coded 32×32 marker now measures causal input-to-browser-canvas
   visibility. The latest six exact transitions averaged 36.798 ms and p95
   63.640 ms.
   This excludes compositor, scanout, panel, and photons. Audio had zero
   underruns in that retained software run.

No result in this report means that hardware WGPU is release-ready or that one
machine's game-speed figure generalizes. Raw paths, exact artifacts, rejected
runs, and attribution limits are retained alongside every claim.

## Five-priority follow-up tasklist

- [x] Validate nonzero raster traversal, TEV, texture, FIFO-age, XFB, source
  generation, and stale-reuse counters on the parity-built final core.
- [x] Establish nonzero WGPU EFB output in an older multi-draw smoke, classify
  the zero post-load restore, and remove the competing green/checker source.
- [x] Classify the eight JIT emit failures and long CPU slices.
- [x] Reduce WGPU replay backlog only after visible correctness was established.
- [x] Add GPU-completion and input-to-visible latency measurements.

All five priorities now have implementation and direct-save evidence. Patch
`0016` specializes only the two measured CMPR cases and passed 463,348 exact
production-decoder comparisons. Three headed pairs improved unique cadence by
7.16% descriptively, so it is provisionally retained rather than called a
qualified win. Atomic WGPU transactions are also retained; stable-state
suppression remains default-off after its six-run diagnostic.

The later first-pass root-cause analysis is in
[the WGPU post-load restore classification](perf-results/wgpu-post-load-restore-classification-2026-07-10.md).

In the final clean decision package, the 10-block TEV confirmation passed the
primary statistical test but remained non-promotable after four presentation-floor misses. Its WGPU UBO screen was
rejected and exposed real upload timeouts. Both optimization flags therefore
remain default-off.

## Test record

| Field | Value |
| --- | --- |
| Machine | Windows x64 `10.0.26200`; AMD Ryzen 9 9950X3D; 32 logical CPUs; 128 GiB RAM |
| Historical software evidence browser | Headed Chrome `149.0.7827.201` |
| Raster/JIT/marker/WGPU next-program browser | Headed Chrome `143.0.7499.4` |
| Final clean comparison browser | Headed Chrome `150.0.7871.114` |
| Final comparison commit | `db4da0743dc856955ed6b59a4f59618837b5f3f5`, clean |
| Historical next-program branch | `perf/next-program` |
| Final clean branch | `perf/final-optimization` |
| Upstream Dolphin | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |
| Scene | Direct-loaded fixed reference battle; no menu or character-select driving |
| ROM/save | SHA-256 not tracked (local reference config) |

Historical hardware evidence is in
[the WGPU replay and latency package](perf-results/wgpu-replay-and-latency-2026-07-10.md).

## Bottleneck classification

| Bottleneck candidate | Evidence | Confidence | Next action |
| --- | --- | --- | --- |
| CPU/game speed | The correlated worst tuple was 57.590 ms: throttle 57.235 ms, video 0.255 ms, execute 0.009 ms, compile/DVD 0, and 0.091 ms unattributed. Whole-run compile max was 0.744 ms; emit and compile failures were zero. | High that this long class is pacing wait rather than CPU/JIT saturation | Keep throttle and JIT safety defaults; capture a separate DVD-owned tuple before attributing 9–16 ms `FinishReadDVDThread` callbacks. |
| Software raster/XFB | The two dominant CMPR cases held 72.16–73.79% of sampled texture work. Their strict-parity specialization moved three-pair visual mean from 12.843 to 13.763 FPS and stale ratio from 80.057% to 77.614%. | High that source-frame pixel work is the default-path smoothness ceiling; medium on the provisional gain | Retain the exact-predicate CMPR path provisionally; specialize another case only after independent parity and repeated clean-tree A/B. |
| Presentation/canvas | Immediate tick delivery removed about 12.7 ms average queue age in the prior 24-run comparison. Software WebGPU submit/draw/hash work was sub-millisecond and sampled GPU completion was about 2.8–3.2 ms. Presentation remained near 60 while distinct frames remained low. | High that software presentation is not the current unique-frame ceiling | Keep immediate tick; preserve `legacytickqueue=1` rollback and GPU-completion sampling. |
| WebGPU hardware renderer | The battle renders and downstream XFB/backbuffer readbacks are nonzero. The clean UBO screen achieved only 49-52% fixed-work throughput with diagnostics; three of eight runs timed out and aborted a pass. | High on this AMD validation GPU; low for general GPU compatibility | Keep experimental; fix upload lifetime/call volume before another speed screen. |
| JS worker/message/copy | Each WGPU run replayed 594k-820k buffer uploads and 833-1,161 MiB per eight emulated seconds. Upload replay used 4.47-5.28 s versus 0.89-1.23 s for the measured payload copy; vertex/index uploads were 70-72% of calls. | High that per-call `queue.writeBuffer` pressure is the hardware-path ceiling | Build a default-off combined vertex/index streaming upload with explicit wrap/submit lifetime. |
| Audio | Sound is present. The retained hardware input/latency run had zero underruns; prior software runs also had zero underruns/overruns. Buffer lead is a latency tradeoff, not the measured throughput blocker. | High for retained runs | Keep buffering unchanged until a separate lead A/B preserves zero underruns. |
| Input latency | The 32×32 exact-generation marker passed 6/6 applied/polled/submitted/completed/browser-visible transitions. The latest input-event to browser-canvas result averaged 36.798 ms, p95 63.640 ms. | High for the instrumented browser-canvas boundary; low for physical display generalization | Use `INPUTMARKEROBSERVE=0` plus a camera/photodiode for compositor-to-photon measurement. |
| Build flags | Release configuration already uses `-O3`, pthreads, SIMD128, LTO, fixed shared memory, and no assertions/growth. Earlier independent builds matched. No build-flag A/B established a runtime win. | High on reproducibility; low that flags are the active bottleneck | Keep flags stable; only compare one content-addressed variant at a time after final parity. |

## Main measured results

| Evidence | Game speed % | Core FPS | Presentation FPS | Unique/visual FPS | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| Recommended path, prior strict JIT-on 60 s | 92.751 mean | 55.581 | 52.689 | 10.557 | Qualification failed its game-speed gate |
| Full software raster, prior four-run mean | 100.018 | 59.958 | 59.677 | 5.903 | Distinct-frame limited |
| Balanced software raster, prior four-run mean | 100.118 | 60.027 | 58.976 | 13.556 | Distinct-frame limited |
| WGPU pump off, two-run mean | 67.120 | — | 19.680 | Canvas changed in both runs | Backlog high-water 58,850.5 |
| WGPU pump on, two-run mean | 68.205 | — | 29.940 | Canvas changed in both runs | Backlog high-water 16,384 |
| WGPU latency diagnostic | 62.140 | 37.000 | 30.550 | 27 sampled canvas hashes | Diagnostics enabled; not a performance baseline |
| Software phase profile, metrics off mean | 99.903 | 59.960 | 59.020 | 12.783 | Three 20 s runs |
| Software phase profile, metrics on mean | 101.077 | 60.627 | 59.670 | 12.767 | Three 20 s runs; no slowdown resolved above variation |
| Promoted clean JIT-on gate, 20 s | 100.077 mean / 91.696 min | 59.993 | 59.333 | 14.095 | `FAIL`: minimum game speed below 95% |
| CMPR baseline, three-run mean | 100.610 | 60.353 | 59.333 | 12.843 | Dirty-tree diagnostic |
| CMPR candidate, three-run mean | 99.647 | 60.037 | 59.353 | 13.763 | +7.16% visual; provisional |
| Final atomic WGPU smoke | 69.180 | 41.760 | 35.880 | 21/21 changing hashes | Correctness pass, not full speed |
| WGPU cache off, three-run mean | 70.277 | 42.097 | 36.803 | 21/21 per run | 227,730 commands/s |
| WGPU cache on, three-run mean | 69.960 | 42.000 | 36.237 | 21/21 per run | 137,206 commands/s; remains off by default |
| Clean TEV confirmation, 10 blocks | 149.800 generic / 156.693 exact-case descriptive means | 89.760 / 93.942 | Variable, unlimited-speed workload | Not the primary metric | Median paired throughput effect +4.955%; statistical gate passed, overall non-qualifying |
| Clean WGPU UBO screen, 2 blocks | 49.307-52.227 off block means / 51.067-51.101 on | 29.48-31.66 per run | Diagnostic | All screenshots changed | `SCREENING_REJECT`; three runs aborted a pass after upload timeout |
| Latest 32×32 marker run | 98.580 | 59.150 | 58.360 | 10.420 | 36.798 ms input-to-browser-canvas average |

The presenter fallback and WGPU rows are not interleaved general-performance
comparisons. One run or one GPU does not establish a universal backend winner.

## Optimization decisions

| Candidate | Result | Decision |
| --- | --- | --- |
| Immediate tick fresh-frame delivery | Prior confirmation removed queue age without a material game/visual regression | Retained; `legacytickqueue=1` rollback |
| WGPU canvas ownership | Hardware-present success now prevents legacy tick/show-image overwrite; visible battle and changing hashes confirmed | Retained; correctness fix |
| Historical multi-draw EFB-pass readback | `FIRST_EFB_PASS_MUTATED`, 182,949 nonzero color bytes after 108 draws | Retained as opt-in nonzero-output evidence; the current one-draw zero restore shows that a pre-pass baseline is required for a true mutation claim |
| Monotonic WGPU upload watermark | Prevents producer reuse until JS has synchronously consumed upload bytes; focused wrap/order/drop tests pass | Retained; correctness prerequisite |
| Bounded WGPU replay pump | Two-run means: backlog −72.16%, presentation +52.13%, p95 submit interval −34.56%, game speed +1.085 points | On by default only for `video=wgpu`; `wgpupump=0` rollback |
| Atomic WGPU pass publication | Final smoke: begin/end 10,925/10,925, zero split/outside/drop/abort/timeout, nonzero first completed pass | Retained correctness prerequisite; `wgpuatomic=0` diagnostic rollback |
| WGPU stable-state suppression | About 40% fewer replay records and 38.62% lower backlog, but no cadence gain; five arms missed the strict first-pass classifier gate | Keep default-off; opt in with `wgpustatecache=1` |
| WGPU producer UBO cache | 43.93-44.24% hit rate and 219-269 MiB suppressed per run, but paired effects reversed and three runs timed out/aborted | `SCREENING_REJECT`; keep `wgpuubocache=1` default-off |
| Exact TEV hot cases | 47.3 million execute-plus-shadow pixels had zero mismatch; 10-block primary throughput gate passed at median +4.955% | Overall comparison remained non-promotable; keep `swtevfast=1` default-off |
| CMPR exact-predicate specialization | 463,348 exact decoder comparisons passed; paired visual deltas all positive, mean +7.16% | Provisionally retained; patch-level rollback |
| Correlated core timing | One 57.590 ms tuple was 99.38% pacing wait, with zero compile time | Retained as metrics-only attribution |
| Deterministic input marker | Strict 6/6 causal generation parity; latest run averaged 36.798 ms to browser canvas | Retained as opt-in diagnostic; never call it input-to-photon |
| `addzex` emitter restore | All eight old failures were the same accidental compile-time disable; rebuilt diagnostic recorded zero | Retained; runtime `disable=wasmaddze` escape hatch remains |
| Correctness-sensitive JIT flags | No evidence authorizes enabling block merge, short prefix, or fastmem hoist | Defaults unchanged |
| Audio buffering | Zero underruns in retained evidence | Unchanged |

## Ranked optimization backlog

| Rank | Optimization/refactor | Area | Risk | Expected gain | Measurement method |
| ---: | --- | --- | --- | --- | --- |
| 1 | Combine vertex/index streaming uploads behind `wgpugeompack=1` | Hardware WGPU | High | Remove about 207k-247k `writeBuffer` calls per retained run | Byte-parity fake consumer, wrap stress, strict fixed-work A/B |
| 2 | Test a 64 MiB producer upload arena with 32 MiB fallback | Hardware WGPU | Medium | Prevent timeout/abort during transient queue stalls; no expected call reduction | Zero timeout/abort gate, memory allocation telemetry, unchanged bytes/calls |
| 3 | Select the next stable software traversal/texture case | Software raster | High | Further unique-frame gain on the default path | Seeded stability, production byte parity, clean confirmation |
| 4 | Measure physical input-to-photon latency | Input/display | Low | Complete the user-feel latency chain | `INPUTMARKEROBSERVE=0`, high-speed camera/photodiode, browser timestamps |
| 5 | Capture a DVD-owned correlated slice | CPU/core | Low | Separate result-queue wait from RAM copy/finish work | Nested DVD tuple with the same 80% ownership gate |
| 6 | Revisit JIT hot blocks only after warm/cold replay data | PPC/WASM JIT | High | Potential game-speed low reduction; no expected direct unique-FPS gain | Compile/run/helper profile, state hashes, warm/cold fixed-save blocks |
| 7 | Test lower audio lead with a zero-underrun gate | Audio/latency | Medium | Lower feel latency, not throughput | 120/100/80 ms balanced runs; underrun and marker p95 |
| 8 | Test build variants one flag at a time | Build | Medium | Unknown CPU/raster gain; possible load-size change | Independent parity builds plus fixed-save repeated A/B |

Risk definitions: Low is instrumentation/logging with no intended behavior
change. Medium is a local reversible refactor with clear tests. High is a
correctness-sensitive emulator, renderer, raster, or JIT change.

## Immediate implementation plan

### Today — instrumentation and baselines completed

- Two independent builds are byte-identical, and every profiler counter
  activates on the exact save.
- Three balanced-order `metrics=0`/`metrics=1` pairs are archived. Paired
  game-speed differences were +4.47, +1.23, and -2.18 points, so no profiler
  slowdown is resolved above variation.
- Metrics-on runs averaged a 78.26% sampled stale-source ratio and zero FIFO
  distance underflows.

### Next — low-risk wins

- Add destination-role and size-bucket attribution before changing WGPU
  geometry upload behavior.
- Capture a DVD-owned correlated tuple; the VI pacing tuple is complete.
- Test 64 MiB upload capacity separately as a liveness mitigation, not a speed
  claim.
- Preserve raw JSON/CSV/events and exact core/browser/fixture hashes.

### Then — high-impact renderer/JIT work

- Build the default-off combined vertex/index upload described in
  [the coalescing plan](wgpu-upload-coalescing-plan.md); require wrap and
  publication-failure parity before headed A/B.
- Optimize only a second software raster case shown stable by seeded counters.
- Revisit JIT block generation only after warm/cold evidence and correctness
  hashes; do not turn on sensitive flags by default.

## Concrete code changes and rollback

| File/module | Exact problem and proposed/implemented change | How to test | Rollback |
| --- | --- | --- | --- |
| `core/upstream/dolphin_web_raster_profile.h`; patch `0009` | Hot phases and FIFO pressure were invisible. Added sampled TLS phase counters, batched FIFO counters, consumer-observed backlog age, saturated distance accounting, and epoch reset. | Rebuilt exact-save metrics run; require activation/nonzero fields, finite ages, `fifouf=0`; compare metrics off/on. | Disable with `metrics=0`; revert profile patch/header. |
| `core/upstream/dolphin_web_discio.cpp::DolphinWeb_RecordVideoOutputProfile` | The old frame hook was not reached on the browser path. Publish source-generation cadence at the reached `Video_OutputXFB` bridge. | Frame count and intervals must advance with XFB output. | Revert bridge publication; existing presentation metrics remain. |
| `src/upstream-discio-worker.js::drainWebGpuCmdRing` | Later clears made present-time EFB samples ambiguous. Encode one opt-in readback immediately after the first completed EFB pass with draws. | Classifier unit tests; compare the readback with a known baseline/source. The older multi-draw smoke is nonzero, while the current all-zero save restore correctly remains zero. | Omit `wgpuclassify=1`. |
| `src/upstream-discio-worker.js` canvas ownership paths | Legacy tick and show-image repaint overwrote successful hardware output with stale green/checker pixels. Claim ownership after successful hardware submit and suppress those repaint paths. | Headed exact-save screenshot, changing hashes, nonzero present count, zero GPU validation errors. | Revert ownership guards to reproduce only; no runtime flag is recommended. |
| `patches/dolphin-wasm/snapshot/0011-webgpu-upload-watermark.patch`; `src/wgpu-upload-watermark.js` | A 32 MiB upload arena could wrap while old commands still referenced overwritten bytes. Added producer/consumer watermarks, bounded wait, ordered suffix staging, and dropped-tail rollback. | Uint32 wrap/order model, source contract tests, headed replay with zero errors. | Revert protocol patch and JS together; never mix versions. |
| `src/core-host.js`; `src/wgpu-replay-diagnostics.js` | Sparse replay polling allowed a 59k-record backlog after correctness. Default the 16,384-record pump only for `WebGPU-Real`, honoring explicit 0/1. | Two repeated fixed-save runs per arm; record backlog, cadence, game speed, drain and errors. | `wgpupump=0`. |
| Patches `0012` and `0016`; `tools/software-texture-hot-case-parity.cpp` | Exact TEV/texture cases and sampled work share were unknown. Added seeded case profiles, then one Emscripten-only exact CMPR predicate with generic fallback. | Three seeded runs, 463,348 production-decoder parity samples, three balanced headed pairs. | Revert patch `0016`; no URL flag is implied. |
| Patches `0013` and `0015`; `src/wgpu-pass-state-cache.js`; `src/wgpu-upload-watermark.js` | Partial passes and redundant state records inflated or corrupted replay. Publish complete passes with one release store; suppress only exact successfully-published state repeats; rebase staged upload windows wrap-safely. | Atomicity/source tests, zero-error nonzero-output smoke, balanced cache A/B. | `wgpuatomic=0` for legacy diagnostics; omit `wgpustatecache=1`; never mix protocol versions. |
| JIT snapshot patch `0010`; `tools/jit-diagnostics-analyze.mjs`; analyzer evidence | `addzex` was compiled out by a diagnostic define, manufacturing eight failures. Removed the define while retaining the runtime disable and per-op stats. The schema-v2 analyzer now accepts a correlated timing tuple, applies an 80% ownership threshold, and preserves deduplicated legacy-log fallback. | Rebuild/exact-save `emitfail=0`; focused parser cases for every owner, mixed timing, tuple precedence, and partial worker/main mirroring. | `disable=wasmaddze` for JIT rollback; omit the structured tuple to retain legacy analyzer behavior. |
| `src/gpu-completion-telemetry.js`; worker submit sites | Queue submission time did not show GPU completion or outstanding work. Sample `queue.onSubmittedWorkDone()` with bounded cadence. | Unit tests plus software/hardware exact-save samples; no unhandled promise errors. | Omit `gpucomplete=1`. |
| `src/input-latency-telemetry.js`; host/worker input path | Host apply, core poll, and next visible change were not correlated. Added sequence-bound transport/poll/visible timestamps and safe WGPU readback baselines. | Six scripted state changes; match applied/polled/visible counts; reject validation-error runs. | Omit `inputlatency=1`. |
| `src/input-transport.js`; `src/input-visual-marker.js`; marker observer | Legacy input transport could tear, and next-distinct-frame was non-causal. Added a seqlock SAB generation and exact generation-coded 32×32 marker through core poll, submission, GPU completion, and browser-canvas readback. | Strict 6/6 parity, monotonic timestamps, zero mismatch/expiry/read/drop counters. | Omit `inputlatency=1`; use `INPUTMARKEROBSERVE=0` for external sensing. |
| `tools/menu-progress-validate.mjs`; `tools/perf-artifacts.mjs` | Runs lacked uniform raw causal fields and could be mistaken for menu progression. Preserve JSON/CSV/events/metadata and direct-load the supplied exact save with input disabled. | Fixture hashes, scene marker, save-load success, raw artifact tests. | Revert harness-only changes; never restore menu driving for qualification. |
| Patch `0021`; `tools/software-tev-hot-case-parity.cpp` | Three exact TEV tuples represented about 47.5% of sampled stage work. Add default-off specialization and same-pixel shadow comparison. | Native/Emscripten parity, 47.3 million execute-plus-shadow pixels with zero mismatch, clean 10-block fixed-work confirmation. | Omit `swtevfast=1`; revert patch `0021`. |
| Patch `0019`; `tools/validate-wgpu-ubo-screening.mjs` | Repeated UBO contents generated avoidable uploads, but snapshots and replay failures needed strict separation. Add default-off exact cache counters and monotonic-age validation. | Focused cache tests plus eight-run strict screen; validator retains nine findings across three runs: six timeout/abort counters plus three helper summaries. | Omit `wgpuubocache=1`; revert patch `0019`. |
| `tools/perf-regression-gate.mjs`; `tools/perf-artifacts.mjs` | Fixed wall time compared different emulated work, and WGPU uses a renderer-specific exact checkpoint hash. Stop after fixed core ticks and lock software/WGPU hashes separately. | Scheduler/unit tests plus 40-run TEV confirmation and eight-run WGPU screen from clean commits. | Omit `--target-core-seconds`; keep exact checkpoint validation. |

## Limits and remaining unknowns

- Unique visual FPS is a sampled changing-frame hash, not a perceptual quality
  score.
- The older final EFB smoke proves nonzero output after a completed 120-draw
  pass. The classifier did not retain a pre-pass baseline, so it does not prove
  which draw changed a byte. The current first post-load pass is a one-draw
  restore from all-zero serialized color/depth and is expected to remain zero.
- The color classifier does not validate depth restore, and WebGPU staging
  readback is still a zero-filled stub. Both are separate correctness risks.
- Current WGPU numbers are JIT-off diagnostics on one AMD GPU, not a general
  performance claim.
- The clean WGPU UBO screen is invalid for promotion because three runs
  omitted a poisoned pass after an upload-watermark timeout.
- The TEV primary throughput hypothesis passed its 10-block statistical gate,
  but four presentation-floor misses kept the overall result non-promotable.
- GPU-completion whole-run maxima include boot and save-load transients.
- The measured worst correlated slice is pacing-owned. DVD result-queue wait
  still needs its own worst-slice tuple; this run's retained tuple had `dvd=0`.
- The 32×32 marker is causal to the browser canvas, not to physical photons.
- Wii and general GameCube compatibility remain out of scope.

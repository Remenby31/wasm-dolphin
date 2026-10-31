# Hardware WebGPU performance audit - 2026-07-13

## Outcome

Headed/operator validation reports a changing battle image from the true
hardware WebGPU path, but it is not yet full speed on the validation machine.
The original captures in this document ran at roughly 47-53% game speed. Later
fixed-work work reduced unrelated overhead and established a 73-76% visible
baseline. Compiling high-volume CachedInterpreter diagnostic counters out of
release WASM improved the balanced visible mean from 73.14% to 74.88%; a clean
confirmation measured 76.10% visible and 78.84% with GPU replay drained. These
figures are scene- and machine-specific. Frequency-ordering the
CachedInterpreter callback ladder then improved the eight-run null-drain mean
from 77.22% to 80.12% and the four-run visible mean from 74.85% to 76.22%.
Clean confirmations measured 80.45% null-drain and 77.32% visible. Single-run
confirmations are not balanced estimates.

The current core is content-addressed as
`fe4448a07a726b67c9b7bd73f2515118b353414a66ac48cc4b1cdd92fb42f2c8`
(12,916,037 bytes). It was rebuilt from an empty build directory after replaying
the complete patch lock for the parent optimization, then reproduced by a full
1,348-target rebuild after the dispatch-order change. The earlier semantic capture below belongs to core
`6a2469a5...` and remains evidence for that captured applied-save prefix, not
for general renderer correctness or the newer core.

No default rendering or JIT flag changed. Automated comparisons used
`AUDIO_MODE=muted`; the separate headed validation used
`AUDIO_MODE=audible` and produced non-silent audio in 239/242 samples.

## Evidence boundary

- Scene: direct-loaded `__battle.sav`, the reference battle. The harness pauses,
  applies the save, and resumes without driving menus or character select.
- ROM SHA-256: `<reference disc SHA-256, not tracked>`.
- Save SHA-256: `620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1`.
- Machine: Windows 11 Pro build 26200; Ryzen 9 9950X3D, 32 logical CPUs,
  125.6 GiB reported RAM; Radeon RX 9070 XT, driver `32.0.31021.5001`.
- Browser: Chrome `143.0.7499.4`; WebGPU adapter reports AMD/RDNA 4.
- Upstream Dolphin: `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1`.
- Accepted patch series: 44 patches, SHA-256
  `88c5929c7c95365ae251345f35a53e93ac9c8febcf1fc5bcc52f7597c9d122e1`,
  result tree `4f1a43bf5fefa1aad727ed25c4c7e79f8321c9fc`.
- Branch/commit after evidence integration:
  `perf/cached-interpreter-dispatch-order` / commit pending; parent hot-counter
  change `a93026a43dd915839fa77a3f8a014307e8884118`.

The hardware `visualFps=0` field is not a valid unique-image metric here: it
still hashes the software XFB source. Browser canvas hashes changed on every
sample in the headed run (61/61), which proves changing presentation but does
not provide a calibrated hardware unique-FPS rate or independently prove the
scene identity. Battle-image identity is operator validation.

## CachedInterpreter hot-counter compile-out

The direct-save scene executed at least 2.602 billion telemetry-only counter
writes per 12 emulated seconds even with `ppcprof=0`. Release builds now use
`DOLPHIN_WEB_HOT_COUNTERS=0`, which removes those writes at compile time while
preserving JIT engagement/failure metrics and the game idle-loop counters used
by throttle behavior. Browser helper telemetry explicitly reports
`hotcounts:off`.

| Screen | Reference mean | Candidate mean | Gain | Validity |
| --- | ---: | ---: | ---: | --- |
| Eight-run hardware null-drain ABBA/BAAB | 75.12% | 76.99% | +1.87 points / +2.49% | Both blocks and all four pairs positive; 0 runtime failures |
| Four-run visible mapped WebGPU ABBA | 73.14% | 74.88% | +1.73 points / +2.37% | Every run had 17 changed and 18 readable samples; correct battle image |
| Clean-core null-drain confirmation | n/a | 78.84% | single run | Valid fixed work; `hotcounts:off` |
| Clean-core visible confirmation | n/a | 76.10% | single run | 16 changed samples; correct battle image; no WebGPU errors |

Raw reports are under
`.omx/wgpu-realtime-100/cached-interpreter-hot-counter-null-drain/`,
`.omx/wgpu-realtime-100/cached-interpreter-hot-counter-visible/`, and
`.omx/wgpu-realtime-100/cached-interpreter-hot-counter-clean-confirm/`.
The clean null-drain and visible report SHA-256 values are respectively
`007a43c3e58504de922ba0627f9835b81d7ee0e1fd6607169c3ddca0c442b2aa`
and `2ab2e4611a825ecafff47ae6de8fa7f456aeb43d690adeaae017d13b331abe12`.

## CachedInterpreter frequency-ordered dispatch

The direct callback ladder previously checked low-frequency system operations
before the measured hot integer, branch, floating-point, and `bdnz` callbacks.
The retained order keeps `Interpret<false>` first, then tests `FastInteger`,
`FastBranch`, `FastFloat`, `FastBranchBdnz`, and `Interpret<true>` before the
remaining system callbacks. Callback bodies and payload handling are identical
between the candidate and compile-time rollback orders.

| Screen | Reference mean | Candidate mean | Gain | Validity |
| --- | ---: | ---: | ---: | --- |
| Eight valid hardware null-drain ABBA/BAAB runs | 77.22% | 80.12% | +2.90 points / +3.76% | ABBA +3.30 points; BAAB +2.50 points; 0 runtime failures |
| Four-run visible mapped WebGPU ABBA | 74.85% | 76.22% | +1.37 points / +1.82% | Every run valid; candidate had 16/17 changed/readable samples |
| Clean-core null-drain confirmation | n/a | 80.45% | single run | Valid fixed work; production flags unchanged |
| Clean-core visible confirmation | n/a | 77.32% | single run | 16/17 changed/readable samples; correct battle image; no WebGPU errors |

Raw reports are under
`.omx/wgpu-realtime-100/cached-interpreter-dispatch-order-null-drain-r2/`,
`.omx/wgpu-realtime-100/cached-interpreter-dispatch-order-visible/`, and
`.omx/wgpu-realtime-100/cached-interpreter-dispatch-order-clean-confirm/`.
The clean null-drain and visible report SHA-256 values are respectively
`7e04ec924bc6806a48d7a2881f5638c838c4ae28240289f14c21e213675f805b`
and `31100ddfd49b4fcde66d437eca0bb30c9db03bd7a8c4ec130131719b14b02be1`.
The 12,916,037-byte candidate reproduced SHA-256 `fe4448a07...` after a full
1,348-target rebuild with the unchanged production compile flags. Define
`DOLPHIN_WEB_HOT_DISPATCH_ORDER=0` externally to restore the legacy order.

## Immutable pass-package falsification

The passive consumer projection observed 3,058,795 legacy records, 897,121
legacy publications, 7,363 complete passes, 849,087 uploads, and 1.846 GB of
upload payload in one visible fixed-work run. A full-envelope grouping would
theoretically reduce publications by 98.3%, but that consumer-only result is
not a correctness claim because it cannot see unpublished producer aborts or
prove resource generations.

A bounded native-ownership plus WDS2 semantic capture now reports a separate
current-epoch opportunity model. It paired 73,001 records overall and froze a
clean applied-save prefix with zero mismatch, abort, drop, ordering, or epoch
errors. In that prefix, the conservative package set (buffer uploads plus
already-private pass records) covered 401 of 440 records across 10 committed
transactions, but reduced only 94 of 133 release publications (70.7%). This is
below the plan's 90% producer-falsification gate, so executable package
transport remains parked.

Single-run observer classification measured 77.36% with projection only,
71.67% with ownership trace, and 72.03% with semantic mode; the corresponding
clean visible confirmation was 77.32%. Projection overhead is therefore small,
while native trace is the observer cost that must be reduced or bounded more
tightly. These are descriptive single runs, not balanced performance effects.
The latest visible workload also contains a 6.319 MB pass payload, so a future
runtime design needs multiple immutable payload pages under one atomic
transaction rather than one contiguous 4 MiB package.

## Reproducible candidate

`compare-core-builds` reported `sourceEqual`, `toolchainEqual`, `wasmExact`,
`jsNormalizedExact`, and `reproducible` as true for
`.omx/applied-boundary-core` and `.omx/applied-boundary-core-2`.

| WASM section | Bytes | SHA-256 |
| --- | ---: | --- |
| code | 10,419,762 | `018a11cd76028403a3b1136e5625d8501efba37792763657f7c6601daee8aa6e` |
| data | 2,454,556 | `d323d2605916077c3468c9e1ae73e7e0ba2caa8cfb3b80bbd76a765ccb3e262f` |

## Applied-save semantic proof

Raw artifact:
`.omx/wgpu-semantic/direct-save-candidate-6a2469a5-current-head-muted`;
`summary.json` SHA-256
`011690cba02364dff6cc953f8e85eaaa68aeacb68f18166d23ac253cc7a6a9e8`.

| Check | Result |
| --- | --- |
| Capture | active, frozen, complete, evidence valid |
| Save boundary | generation 1; one load epoch; 351 post-load committed events |
| Ownership | 25,481 prepared / 25,481 accepted / 0 discarded / 0 retried |
| Quiescence | 25,481 paired; 0 pending; 0 open transactions; 0 native drops |
| Independent decode | 25,481 events |
| Transactions | 220 committed / 0 aborted |
| Payload | 10,561,678 bytes hashed; 2,883,112 encoded bytes hashed |
| Parity | 0 mismatches; 0 unresolved dependencies |

The global digest is
`c5e91ce155a24f68753d52b57fbc18048752efe69b26e365d84e09205a366900`;
the applied-load epoch digest is
`4630757d7ce5e7e694ee6458729a2cb2a5860593a692ab73b8704a6d9f5ff0a7`.

## Performance screens

The headed audible 60-second run averaged 39.41% game speed, 24.04 core FPS,
and 19.90 presentation FPS. It processed 4,058,217 commands and 2,099,944
producer-attributed uploads totaling 3,331,261,104 bytes, with zero renderer
errors, command drops, batch aborts, oversize batches, or upload timeouts. It
is an audio/visibility validation, not comparable to the shorter muted runs.
Raw path: `.omx/wgpu-perf/direct-save-candidate-6a2469a5-audible-headed`;
summary SHA-256 `92104eb96d24c0be86936200b45eb6881228bc0265d04da8b0e86a114c60bbff`.

A final 25-second headed confirmation on commit `e53d17b` was also explicitly
audible: 97/99 audio samples were active, all 26 canvas samples had distinct
hashes, and renderer errors, drops, aborts, and upload timeouts stayed zero.
It averaged 49.71% game speed, 30.14 core FPS, and 22.81 presentation FPS.
Raw path:
`.omx/wgpu-perf/direct-save-candidate-6a2469a5-audible-headed-final`;
summary SHA-256
`92961283d6472029ff8f3e44c48ab6efbe37f7942358f36efb1e5c2ed9dd58b4`.

Two repeated 45-second muted cache screens averaged 46.865% with state/UBO
caches off and 49.45% with both on (+5.52% relative). Commands fell about 42%,
upload calls about 15%, upload bytes about 16%, and backlog high-water about
32%. This is encouraging screening evidence only: earlier balanced fixed-work
runs did not qualify a default promotion, so defaults remain unchanged.

A 2-way versus 4-way UBO-cache experiment reduced UBO calls by 8.35% and UBO
bytes by 4.44%, but mean game speed fell 0.50% and presentation FPS fell 4.3%.
The 4-way change was removed.

A geometry-range producer-copy refactor was also rejected. In an
`old/new/new/old` muted 30-second screen, total throughput was noisy and the
new mean was 51.88% versus 50.12% old. However, the targeted sampled
`geometry_commit` cost rose from about 623 ns/call to 691 ns/call (+11%). The
patch, test assertion, vendor edit, and candidate provenance were removed;
the raw artifacts remain under `.omx/wgpu-perf/geomcopy-ab-*`.

## Bottleneck classification

| Bottleneck candidate | Evidence | Confidence | Next action |
| --- | --- | --- | --- |
| CPU/game speed | JIT-off hardware screens remain near half speed while replay/upload counters are very large. The [July 10 audit](performance-audit-2026-07-10.md) classified its long slices as predominantly throttle, not execution or compile. | Medium/high for this scene | Keep CPU/JIT metrics enabled; reclassify after replay load is materially reduced. |
| Software raster/XFB | The recommended software path is source-frame limited, but the hardware WGPU runs do not use software raster for gameplay drawing. | High | Continue software optimization separately; do not use it to explain hardware-WGPU speed. |
| Presentation/canvas | Canvas hashes change, but GPU completion is disabled in these runs and hardware-present timing is not independently attributed. | Low/medium | Add a hardware-valid unique-frame marker and enable GPU-completion/present-phase sampling. |
| WebGPU hardware renderer | Applied-save semantic capture is clean and the battle is visible, but direct-save screens are only 47-53% game speed. | High on this GPU; low generally | Reduce safe upload/replay work without crossing transaction or resource-generation boundaries. |
| JS worker/message/copy | Millions of replayed commands and uploads, multi-gigabyte upload volume, and large backlogs are measured. Cache screens reduce records and improve screening speed. | High | Target UBO and geometry upload publication/copy count with fixed-work A/B gates. |
| Audio | Audible headed run was active for 98.76% of samples. Automated tests mute audio intentionally. | High that audio works; low on causal cost | Keep muted and audible result classes separate; do not tune buffering from cross-class comparisons. |
| Input latency | Existing generation-coded marker reaches browser-canvas visibility; it does not include compositor, scanout, or panel latency. | Medium | Repeat with hardware-valid frame identity and GPU completion in the same headed run. |
| Build flags | Independent release builds match exactly; no build-flag A/B shows a runtime win. | High on reproducibility; low as a bottleneck | Keep build flags stable while optimizing the measured replay path. |

## Ranked optimization backlog

| Rank | Optimization/refactor | Area | Risk | Expected gain | Measurement method |
| ---: | --- | --- | --- | --- | --- |
| 1 | Add hardware-valid presented-frame identity and timed replay/upload phase deltas | Instrumentation | Low | Better classification, no direct speed gain | Same-save repeated muted/headed baselines; raw JSON/CSV |
| 2 | Reduce UBO publication count without changing resource generations or pass ownership | Producer/replay | Medium | Fewer `queue.writeBuffer` calls and shorter backlog | Fixed-work, order-balanced A/B plus semantic digest |
| 3 | Replace per-draw geometry copies with a bounded lifetime-proven arena/ring design | Geometry upload | High | Lower producer copy and upload call pressure | Native wrap/abort tests, semantic parity, repeated direct-save A/B |
| 4 | Bound replay work per presentation turn without splitting atomic transactions | JS scheduling | Medium | Lower long stalls and input latency; throughput may be neutral | GPU completion, backlog age, p95 present interval, game speed |
| 5 | Re-run guarded JIT after replay load falls | CPU/JIT | Medium | Potential game-speed headroom | Compile/run/helper metrics and fixed-save `wasmjit=0/1` pairs |
| 6 | Diagnose on a second GPU/browser build | Compatibility | Low | Confidence, not direct gain | Same content-addressed core and evidence schema |

## Immediate implementation plan

### Today: instrumentation and baselines

- Keep the direct-save, explicit audio-mode, semantic-generation, upload-role,
  producer-phase, GPU-completion, and input-marker evidence paths intact.
- Add a hardware-present identity counter so `visualFps` no longer depends on
  the absent software XFB hash.
- Record replay counters as timed deltas; do not mix replay-op histograms with
  producer-attribution totals.

### Next: low-risk wins

- Screen UBO record suppression/packing variants with identical save,
  duration, audio mode, browser, and core-selection evidence.
- Move only proven non-observable bookkeeping out of per-command JS paths.
- Require zero renderer errors, drops, aborts, timeouts, semantic mismatches,
  and unresolved dependencies before retaining a candidate.

### Then: high-impact renderer/JIT work

- Design a persistent geometry/UBO upload arena whose wrap and submission
  lifetime are explicit and testable.
- Reduce replay backlog only at transaction-safe boundaries.
- Re-run JIT and CPU-core A/Bs after GPU replay pressure no longer dominates.

## Concrete code changes and rollback

| File/module | Exact problem and change | Test | Rollback |
| --- | --- | --- | --- |
| `core/upstream/dolphin_web_core.cpp`, `patches/dolphin-wasm/snapshot/0040-webgpu-applied-load-boundary.patch` | `LoadRequested` used to precede successful state application. It now publishes after `State::Load` applies and waits for ownership quiescence. | Native source/provenance tests and post-load semantic capture | Revert patch 0040 and regenerate provenance. |
| `src/wgpu-semantic-runtime.js`, `src/wgpu-ownership-trace.js` | Pre-load and post-load records could be conflated. Generation gating, frozen capture, and quiescent checkpoint qualification now bind evidence to the applied save. | Semantic runtime, ownership trace, worker integration, and two-successive-load tests | Revert `e53d17b`; feature is metrics-gated/default-off. |
| `tools/menu-progress-validate.mjs`, `tools/perf-artifacts.mjs` | Menu driving stopped at character select and audio state was implicit. `SAVE_STATE_AT=0` now pauses, loads, resumes, then samples; `AUDIO_MODE` is recorded as `muted` or `audible`. | Direct-save and perf-artifact tests; headed audible smoke | Omit direct-save env vars or revert the harness commit. |
| `src/upstream-discio-worker.js` replay loop (proposed) | Large atomic drains can occupy the worker long enough to hurt cadence. Stop only between ownership-safe transactions and expose timed deltas. | Existing replay diagnostics, semantic digest, GPU completion, present p95 | Feature flag to the current unbounded drain. |
| `vendor/dolphin/.../WebGPUVertexManager.cpp` (proposed patch) | Geometry is copied/published too often. Introduce a bounded ring only after wrap, abort, restore, and submission ownership are specified. | Native boundary/wrap/abort tests plus content-addressed A/B | Keep behind default-off URL flag; remove patch if qualification fails. |

## Limits

These measurements cover one machine, one Chrome build, one battle save, and
one experimental backend. Time-window screens are not deterministic
fixed-work benchmarks. The semantic proof covers a bounded command prefix and
does not prove pixels or all future frames. No claim here establishes full
speed, broad GameCube/Wii compatibility, or release readiness.

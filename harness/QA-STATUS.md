# QA checklist: what the harness measures today

Tracks `QA-CHECKLIST.md` (kept next to the checkout, not in the repo) item by
item. Status: **done** (measured automatically, recorded in the run JSON),
**partial** (measured with a stated limit), **todo**, and **needs rebuild**
(implemented in the engine, active once the core is rebuilt with
`docs/repro-build.md`; until then the check reports "unjudged"). "Gate" marks
what blocks a PR; everything else is a report.

## P0

| § | Item | Status | Where / limit |
|---|---|---|---|
| 1 | Verdict per (game, config, machine) | done (report) | `lib/verdict.mjs`, informational. The blocking gate is correctness-only (`lib/correctness.mjs`, `lib/gate.mjs`) plus confirmed ≥ 15 % paired performance regressions |
| 2 | Speed: median, p5, min, dips < 90 % with time | needs rebuild | per wall-clock second from the VI timeline (emulated ticks); until the rebuild, the app's sampled `gameSpeed`, labelled `speedSource` |
| 2 | Produced frames vs unique presented frames | todo | the VI timeline counts outputs, not distinct game frames; a per-output XFB hash in the VI ring would give it (small core change) |
| 2 | Native cadence reference | partial | `nativeFps` in the game spec only. The software-at-unlimited-speed probe was dropped: on the local race scene the raster produced nothing at 1931 % |
| 2 | Frame time p50/p95/p99/max, hitches > 2 frames/min | done | every presentation from the worker's presentation ring (`validationReadTimeline`), no sampling |
| 2 | Presentation freeze > 500 ms while the core advances | done (report) / needs rebuild | gaps between consecutive presentations with VI outputs inside (VI timeline needs the rebuild) |
| 3 | Audio underruns per minute, buffer level drift | partial | legacy transport `underrunCount` (verdict uses the worst run), schedule lead min/max. Worklet ring underruns not read yet |
| 3 | Audio not silent (peak, RMS) | done (gate) | AnalyserNode on the output gain after unmuting (autoplay allowed); `audio` check when the game spec says `audio: true`; `tonetest` disc. Worklet transport untested |
| 4 | Fixed frames (savestate + frame N) vs reference | needs rebuild (gate) | core-side capture at an exact VI output (`DolphinWeb_HarnessArmCapture`); same tick count required; byte-identical for the same renderer. **Hardware renderers: todo**, their picture is on the GPU, the core must tag presents with the VI output |
| 4 | Black / white / uniform, missing geometry, squeezed picture | done on exact captures | `lib/image-diff.mjs`; wall-clock screenshots are never judged |
| 4 | Frame-to-frame flicker | todo | needs consecutive captures of a static scene |
| 4 | Output resolution and aspect ratio | todo | extent check covers squeezing, not the declared ratio |
| 5 | 0 crash, 0 worker error, 0 JIT compile error | done (gate) | fatal console/page/worker errors → `crash` |
| 5 | Swallowed errors: unknown worker messages, unhandled rejections | done (gate) | page monitor counts `error`, `unhandledrejection`, `console.error`; engine counter `transportTelemetry().unknownMessagesReceived` (`src/upstream-worker-adapter.js`) plus `unmatchedErrorRepliesReceived`; any run, any load |
| 5 | Console errors counted and listed | done | `monitor.errors.last` (20 latest) in each run JSON |
| 5 | Interpreter vs JIT (`fuzz`): crash, divergence, JIT not exercised | needs rebuild (gate) | exact captures at VI output 1700, byte equality |
| 5 | Core freeze (no VI output for 2 s) | needs rebuild (gate) | from the VI timeline |
| 5 | Recovery after hidden tab, pause/resume, window/screen change | todo | |
| 7 | Inputs on ports 1-4, keyboard and pad | needs rebuild (gate) | `harness/run pads`: 4 mocked pads read back from exact captures with a checksum row. Analog amplitude/dead zone and hot-plug not yet |
| 7 | Saves survive a reload; import/export | todo | depends on the OPFS work (phase 1) |
| 7 | Pause, resume, reset, quit and relaunch | todo | |
| 7 | Formats .iso .rvz .ciso .gcm .dol | todo | `.dol` boot is phase 1 |
| 7 | Input → photon latency per port | todo | repo telemetry exists (`docs/input-to-photon-validation.md`) |
| 8 | Streaming (latency, host impact, guest quality, degraded network) | todo | site agent's scope; harness hooks (`captureStream` grab) exist |
| 11 | Headed Chrome, isolated profile, no extensions | done | `lib/browser.mjs` |
| 11 | Load before and during; run marked above the limit | done | marks `overloaded`; affects the performance report only, never correctness |
| 11 | Warmup excluded, N ≥ 3, median and IQR, A/B alternated | done | `warmupSec`; `describe()` gives median/stdev/IQR; `harness/run ab` alternates baseline/candidate order run by run |
| 11 | Same scene via savestate | partial | `diff --state`; matrices reach scenes through scripted `steps` |
| 11 | Commit, full URL, Chrome version, GPU adapter | done | served snapshot hash (+ commit) per run, `url`, `env` |
| 11 | Regression gate against main | done | `harness/run ab <spec>`: correctness regressions and INCONCLUSIF block; performance blocks only on a confirmed ≥ 15 % paired regression; `harness/run gate` recomputes the decision from the persisted results |
| 12 | CI corpus: free homebrews only | partial | 3D + depth (`gxscene`), console, 4 pads, CPU fuzz, audio (`tonetest`). Missing: 2D sprites, transparency/dst-alpha |
| – | Gate acceptance (mutation selftest) | needs rebuild | `harness/selftest/run.mjs`: 8 mutants must block, N clean runs must pass |

## P1 / P2

| § | Item | Prio | Status |
|---|---|---|---|
| 3 | A/V offset | P1 | todo |
| 5 | Endurance 30-60 min: speed drift, JS/WASM/GPU memory growth, thermal throttling | P1 | todo |
| 6 | Time to first frame, to "playable" (≥ 95 % for 5 s) | P1 | todo |
| 6 | Shader compilation hitches over the first 2 minutes | P1 | todo |
| 6 | JIT ramp-up, cold vs warm cache | P1 | todo (fresh profile per run gives the cold case today) |
| 7 | Two-disc games, disc swap | P1 | todo |
| 9 | Determinism: per-frame state hash across runs and machines; desync detection | P2 | todo (cpufuzz's per-frame hash is a start) |
| 10 | Chrome + Edge (P0 there), Safari, Firefox; Windows, Linux; AMD/NVIDIA/Intel; 60/120/144 Hz; battery, background tab | P1 | todo: only Chrome on macOS / Apple GPU / 60 Hz so far |
| 10 | Reference modest machine | P1 | todo |

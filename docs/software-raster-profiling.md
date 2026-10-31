# Software raster phase profiling

The software renderer exposes a metrics-gated phase profile for separating
triangle traversal, TEV/color work, texture sampling, FIFO pressure, XFB
generation, source-frame cadence, and stale-frame reuse. It is diagnostic
instrumentation only; it does not select a raster mode or change rendered
output.

## Activation and interpretation

Use the normal software-hybrid URL with `video=software&metrics=1`. The worker
enables this profile only for the exact `Software Renderer` backend; WGPU,
OGL, and the legacy `video=webgpu` alias do not pay its hot-path cost. With
`metrics=0`, phase counters and clocks remain inactive. The enable call is a
pre-core-initialization configuration step, not a runtime toggle. A rebuilt
metrics-on software run is invalidated if any required phase never activates.

The C++ profile is published in `GetVideoStats` as `swphase:1` and promoted to
causal telemetry schema v2. Raw `samples.json`, `samples.csv`, and
`events.jsonl` retain these fields:

| Group | Meaning |
| --- | --- |
| `rasterTraversal*` | Calls to scissor-specific triangle traversal and deterministically sampled traversal time |
| `rasterCandidatePixelCount` | Pixels reaching raster work after the selected `fastsw` skip |
| `tevPixelCount`, `tevStageCount` | TEV pixels and total indirect/color stages evaluated |
| `tevTimed*` | Inclusive TEV timing samples; texture work inside those TEV calls remains included |
| `textureSample*` | Texture sample calls and independently sampled texture time |
| `textureCases` | Top exact texture-state cases, sampled work, and omitted/collision accounting |
| `tevCases` | Top TEV structural keys paired with exact-program fingerprints |
| `caseSampleSeed` | Published seed for the sparse TEV/texture case schedule |
| `fifo*` | Batched gather-pipe bursts/consumes, pending bytes, and sampled continuous-backlog age |
| `fifoDistanceUnderflowCount` | Count of impossible `<32` byte distances clamped by diagnostic instrumentation |
| `xfbGeneration*` | XFB encode calls and exact encode time reported by the existing software XFB hook |
| `frameGeneration*` | Reached `Video_OutputXFB` bridge calls and source-generation intervals |
| `sampledSourceFrame*` | Presenter-bound source frames classified by the existing sampled pixel hash |
| `staleRepaintCount` | Tick paints that intentionally reuse the last stable source frame |

Traversal is clocked once per 64 calls. TEV and texture sampling are clocked
once per 4,096 calls. Durations accumulate as nanoseconds and publish as
microseconds so sub-microsecond calls do not all truncate to zero. Phase
counters publish from the renderer thread at sampled-call boundaries; FIFO
counts publish in batches of 1,024. Fields can therefore lag by one sampling
batch. Fields named `Sampled` are deliberately not extrapolated into total
phase time. Compare average sampled cost and work counts rather than treating
sampled totals as a full-frame breakdown.

## Exact-case distributions

Phase totals show that texture and TEV work is frequent, but they do not by
themselves justify a specialized renderer path. Metrics-on builds therefore
take a second sparse TEV/texture sample on a seeded 3,072-5,119-call interval,
averaging approximately one case sample per 4,096 calls. TEV and texture use
different seed salts, and a scheduled case sample is moved forward when it
would coincide with the fixed phase-timing sample. Key construction and table
insertion therefore never contribute to the reported phase duration. Each case
table has 256 fixed slots, performs exact key comparison after hash probing,
and allocates no memory on the pixel path.

`textureCases.topCases` decodes the complete sampled request state:

- texture format, actual linear filtering, min/mag and mip filter state;
- base mip and whether the request performs trilinear mip blending;
- S/T wrap modes, RAM versus manually managed TMEM, and TLUT format;
- whether width and height are powers of two; and
- decode work per request: one nearest decode, four bilinear decodes, or twice
  either amount for trilinear sampling.

`tevCases.topCases` reports a structural key and a 64-bit program fingerprint.
The decoded structure includes TEV/indirect stage counts, texgen/color-channel
counts, texture-enabled and active-indirect counts, the used indirect-texture
mask, and compare/clamp counts. For sampled one-stage, zero-indirect programs,
schema 1 also exports the exact nine-word tuple: generation mode, indirect
reference, packed order, masked indirect control, color combiner, alpha
combiner, konst selection, resolved raster swap, and resolved texture swap.
Those cases aggregate by exact tuple equality. The fingerprint remains a
display and regression-probe value; it is not a correctness predicate. More
complex programs continue to export the legacy structure/fingerprint record
until a complete canonical tuple schema is defined for them.

Causal telemetry retains the raw tuple as `canonicalProgramSchema` and
`canonicalProgramWords`, and names each schema-1 word so JSON and CSV analysis
does not have to depend on positional decoding.

The core compatibility string appends compact `caseseed:`, `texcase:`, and
`tevcase:` records. Causal telemetry publishes the seed as `caseSampleSeed`,
expands the case records into the objects above, and flattens the seed, totals,
and leading keys into CSV (`causalRasterCaseSampleSeed` is the seed column). The
seed makes sampling differences between retained runs explicit; it does not
make different runs directly sample-identical. Each case record exports the
eight most common cases. `otherSampleCount` includes
exact table entries omitted from that top eight plus observations dropped only
if all 256 table slots were occupied.
`collisionCount` counts resolved hash probes; it does not mean that unlike
cases were merged. Top-case samples plus `otherSampleCount` must equal
`sampledCount`.

Existing retained artifacts contain only the legacy fingerprint and cannot be
used to reconstruct the exact tuple. A new headed, exact-save browser run is
mandatory before selecting or implementing any TEV specialization. Patch
`0020-software-tev-exact-tuple-profile.patch` adds metrics only; it does not
change TEV output or select a fast path.

The instrumentation itself selects no specialization. Collect at least three
same-save, no-input reference-battle runs and require a stable dominant case
before adding behavior. Run `fastsw=0` and `fastsw=1` separately because those
modes deliberately produce different pixel work and XFB identities. A later
candidate still requires exact texture-byte, EFB, and XFB parity; a matching
sampled visual hash is not sufficient. A specialization need not have a URL
flag when its exact predicate has a generic fallback; in that case rollback is
the patch, not an invented runtime mode.

## Validated CMPR hot case

Three seeded `fastsw=1` profiles selected texture keys `0xd38a01e` and
`0xd34a01e`. Both are CMPR, bilinear, no-mip, repeat-S/T, power-of-two,
non-TMEM cases; their top-two sampled work shares were 73.79%, 72.45%, and
72.16%. The keys differ in TLUT format. Those older profiles exposed only
legacy TEV structure/fingerprint records and showed about 43% top-three
concentration. The later exact one-stage schema and direct-save captures below
supersede that observation for TEV case selection.

Patch `0016-software-texture-hot-case.patch` adds an Emscripten-only exact
predicate that reuses decoded CMPR endpoints across the four bilinear taps.
Every nonmatching request runs the original generic sampler. The focused
production-decoder harness passed 463,348 exact comparisons with seed
`0x5a17c0de`, covering all 128×128 fractional boundary combinations,
negative/edge/repeat coordinates, dimensions 1×1 through 64×64, exact and
truncated spans, randomized texture/palette bytes, both observed TLUT formats,
and 131,072 extra random samples.

Three headed pairs moved mean unique cadence from 12.843 to 13.763 FPS
(+7.16%) and sampled stale ratio from 80.057% to 77.614%; all three paired
visual deltas were positive. This is provisionally retained diagnostic
evidence, not a clean-tree performance qualification. Rollback is to revert
patch `0016`; there is no URL flag for this exact-output specialization.

## Validated I4 dispatch and decoder parity

Three later fixed-save profiles identified six I4 cases with a mean 17.67% of
sampled decode work: `0x5340010`, `0x5300010`, `0xd34a010`, `0xd000010`,
`0xd280010`, and `0xd240010`. Patch
`0017-software-texture-i4-hot-case.patch` matches exactly that union. It does
not generalize to every I4 request. Format, filtering, mip, wrap, TMEM, TLUT
register state, and power-of-two dimension flags remain part of the predicate,
and every nonmatching request falls through to the generic decoder.

The specialization runs only after all four canonical `WrapCoord` operations.
It performs the same safe nibble reads as `TexDecoder_DecodeTexel`, including
zero-fill behavior for truncated spans. Because I4 writes the same intensity
to RGBA, it performs the generic bilinear sum once and copies the resulting
byte to all four channels.

Run the repeatable production-decoder check with:

```powershell
npm run test:texture-hot-cases
```

With seed `0x5a17c0de`, the check passes 463,348 CMPR comparisons, 1,004,520 I4
generic-versus-specialized comparisons, and 8,388,620 dispatch classifications.
The I4 matrix covers all six measured keys, every state dimension used by the
specialization predicate plus targeted packed-key near misses, explicit
out-of-range states, power-of-two and non-power-of-two dimensions, negative
and edge coordinates, exact and truncated spans, randomized bytes, and every
128x128 fractional pair at both negative and positive boundaries. Packed-key
fields that are not inputs to the specialization predicate are not claimed as
exhaustively enumerated.

This proves sampler dispatch and byte-output parity for the tested matrix. It
does not prove EFB/XFB or browser-frame parity, and no headed browser A/B has
yet measured its performance effect. Do not claim a cadence gain until those
runs are complete. Rollback is patch `0017`; no URL flag is introduced.

## Exact TEV hot cases: parity proven, throughput result non-promotable

Two headed `fastsw=1`, `metrics=1`, `ppcprof=1` captures loaded the exact
reference-battle save directly and used independent sparse-case seeds. Those
profile artifacts predate the post-load profile reset, so the figures below
subtract each run's `save-state-loaded` helper snapshot from its final
cumulative counters. The three cases were present in both endpoint top-eight
lists, making their subtraction exact.

| Schema-1 exact tuple | Capture 2 sample/work share | Capture 3 sample/work share |
| --- | ---: | ---: |
| `4011,0,40,0,8fa8f,8ffd0,0,e4,e4` | 27.746% / 19.237% | 27.865% / 19.283% |
| `10,0,0,0,8fffa,8ffd0,0,e4,e4` | 27.178% / 18.843% | 27.158% / 18.794% |
| `4010,0,0,0,8fffa,8ffd0,0,e4,e4` | 13.552% / 9.396% | 13.550% / 9.377% |
| Combined | 68.475% / 47.476% | 68.573% / 47.454% |

Patch `0021-software-tev-hot-case.patch` classifies these complete tuples once
per raster batch. `swtevfast=1` executes the exact specialization and
`swtevshadow=1` also evaluates the generic combiner from the same pre-stage
register snapshot. Both flags are default-off. Common indirect, texture,
konst, raster-color, alpha-test, fog, depth, bounding-box, and blend behavior
remains on the generic path; a mismatch restores generic registers and latches
the specialization off.

The headed shadow-only run ended with
`tevhot:2/32379/55009382/0/55009382/0`: 55,009,382 classified and shadowed
pixels with zero mismatches. The execute-plus-shadow run ended with
`tevhot:3/28030/47336624/47336624/47336624/0`: 47,336,624 specialized and
shadowed pixels with zero mismatches. These are same-pixel register-parity
checks. They are not a browser performance comparison or a retained
byte-for-byte EFB/XFB comparison.

The earlier dirty, fixed-wall-time screen was rejected because each arm
advanced a different emulated horizon. The replacement harness measures the
wall time needed to complete exactly eight emulated core seconds. Its clean
two-block screen produced a `+6.7479%` median signal, followed by a clean
10-block confirmation whose median fixed-work throughput effect was
`+4.9546%`, with a 95% block-bootstrap interval of
`[+1.5631%, +9.4837%]` and permutation `p=0.0390625`.

The primary comparison reached `STATISTICAL_GATE_PASS`, but the overall gate
remained `NON_QUALIFYING` and `promotable=false`: four of 40 runs fell below
the preregistered 50-FPS minimum presentation target. Screenshots were visibly
correct battle frames, but different emulated endpoints are not byte-for-byte
EFB/XFB parity. `swtevfast` therefore remains default-off. This is a
machine-specific throughput result, not a claimed unique-visual-FPS gain or a
default-safe optimization.

`sampledStaleFrameRatio` is based on the existing sparse visual hash, so it is
a classification of sampled output, not a cryptographic equality check.
`fifoConsumerObservedBacklogAge*` is the canonical JSON/CSV name for the age of
a continuously non-empty backlog as observed by the consumer. The deprecated
`fifoOldestPendingAge*` fields remain equal aliases for schema-v2 compatibility;
they do not mean true oldest-item residence time. Age is sampled once per 1,024
consumes to avoid hundreds of thousands of clock reads per second. Read it with
`fifoBytesLast`, `fifoBytesMax`, and the underflow counter; it is not a
producer-to-consumer latency for every 32-byte burst.

## Validated rebuild handoff

Do not claim phase evidence from the older candidate-C artifact: its phase
counters remained thread-local and its FIFO age could wrap to `UINT64_MAX`.
The validated replacement contains the epoch reset, sampled delta publication,
reached XFB frame hook, FIFO batching, and saturated-distance counter.

Produce two independent candidates before promoting generated artifacts:

```powershell
npm run fetch:dolphin
npm run patch:upstream

$env:DOLPHIN_WASM_BUILD_DIR = "build/raster-profile-a"
$env:DOLPHIN_WASM_OUTPUT_DIR = "build/raster-profile-a-output"
npm run configure:upstream
npm run build:upstream:full-core

$env:DOLPHIN_WASM_BUILD_DIR = "build/raster-profile-b"
$env:DOLPHIN_WASM_OUTPUT_DIR = "build/raster-profile-b-output"
npm run configure:upstream
npm run build:upstream:full-core

npm run compare:core-builds -- `
  build/raster-profile-a-output/dolphin-core-upstream.build.json `
  build/raster-profile-b-output/dolphin-core-upstream.build.json
```

The historical independent instrumentation builds matched exactly at WASM SHA-256
`158dde37602442bf1dacf42328501082b46b47768b2455946fcb4c596fcdb5ea`.
Three direct-save metrics-off/on pairs and activation evidence were recorded.

Instrumentation rollback is one commit: remove snapshot patch
`0009-software-raster-phase-profile.patch`, the bridge header/export, and the
schema-v2 phase fields. The pre-existing XFB and presentation metrics continue
to work independently.

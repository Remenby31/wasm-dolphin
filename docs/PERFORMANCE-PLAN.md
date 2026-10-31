# Performance and correctness plan

An ordered, testable backlog. Each item states a hypothesis, the test that
settles it, and what counts as success. Work them one at a time and record the
result — including "hypothesis dead", which is a result.

Written 2026-08-31 after a measurement session that killed several plausible
leads. Read [Measurement discipline](ARCHITECTURE.md#measurement-discipline)
first; most of the dead leads below died because a counter did not mean what it
looked like.

## Current baseline

`video=wgpu`, 45 GameCube discs, 45s each:

| metric | value |
| --- | ---: |
| boots | 41 (2 static, 2 black) |
| titles at >=95% game speed | 13 |
| titles at >=80% | 17 |
| mean unique visual fps | 28.4 |

Two clusters: ~13 titles at 99-100%, and a long tail at 20-40%. The tail is
what this plan is about.

## Already ruled out, with evidence — do not re-run these

| lead | evidence it is dead |
| --- | --- |
| JIT tier (guarded vs mixed) | 35/35, 29/29, 31/29 on three slow titles |
| JIT admission / emitter breadth | `reject:0` — nothing is rejected for unsupported instructions |
| JIT coverage generally | 11 -> 59,754,839 block runs moved a first-person adventure ("FPA" below) 34% -> 36% |
| the renderer, for most slow titles | FPA 34/34, RPG A 35.5/34, RPG B 32/36 (hw/sw) |
| stale prebuilt JIT cache | A/B with the broken v1 file: fighting game 100%/99%, futuristic racer 99% |

The fighting game is not a valid control for anything CPU-side: it sits at the 100% cap with
the JIT on or off, so a difference cannot show. Use a title below realtime.

---

## 1. Identify `wasm-function[1026]`  — DO THIS FIRST

**Hypothesis.** 94.6% of emulation-thread self time is in one wasm function that
has never been identified. It was assumed to be the cached interpreter; that
assumption is unverified and partly contradicted by item 2's result.

**Test.** Resolve the index against the core's wasm name section
(`cores/dolphin/dolphin-core-upstream.wasm`), e.g. `wasm-objdump -x -j Function`
or the emscripten symbol map, and confirm against a second profile capture.

**Success.** The function is named, and its role (interpreter dispatch, software
raster, FIFO, memory helper, sync) is stated with evidence.

**Why first.** The tail sits at ~34% with both the renderer and the JIT
eliminated. Something else dominates and nobody has named it. Every further
performance decision is guesswork until this is answered.

### Item 1 result (2026-08-31)

`wasm-function[1026]` was never named, and the attempt to name it produced two
warnings worth keeping:

- Wasm function indices are **build-specific**. Resolving the old profile's
  index against a freshly built binary gave `File::Rename` -- a confident,
  meaningless answer. Never map an index across builds.
- `--profiling-funcs` (needed for a name section, since the shipping wasm is
  stripped) costs about **20% speed**: FPA 32% plain vs 25.5% named.
  Nothing measured on a named build is comparable to the baseline.

On the named build every thread was dominated by `_do_futex_wait`, which looked
like a synchronisation bottleneck. It is not:

| test | result |
| --- | --- |
| pacing / queue depth (tick-4, direct-1, smooth-8) | 25.5 / 24 / 25.5 -- no effect |
| single vs dual core | 32% vs 30.5% -- no effect |

**What the bottleneck actually is: PPC execution throughput.** Underclocking the
emulated CPU scales speed almost proportionally:

| `oc` | speed |
| ---: | ---: |
| 1 | 30% |
| 0.5 | 34% |
| 0.25 | **78%** |

So these titles are CPU-bound, and JIT coverage is the right lever after all.

**Why coverage is ~8%: compiled prefixes are ~6 instructions long.** The helper
stat `pre:6/74` is `s_wasm_prefix_instruction_sum / s_wasm_block_attempt_count`
-- the average number of instructions compiled per attempted block, against a
max of 74. The admission loop walks a block and `break`s at the first
instruction it cannot emit, compiling only the prefix before it. With warmup
fixed, FPA runs 59.7M block executions, but at ~6 instructions each
that is roughly 8% of the instruction stream.

This revises the "emitter breadth is dead" entry above. `reject:0` is true --
whole blocks are not rejected -- but blocks are silently **truncated** at the
first unsupported instruction, which has the same effect and is invisible in
the reject counter. **Raising `pre:` is the performance lever.**

Next: find which instructions terminate prefixes most often, ranked by
frequency. The histogram infrastructure exists
(`s_wasm_direct_reject_key_counts`, emitted as `| rejOPCD/SUBOP:count`) but only
counts direct-tier rejects, not prefix terminations. Add the equivalent
histogram at the `break` sites in the prefix loop, then rank.

### Prefix-termination ranking (2026-08-31) -- corrects the entry above

Instrumented every exit from the prefix loop. FPA, 50s:

| reason | warm=700 | warm=60 |
| --- | ---: | ---: |
| HLE replace | 0 | 0 |
| breakpoint | 0 | 0 |
| idle loop | 0 | 0 |
| FP off | 0 | 2 |
| unsupported instruction | 1 | 10 |
| block end (`canEndBlock`) | 0 | 0 |
| loop exhausted (implied) | ~168 | ~3,696 |

Of 3,708 attempts, **12** prefixes stopped on an instruction the JIT could not
emit. The rest ran out of block.

**So `pre:5` is not truncation -- it is the block length.** The
"silently truncated at the first unsupported instruction" conclusion recorded
above is WRONG, and `reject:0` was telling the truth all along. Emitter breadth
is genuinely not the lever; this is now measured rather than inferred, twice.

**What this leaves.** Blocks average ~5 instructions and every one returns to
the dispatcher, because WASM has no cross-module direct jumps. Per-block
dispatch overhead is therefore amortised over ~5 instructions, which is why
59.7M block executions bought 2 points: JIT'd code is barely faster than
interpreting once dispatch is paid.

**The lever is per-block dispatch cost**, i.e. block chaining or packing several
guest blocks into one wasm module so control stays inside compiled code. That is
the one remaining explanation consistent with every measurement: CPU-bound
(underclock scales speed), not emitter-limited (12 terminations), not coverage-
gated by admission (reject:0), not renderer, pacing, tier or thread-sync.

Before attempting it, read
`G:\dolrecompwned\DolRecomp\docs
egister-cache-design.md` -- four reverted
attempts at the adjacent problem.

### Block chaining: REJECTED by the repo's own gate (2026-08-31)

`cpu-profile-capture.mjs` states the dispatch-vs-block-body ratio "is the
ceiling on what JIT block-linking could ever win, and it must be known before
committing to that (HIGH-risk) core rebuild". That ratio had never been
obtained -- every prior run reported `0 block modules` because the JIT was not
engaged, which the warmup finding explains.

Measured with the JIT engaged (172 block modules), emulation thread:

| bucket | time | share |
| --- | ---: | ---: |
| JIT block bodies | 754ms | **3.7%** |
| core module | 19,515ms | 96.3% |

**3.7% is the ceiling.** Chaining optimises the boundaries around JIT'd code;
it cannot win more than the time spent in JIT'd code. Do not build it.

Confirmed independently by raising coverage instead of reducing dispatch:

| warmup | attempts | compiled | block runs | speed |
| ---: | ---: | ---: | ---: | ---: |
| 60 | 2,495 | 1,352 | 68.4M | 36% |
| 0 | 5,989 | 3,080 | 82.6M | 35% |

2.3x the compiled blocks and 20% more executions for no gain -- exactly what a
3.7% share predicts.

**The JIT is not the performance lever on this workload, in any form**: not
tier, not admission, not emitter breadth, not coverage, not dispatch. It
executes ~4% of the time and making it execute more does not help.

### The actual target: the cached interpreter

The 96.3% "core module" bucket is where the time goes. Note the analyser's own
caveat -- that bucket is not purely interpreter dispatch; it also holds video,
FIFO and everything else compiled into the core.

**Next measurement, before any optimisation:** split that 96.3%. A named build
(`--profiling-funcs`) can attribute it by function, at the cost of ~20% speed --
fine for shares, useless for absolute numbers. That tells us whether the target
is interpreter dispatch, the software rasteriser, FIFO handling, or memory
helpers. Optimising the interpreter blind would repeat today's mistake of
committing to a lever before measuring its ceiling.

### Split measurement: where the 95% actually goes (2026-08-31)

FPA, warm, JIT engaged (202 block modules), named build. Shares only
-- that build is ~20% slower, so absolute numbers are not comparable.

| function | self time |
| --- | ---: |
| `CachedInterpreter::ExecuteOneBlock` | **28.0%** |
| `CachedInterpreter::FastInteger` | **15.3%** |
| `JitBaseBlockCache::Dispatch` | **10.3%** |
| `TryFastRamWordLoadStore` | 6.6% |
| JIT'd block bodies (all 202 modules) | 4.6% |
| `TryFastRamByteHalfLoadStore` | 3.3% |
| `MMU::WriteToHardware` (two variants) | 3.9% |
| `DolphinWeb_OnXfb` | 2.4% |
| `Interpreter::ps_add` / `ps_sub` / `psq_st` | 5.0% |
| `Helper_Quantize` | 1.7% |

**Grouped:**

| area | share |
| --- | ---: |
| cached interpreter execution (`ExecuteOneBlock` + `FastInteger`) | **43%** |
| per-block dispatch (`Dispatch`) | **10%** |
| guest memory helpers (fast-RAM paths + MMU writes) | **14%** |
| paired-single interpreter ops (`ps_*`, quantize) | **~7%** |
| JIT'd code | 4.6% |
| video (`DolphinWeb_OnXfb`) | 2.4% |

**Three real levers, in order:**

1. **The cached interpreter itself, 43%.** `ExecuteOneBlock` and `FastInteger`
   are where the time is. This is the target.
2. **Per-block dispatch, 10%.** `JitBaseBlockCache::Dispatch` is paid per block
   regardless of whether the block is JIT'd, so at ~5 instructions per block it
   is pure overhead on *every* path -- not just the JIT'd 4.6%. Longer blocks
   or a cheaper dispatch helps everything. Note this is a better argument for
   block work than chaining was, because it is not capped by the JIT's share.
3. **Paired-single ops interpreted, ~7%.** `ps_add`, `ps_sub`, `psq_st` and
   `Helper_Quantize` run interpreted. Gekko paired-singles are heavily used by
   GameCube titles; emitters for these would move real time.

**Do not** target the JIT: 4.6%, and raising its coverage measurably does not
help (see the chaining gate above).

### Interpreter optimisation, attempt 1: dispatch reorder -- no gain

`ExecuteOneBlock` dispatches through a linear if-else chain of up to 32
function-pointer comparisons. `RunWasmBlock` (4.6% of time) was tested before
`FastInteger` (15.3%), so every FastInteger dispatch paid an extra comparison.
Moving it changed nothing:

| title | reordered | control |
| --- | ---: | ---: |
| FPA | 27.5% | 27.5% |
| action-adventure | 24% | 23% |
| RPG A | 28% | 27% |

Reverted. The chain is not where the 28% goes.

**Where it does go.** `FastInteger` appears in the profile as its own frame, so
it is a real call; `Interpret<false>` does not, so it is inlined into
`ExecuteOneBlock`. That 28% is therefore mostly the *generic interpreter path*
doing actual work, not dispatch overhead. Speeding it up means moving
instructions off the generic path onto specialised fast callbacks -- real
emitter work, not a reordering.

Best-identified target: paired-singles. `ps_add`, `ps_sub`, `psq_st` and
`Helper_Quantize` are ~7% combined and run generic. GameCube titles lean on
them heavily.

### And the JIT does not make code faster at all

At warmup 0, FPA: 85.3M block runs at ~5 instructions each is ~427M
instructions in 50s, about 8.5M/s. The guest at 37% of 486MHz executes on the
order of 180M/s. So JIT'd code is **~4.7% of instructions consuming 4.6% of
time** -- the same cost per instruction as interpreting it.

That is the root explanation for every null result in this plan. The JIT is not
slow to engage or narrow in coverage; the code it emits is simply not faster,
because a 5-instruction block pays a module call plus guest-state sync
(`stateu32:14521ld/13794st`) around it. Fixing that is an architectural change
to how state is held across block boundaries, and DolRecomp's
`register-cache-design.md` records four reverted attempts at exactly that.

### Interpreter optimisation, attempt 2: paired-single specialisation

Implemented `FastPairedSingle` (patch 0057) for ps_sub/ps_add/ps_mul, Rc==0,
mirroring `FastFloat`'s shape: plain double arithmetic when FPSCR.VE is clear
and all four operands are finite, otherwise the exact `NI_*` path. Semantics
follow `Interpreter::ps_*` exactly, including ps_mul's `Force25Bit` on FC.
Behind `DOLPHIN_WEB_DISABLE_FASTPS` (bit 23) so it can be A/B'd on one binary.

**Correct**: an action platformer renders its throne room at 96%, the fighting game 100%, all titles
boot with normal hash counts.

**No measurable gain.** Interleaved A/B on the same binary via `?disable=`:

| run | FastPS on | off |
| ---: | ---: | ---: |
| 1 | 35% | 31% |
| 2 | 33% | 34% |
| 3 | 26% | 26% |

Mean 31.3% vs 30.3%, against a within-config spread of 26-35%.

**The real blocker is now measurement, not optimisation.** ps ops were ~5% of
self time and specialisation removes only the generic dispatch around them, not
the arithmetic, so the expected effect is 1-2% -- far below a noise floor of
about +/-9 points. **No optimisation of that size can be validated on this rig.**

## The measurement rig: `tools/perf-ab.mjs`

Built 2026-08-31. Use it for every performance claim from now on.

```bash
node tools/perf-ab.mjs --filter "<title>"   --a "" --b "DISABLE=0x800000" --pairs 5
```

**Paired, not grouped.** A and B run back-to-back as a pair and are compared
WITHIN the pair; the median of those differences is the result. Session drift
moves both halves of a pair together and cancels. Group means do not have this
property, which is why the earlier A/B tables in this document were misleading.

**Alternating order** inside each pair, so cache warmth or thermal ramp cannot
bias one arm systematically.

**A verdict, not a number.** If the pairs disagree in sign it prints
`NOT RESOLVED` rather than a difference, so a 1-point median cannot be dressed
up as a win.

**Failed runs are discarded, never scored.** A mount failure previously read as
0% game speed, which would show as a 30-point regression. It now retries, then
drops the pair and says so.

Validated against the paired-single change (patch 0057): `NOT RESOLVED`,
matching the hand-run conclusion.

### Fixed-scene mode

`--save-state __race.sav` pins the workload so every run measures the same
frames, with input disabled and only the post-load tail scored. Pass the served
NAME, not a path.

The earlier `Save-state load failed: Failed to fetch` was not the server, the
COEP headers or the 44MB size -- all of which were suspected. Git Bash (MSYS)
rewrites a leading-slash argument into a Windows path before node sees it, so
`--save-state /__race.sav` arrived as
`C:/Program Files/Git/__race.sav` and the page dutifully failed to fetch
that. Proving it took reproducing the fetch inside the page, where all three
URLs including the 44MB state returned 200 -- which showed the problem was the
URL, not the fetching. The tool now builds the URL from `--base-url` and rejects
a local-looking path with an explanatory error.

Save states are build-specific. `window.__downloadSaveState()` in the devtools
console captures one from the current core; a state from an older core will
load-fail rather than fetch-fail.

## OLD NOTE: fix the measurement rig before optimising further

Required before any further perf work is meaningful:

- **Fixed scene.** Boot to a save state rather than a timed window, so the
  workload is identical run to run. `menu-progress-validate.mjs` already
  supports `SAVE_STATE_URL` / `SAVE_STATE_AT`.
- **Repeat and take the median**, not a single run.
- **Interleave A/B** on one binary via `?disable=`, never across builds or
  across time.
- **Report a spread**, not a point value.

Until that exists, only effects larger than ~10 points are real: the underclock
scaling (30/34/78%), the JIT warmup engagement change, and the action-adventure's
renderer difference (30 vs 79%).

## MEASUREMENT DRIFT -- read before comparing anything

Over one session the same titles measured 32-35% early and 27-28% late, on
byte-identical builds. Absolute numbers are only comparable within a
back-to-back A/B in the same session. Several hours of this plan's early
numbers cannot be compared to its later ones.

## 2. Ship the JIT warmup fix

**Hypothesis.** `jitwarmup` counts *stable video frames*, so at 20fps the JIT
engages ~35s in. It is specified in frames but behaves as a time delay that
scales inversely with how slow the game is — penalising exactly the titles that
need it.

**Evidence.** FPA, 50s run: warmup 700 gives 7 blocks compiled and 11
block runs; warmup 60 gives 1,356 compiled and 59.7M runs.

**Measured gain.** +2 points (FPA 34->36, action-adventure 24->26), 0 on RPG B.
Small but free.

**Test.** Full 45-disc sweep at the new default; confirm no title regresses and
watch for compile-burst stalls, which is what the long warmup was protecting
against. Check `presentationMaxIntervalMs` and the 0%-speed sample fraction.

**Success.** Mean speed up, no title down more than noise, no new stalls.

## 3. Why is JIT'd code barely faster than interpreting?

**Hypothesis.** Per-block overhead eats the win: WASM has no cross-module direct
jumps so every block returns to a dispatcher, and guest state is loaded and
stored per block (`stateu32:1238ld/753st`).

**Test.** From item 1's profile, split dispatch cost from block-body cost — the
`cpu-profile-analyze.mjs` tool was built for exactly this ratio and currently
reports `0 block modules` because the JIT was not engaged. Re-run it with
warmup 60 so blocks actually exist.

**Success.** A number: what fraction of emulation time is dispatch versus block
body. That ratio is the ceiling on block linking.

### Item 3 partial result (2026-09-07)

The test was blocked because the profiler set `jitwarmup=700`, so the JIT
compiled 63 blocks in the capture window and its bodies rounded to 0% -- the
`0 block modules` the plan records. At `jitwarmup=60` the same capture compiles
1,282 blocks and the emulation thread reports:

| bucket | share of emulation WASM time |
| --- | ---: |
| JIT'd block bodies (190 block modules) | **3.7%** |
| core module | 96.3% |

FPA measured 37% here against 32% in the warmup-700 capture, matching
the paired +3 in item 2.

**This is not a block-linking ceiling and must not be read as one.** The 96.3%
is not dispatch: it also holds the JIT helper callbacks compiled blocks call
out to, the cached-interpreter fallback for uncompiled blocks, the software
rasterizer, audio and DVD. Separating them needs function names, and the core
`.wasm` ships without a name section, so V8 reports bare `wasm-function[N]`.
The top frame is 27% of self time in one anonymous function.

### Item 3 ANSWERED (2026-09-07)

Rebuilt the core with `--profiling-funcs` added to
`target_link_options(dolphin_web_core ...)`, so the wasm carries a name section
and V8 reports real symbols. FPA, `jitwarmup=60`, 25s window, 1,282
blocks compiled, emulation thread:

| frame | self time |
| --- | ---: |
| `CachedInterpreter::ExecuteOneBlock(bool)` | 27.6% |
| `CachedInterpreter::FastInteger(...)` | 17.6% |
| **`JitBaseBlockCache::Dispatch()`** | **10.0%** |
| `TryFastRamWordLoadStore(...)` | 6.8% |
| `CachedInterpreter::FastPairedSingle(...)` | 3.6% |
| `TryFastRamByteHalfLoadStore(...)` | 3.2% |
| `PowerPC::MMU::WriteToHardware<...>` | 3.0% |
| `DolphinWeb_OnXfb` | 2.4% |
| `Helper_Quantize(...)` | 1.9% |
| `CachedInterpreter::RunWasmBlock(...)` | 1.4% |

Rolled up: cached interpreter about **50%**, memory helpers about **18%**,
dispatch **10%**, JIT'd block bodies **4.1%** (193 block modules).

**The answer: dispatch is 10%, so that is the ceiling on block linking.**
Perfect linking could recover at most a tenth of emulation time, and only if
linking itself were free. That is consistent with the gate that rejected block
chaining at a 3.7% projected ceiling, and it independently confirms the earlier
split measurement (interpreter 43%, dispatch 10%, JIT 4.6%) with names rather
than inference.

The real target remains the cached interpreter at half of all time.
`ExecuteOneBlock` plus `FastInteger` alone are 45%.

**Reproducing.** The flag is not shipped -- the core in `cores/` is the normal
build. Add `"--profiling-funcs"` to the link options (see
`docs/diagnostics/texsrc-instrumentation.patch`), rebuild `dolphin_web_core`,
run `npm run update:core-abi`, capture, then restore. `cpu-profile-capture` now
defaults to `jitwarmup=60`; at 700 it compiles 63 blocks and the split is
unmeasurable.

**Warning.** `G:\dolrecompwned\DolRecomp\docs\register-cache-design.md` records
**four reverted attempts** at promoting guest registers out of the state struct,
concluding it must not be retried until the state model and the emitter derive
from one shared description. Read it before proposing state promotion.

## 4. Finish the Wii rendering fix

**State.** The hardware renderer draws a Wii racing game correctly — the EFB holds
the right scene and the EFB->XFB copy is verified correct by paired readback.
The fault is in the XFB -> backbuffer blit.

**Lead.** #15: the XFB blit viewport is exactly half the source width
(`fbColor=47 vp=304x456` against a 608-wide target).

**Test.** Instrument the backbuffer blit's source rect and viewport; compare
against the XFB entry's dimensions. Then fix and verify by eye against the
software reference at the same screen.

**Success.** The Wii racing game renders its race scene on `video=wgpu`.

## 5. Sweep the untested configuration space

Single vs dual core, CPU overclock, frame queue depth, pacing mode, resolution
scale. Cheap. Expect mostly washes — but item 2 came from exactly this kind of
check, so it is not zero-value.

**Success.** Each knob has a measured effect on the slow tail, recorded here.

## 6. The two remaining renderer stubs

`WebGPU::TextureCache::CopyEFB` (EFB copy to RAM) and `WebGPUStagingTexture`
are both empty. Any game relying on EFB readback into guest RAM silently gets
nothing. Not yet tied to a specific broken title — do that first rather than
implementing blind.

## 7. Broken titles

A shooter at 0% and black; a survival-horror game black; a life-sim game
static on both paths (#11). Each needs its own diagnosis.

## 8. Wii Remote input

No Wii title is playable past its controller prompt. The Wii racing game accepts a
GameCube pad, which is why it could be driven at all; a Wii action-adventure
cannot.

## 9. Audio

Never measured in this session. Unknown whether it is correct or costly.

---

## Measurement blind spot

Game speed caps at 100%, so for the 13 fast titles a change cannot show as a
gain and only large regressions are visible. Any "no change" on those titles is
uninformative by construction — say so rather than reporting it as evidence.

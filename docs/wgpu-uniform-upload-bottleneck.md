# Hardware WebGPU on a Wii racing scene: where the missing performance is

Measured on a throughput branch, from main `5105474` (PR #19 merged).

    core sha256   650308c2c52fbf7fa9818cbe1fa27c2794ae31c5d0d56344533858a179f229e3
    vendor tree   37ed892e5367e448634807deef5f74fe66c1012f
    browser       Chrome 152.0.7977.83
    GPU           AMD Radeon RX 9070 XT
    CPU           Ryzen 9 9950X3D (16C/32T)
    fixture       __race.sav, SAVE_STATE_AT=0, INPUT_SCRIPT=none, 60 s
    query         video=wgpu&presenter=webgpu, no diagnostic flags

## Baseline

| | median speed | frames / 60 s | present fps | core fps |
| --- | ---: | ---: | ---: | ---: |
| hardware WebGPU | 46.0% | 1790 | 19.7 | 33.8 |
| software | 99% | 3597 | 54.0 | 59.8 |

Reproduced in two separate idle sessions (1825 and 1790 frames), so the
baseline is stable to about 2%. Frames advanced is quoted in preference to the
game-speed mean, which is skewed by start-up spikes.

## It is not CPU emulation

The software path reaches 59.8 core fps on the *same* cached interpreter and
the same WASM JIT. The hardware path drags the same emulation down to 33.8.
That is roughly 13 ms per frame of extra work on the emulation thread, and it
rules out "the CPU core is not fast enough" as the explanation.

## Stage costs

From the native phase timers (`?wgpuprodprofile=1&wgpudrawprofile=1`, which
themselves cost about four points, so this is a separate run from any
throughput number):

| stage | ms/frame | calls/frame | mean |
| --- | ---: | ---: | ---: |
| UniformPrepare | 5.42 | 514 | 10.55 us |
| CommandStage | 1.57 | 3423 | 0.46 us |
| DrawResources | 1.13 | 514 | 2.20 us |
| UploadCopy | 1.09 | 1846 | 0.59 us |
| RingPublish | 0.82 | 1924 | 0.43 us |
| BindResourceRecord | 0.82 | 1542 | 0.53 us |

Two phases are excluded from that ranking on purpose. `FifoDecode` (8.9
ms/frame) wraps the draw callbacks, so it double-counts every row above.
`FifoTailFlush` reports 526,054 calls per frame -- it is the dual-core idle
poll, and reading its estimated total as work gives 339 seconds inside a
60-second run.

## Root cause: the uniform blocks are ~24x larger than their changes

`?wgpuubometrics=1`, per class, over a 1611-frame window:

| class | uploads/frame | bytes uploaded each | bytes actually changed | waste | dirty ranges |
| --- | ---: | ---: | ---: | ---: | ---: |
| VS | 361 | 4112 | 172 | **23.9x** | 4.0 |
| PS | 233 | 1024 | 95 | 10.7x | 3.9 |
| GS | 2 | 256 | 15 | 17.3x | 0.9 |

`VertexShaderConstants` is 4112 bytes, and its three largest members --
`transformmatrices` (1 KiB), `posttransformmatrices` (1 KiB) and
`normalmatrices` (512 B), 2560 of the 4112 -- are exactly the parts that do not
change between draws within a frame. Over the run the VS class alone moves
**2.39 GB to convey 0.100 GB of change**.

That is what saturates the upload arena: 242 wraps, ~800 waits, 2.1 s blocked,
125 ms worst single stall, 32 MiB high-water on a 32 MiB arena. The command
ring, by contrast, never waits once.

The UBO slice cache cannot fix it: the VS hit rate is 8.3%. The Wii racing game
really does change its constants nearly every draw. It just changes very
little of them.

## What the existing knobs do

Clean interleaved runs, machine idle, two reps each against an adjacent
control (60 s each):

| knob | frames | delta |
| --- | ---: | ---: |
| control | 1790 | -- |
| `wgpuubocache=1` | 1869 | +4.4% |
| `wgpuuploadmb=128` | 1799 | +0.5% |
| `wgpuuniformfast=1` | 1765 | -1.4% |
| `wgpustatecache=1` | 1767 | -1.3% |

None of them is the fix, and two of them cannot be by construction:

- `WebGpuUniformFastPath::Plan` only skips the whole-block *comparison* when
  the draw is going to publish a slice anyway. It never reduces upload volume.
- `wgpuubocache` deduplicates whole slices, and at an 8.3% VS hit rate there
  are few duplicates to find.

The `wgpuubocache` result of +4.4% overlaps the control spread at n=2 and
should not be read as a win without more repetitions.

## Sparse UBO copy-forward acts one layer too late

`src/wgpu-sparse-ubo-copy-forward.js` uploads only the dirty 16-byte ranges of
a constant block, and its class spec even names the right number (`vs: 4112`).
It looked like the answer. It is not, and the reason is structural rather than
a tuning problem.

    ensureWgpuSparseUbo(dev)?.stage({ pool, data, destination: buf, ... })

`data` there is the payload **after** it has already crossed from the WASM heap
into the upload arena. The module reduces the device-side staging write; the
2.39 GB that saturates the arena is produced upstream of it, by
`WebGPUGfx::AllocUboSlice` calling `UploadAlloc(data, size, 16)` with the full
4112 bytes.

Measured, interleaved (this batch ran under external CPU load, so read only the
within-batch deltas):

| configuration | frames | delta | upload wait |
| --- | ---: | ---: | ---: |
| control | 1643 | -- | 2.77 s |
| `wgpuuploadtransport=mapped` | 1406 | -14.5% | 7.19 s |
| `+ wgpuubosparse=1` | 1399 | -14.9% | 7.67 s |
| `+ wgpuubocache=1` | 1377 | -16.2% | 6.57 s |

Sparse adds nothing over the mapped transport it requires, and the arena wait
does not fall -- which is the signature of a change that never touched the
arena. The mapped transport is itself a 14.5% regression on this workload.

## The knobs do nothing, and the benchmark cannot see small effects

Three reps each, idle machine, interleaved, 60 s runs. Medians, because one
control run was an outlier:

| config | median frames | delta |
| --- | ---: | ---: |
| control | 1788 | -- |
| `wgpuubopack=1` | 1806 | +1.0% |
| `wgpugeompack=1` | 1789 | +0.1% |
| `wgpugeompack=1&wgpugeomrange=1` | 1792 | +0.2% |
| `wgpuubocache=1` | 1787 | -0.1% |

Every one of them is nothing. That includes `wgpuubocache`, which read +4.4% at
two reps in the previous batch -- that signal was noise, and acting on it would
have been a mistake.

The reason the earlier readings looked meaningful is the more important result
here. The three control runs alone were **2059, 1788, 1785**: a standard
deviation of 8.4%, which puts the smallest reliably detectable effect at n=3 at
roughly **17%**.

Within-round deltas show where that comes from:

    round1 ctl=2059 : ubopack -12.9%  geompack -13.1%  geomboth -13.0%  ubocache -13.2%
    round2 ctl=1788 : ubopack  +1.0%  geompack  -4.1%  geomboth  -0.1%  ubocache  -0.2%
    round3 ctl=1785 : ubopack  +8.3%  geompack  +0.4%  geomboth  +1.1%  ubocache +12.4%

Round 1 is not a knob effect. Its control is 15% above the other two, and every
arm in that round is dragged down against it. The control ran first in every
round, so the first run of a session -- cold browser, cold GPU, cold JIT cache
in a fresh profile -- is systematically favoured, and the bias lands entirely on
the control arm.

**No optimization worth less than about 17% can be evaluated on this fixture as
it stands.** That is the finding that matters most, because it applies to every
change anyone tries next, not just these five.

## Recommended next step

Harden the benchmark before optimizing anything further. The 8.4% control
spread has identifiable causes: every run launches a cold browser with a fresh
profile, so the JIT cache never warms; the first run of a session is
consistently fastest; and the control always ran first. Discarding the first
run, randomizing arm order, running longer than 60 s, and using
`PROBE_PERSIST_DIR` so the JIT cache is warm should each shrink it. Until the
floor is well under the effects being chased, optimization work cannot be
told apart from noise.

The uniform path is still the largest identified cost, and the shape of the fix
is unchanged: make the *producer* upload only dirty ranges. The shadow copies that
`PrepareDrawResources` already maintains (`m_vs_shadow`, `m_ps_shadow`,
`m_gs_shadow`) contain everything needed to compute them; the block is already
compared against them with `memcmp` on every draw, so the comparison is paid
for already and only the range bookkeeping is new.

Because slices are bump-allocated fresh, a partial write needs the previous
slice contents carried into the new one first, so this is a copy-forward on the
device plus small dirty-range uploads -- the same shape as the JS module, moved
to the layer where the traffic actually is. That is a native change and a core
rebuild.

### Revised estimate: do not build this yet

Working the design through dropped the expected payoff far enough that it is no
longer the right next move.

Two things emerged. First, `VertexShaderManager` exposes a single `bool dirty`
for the whole block, with no per-group flags, so finding the dirty range means
scanning all 4112 bytes -- which **loses the early exit `memcmp` already gets**.
That is added cost, not saved cost. Second, the shadow copy still has to happen
for the next comparison. So per changed VS draw:

| | today | with dirty ranges |
| --- | ---: | ---: |
| compare | partial, early-exit | full 4112 scan |
| memcpy to shadow | 4112 | 4112 |
| memcpy to arena | 4112 | ~866 |
| copy traffic | 8224 B | ~4978 B |
| extra encoder commands | 0 | 2 per draw |

About 1.17 MB/frame less memcpy, call it 1.06 ms on a 33 ms frame, ~3.2% --
then give back the full scan and roughly 722 extra encoder calls a frame. Net
1-2.5%, plausibly negative.

The arena relief was also overstated above: uniforms are only about 2.8 GB of
the 7.75 GB crossing the arena, and the total stall is 2.1 s in 60 s, so
removing it entirely is worth ~3.5%.

There is also a correctness constraint that makes it a bigger change than it
looks. The unchanged bytes exist only in the previous slice on the GPU, so
carrying them forward is a device-side `copyBufferToBuffer`. But uniform
uploads on the default transport go through `queue.writeBuffer`, which lands on
the queue timeline **before** the render encoder is submitted -- so a
copy-forward inside that encoder would execute after every write of the frame
and silently clobber them. Doing it correctly needs the dirty bytes staged into
a device buffer and both copies issued inside the encoder: a new opcode, a
staging ring, and changes on both sides of the protocol.

Against a 17% detection floor, a 1-2.5% change cannot be validated at all. Fix
the benchmark first.

## Measurement notes

Two batches were discarded during this work. The first eight-knob sweep ran
while an unrelated 16-core job shared the machine; an identical control re-run
afterwards fell from 46% to 39% with arena stalls rising 2.1 s -> 3.5 s, which
is larger than every effect being measured. A second batch overlapped two
emulator instances.

Every number kept here comes from runs that were interleaved with an adjacent
control, so shared load biases both arms equally. On a machine that other work
shares, only within-batch deltas mean anything, and absolute numbers between
batches do not compare.

## Result: the producer-side dirty-range upload was built, and it is worth nothing

It was built anyway, because "do not build this yet" rested on an estimate and
the benchmark had since been hardened enough to test it.

    rig           RTX 3090, Ryzen, Chromium 145, ANGLE Vulkan
    fixture       __race.sav, SAVE_STATE_AT=0, INPUT_SCRIPT=none, 40 s
    arms          control vs WGPUUBODELTA=1, 6 pairs, 4 warmups discarded

| | median frames/60 s | spread |
| --- | ---: | --- |
| A (control) | 1440.0 | 1402.3-1450.3 |
| B (delta) | 1438.2 | 1411.8-1455.5 |

Paired difference **+0.8 frames/60 s (+0.1%)**, range -18.9..+22.3, with the
six pairs disagreeing in sign three to three. The rig resolves +/-1.4% at six
pairs, so the verdict is NOT RESOLVED: the effect is smaller than the smallest
thing this fixture can see.

The important part is that this is not a failure to engage. The B arm moved
**199 MB of uniform payload in 25 s where the full-upload path moves roughly
1.5 GB** -- about a 7.5x cut in exactly the traffic that was named as the
bottleneck -- with zero validation errors and a correct picture. The dirty-range
upload did what it was designed to do, and throughput did not move.

So the 2.39 GB of uniform over-upload is real, and it is not what limits this
workload. Removing it buys nothing measurable. The remaining sections above
that treat arena volume as the thing to attack should be read with that in
mind: the next candidate has to come from somewhere other than upload volume.

### Getting a hardware adapter on the Linux rig

Chromium 145 blocklists the 3090, and the documented `--use-angle=vulkan` is no
longer sufficient on its own -- a run still completes and still reports
numbers, they are just SwiftShader ones.

| flags | adapter |
| --- | --- |
| `--use-angle=vulkan --ignore-gpu-blocklist` | nvidia / ampere |
| `--ignore-gpu-blocklist` alone | google / swiftshader |
| `--use-angle=vulkan` alone | google / swiftshader |

Both are needed, and `--expect-adapter nvidia` should be passed on every run so
a silent fallback is discarded rather than averaged in.

## Second pass: what actually binds, measured with a sampling profiler

The phase timers above cost about four points to run, which means they
distort what they measure and can only rank what someone thought to
instrument. A V8 sampling profile needs neither. Two findings came out of it,
and between them they overturn most of this report.

### The benchmark was measuring the emulator plus a debug dump

`vpDiagNoteUpload` and `vpDiagNotePsUpload`, left over from the PR #19
black-3D-models hunt, built string keys out of float arrays -- sixteen
`toFixed(3)` values joined -- on **every** uniform upload, several hundred
times a frame. They ran unconditionally for the first 6000 presents, about
five minutes on the hardware path. Every run in this document was measured
with them on.

Twelve pairs on the RTX 3090 rig, dump on versus off:

| | median frames/60 s | min | max | CV |
| --- | ---: | ---: | ---: | ---: |
| dump on | 1377.5 | 614.1 | 1432.9 | 19.1% |
| dump off | 1428.0 | 1141.7 | 1474.2 | **6.6%** |

Median difference **+4.6%**, eleven of twelve pairs positive, sign test
**p = 0.0032**.

The throughput is the smaller half of it. The dump nearly **tripled**
run-to-run variance, and its bad runs are collapses rather than slowdowns --
614 frames against a 1428 median. That is the "8.4% control spread" and the
"settling transient" this report spent so long characterising and working
around: a large part of the instability being measured was in the product,
not the rig.

`perf-ab` still reports NOT RESOLVED, because its rule requires every pair to
agree in sign and one pair came in at -0.8%. With eleven of twelve positive
that rule is the wrong test; the sign test is the right one. The resolution
figure is also inflated by two one-sided outliers (+49%, +86%), which is what
a heavy tail does to a spread-based estimate.

### The GPU thread is not rendering, it is spinning

With `PROFILING_FUNCS=1` actually wired up (it passed a `-D` nothing read, so
it had always silently produced `wasm-function[N]`), the video thread reads:

| | share of the video thread |
| --- | ---: |
| `CommandProcessor::CommandProcessorManager::SetCPStatusFromGPU()` | **35.0%** |
| the video thread's own loop body | 23.9% |
| `_do_futex_wait` | 15.3% |
| `AsyncRequests::PullEvents()` | 2.6% |
| `VertexManagerBase::Flush()` | 2.9% |
| `VertexLoaderManager::RunVertices` | 2.5% |
| `WebGPUGfx::PrepareDrawResources()` | 0.6% |

About **three quarters of that thread is command-processor status and waiting,
and under nine percent is rendering**. The WebGPU producer work this report
spent its length attacking is 0.6%.

That is why the dirty-range upload changed nothing, and why none of the knobs
moved: upload volume was never the constraint. It also fits the 526,054
`FifoTailFlush` calls per frame dismissed earlier as "the dual-core idle poll"
-- that poll is the cost, not an artefact of the timer.

**The next candidate is `SetCPStatusFromGPU` call frequency**, not anything in
the upload path.

## Memoising SetCPStatusFromGPU does not work either

The obvious move on a function that is 35% of a thread and recomputes the same
answer half a million times a frame is to skip the recomputation. Every input
the body reads was captured and compared against the previous evaluation, with
the read pointer and breakpoint address only entering the comparison when
breakpoints are enabled, so the skip is exact rather than approximate.

Measured by swapping the two cores between paired runs -- the change is in the
core binary and no runtime flag selects it, so the arms are the shipped
artifacts. Eight pairs a side, backend guarded, warmups discarded:

| rig | A median | B median | median delta | positive | two-tailed sign |
| --- | ---: | ---: | ---: | ---: | ---: |
| Radeon RX 9070 XT | 2105.7 | 2068.9 | **-2.90%** | 3/8 | p = 0.73 |
| RTX 3090 | 1452.2 | 1464.0 | **+0.69%** | 7/8 | p = 0.07 |

Nothing on one rig, slightly negative on the other, marginal at best on the
second. It was reverted.

The reason is that the memo attacks the wrong half of the cost. It replaces
about fifteen relaxed atomic loads and two stores with about fourteen relaxed
atomic loads and a comparison; the per-call cost barely moves and **the call
count does not move at all**. At roughly seventeen million calls a second the
cost is the frequency, not redundant work inside. Anything that helps here has
to change how often the FIFO drain loop calls it -- which means touching
watermark-interrupt timing, a real correctness risk, for a ceiling that is
still only that 35%.

### A confound worth recording

A single run of the memoised core read 66% game speed against 47% for a run of
the previous one, which looked like a large win and was not one: the 47% run
predated gating the viewport dump and the 66% run followed it. The whole
difference was the dump. Two changes had landed between those runs and only
the paired A/B, which holds one of them fixed, separated them.

The same trap is visible in the numbers above. The A arm here is the core this
report measured at 1790 frames/60s, and it now reads about 2106 on the same
rig -- the dump again, not the core. The scoring windows differ, so treat that
as indicative rather than a measurement, but the direction matches the paired
result.

## Calling it less often does not work either, and that closes the line

The memo failed because it cut the cost of the call and not the count. So the
count was cut: within the drain loop the read-write distance only falls, so
each watermark boundary is crossed at most once and can be detected from the
value `fetch_sub` already returned -- no extra shared load. Breakpoints keep
the old per-chunk behaviour, a 64-chunk ceiling bounds how long a register
write from the CPU thread can go unnoticed, and the unconditional call after
the loop is untouched. Roughly a sixty-fold reduction in calls.

Eight pairs a side again, cores swapped between runs:

| rig | A median | B median | median delta | positive | two-tailed sign |
| --- | ---: | ---: | ---: | ---: | ---: |
| Radeon RX 9070 XT | 2035.4 | 2070.3 | -1.71% | 3/8 | p = 0.73 |
| RTX 3090 | 1305.2 | 1300.3 | -0.37% | 4/8 | p = 1.00 |

Nothing, on either rig. Both sessions were noisier than earlier batches --
look at the A spreads -- but pairing absorbs that, and two independent nulls
at eight pairs each is not a resolution problem.

That result also disposes of the mechanism that motivated it. If the video
thread's atomic traffic on the shared FIFO cache lines had been slowing the
CPU thread, cutting that traffic sixty-fold would have shown something.

### Why the whole line was a dead end

The thread that matters is the one with no slack, and it is not the video
thread:

| thread | idle | blocked (futex) |
| --- | ---: | ---: |
| video thread | 0.0% | 15.3% |
| CPU emulation thread | 0.0% | **0.1%** |
| consumer (discio) | 42.0% | 0.0% |

The CPU emulation thread is saturated and essentially never blocks, so it sets
the pace. `SetCPStatusFromGPU` is 35% of a thread that is *not* on the
critical path, and 35% of slack is worth nothing -- which is what both attacks
measured. The profile said "35% of a thread" and that was read as "35% of the
frame"; they are only the same thing on the critical path.

## Where this leaves the Wii racing game

The renderer is no longer what limits this title. What is left on the critical
path is PPC emulation:

| | share of the CPU thread |
| --- | ---: |
| `CachedInterpreter::ExecuteOneBlock` | 23.0% |
| `CachedInterpreter::FastInteger` | 20.5% |
| `JitBaseBlockCache::Dispatch` | 10.9% |
| `TryFastRamWordLoadStore` | 8.9% |
| `PowerPC::MMU::WriteToHardware` | 5.1% |
| `DolphinWeb_OnXfb` | 4.3% |

About 54% is interpreter dispatch machinery, and the profile reports no
separate JIT block modules at all -- the WASM JIT is contributing nothing to
this workload. That is the ratio `tools/cpu-profile-capture.mjs` was written
to measure, and it is a CPU-side question, not a renderer one.

Three renderer-side changes were built and measured during this work and all
three were reverted. The one thing that did move throughput was deleting
debug instrumentation from the hot path.

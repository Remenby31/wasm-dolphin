# Region translator (P4, patch 0075)

The JIT side of the region recompiler: one WASM function body ("fragment")
per function of the compilation plan, which the region assembler
(`src/aot-region-module.js`) links into a region module. The interface is in
the P4 section of the plan; this note is how the translator meets it.

## Fragment

`(param i32 state) (result i32)`, the block type. Returned to
`RunWasmRegion`:

| value | meaning |
| --- | --- |
| 0 | continue at `state.pc`: state flushed, downcount accounted |
| 1 | `state.pc` is not an entry of the region: nothing executed |
| 2 | halted: exception vectored, helper stop, invalidation |

Shape:

```
(local ...)                       ; union of the block emitter's locals
loop $dispatch
  ; entry dispatch on state.pc: a chain of compares over the fragment's
  ; declared entries (function entry, extra entries, returns after an
  ; internal bl), each `br`-ing to its block's label; no match -> return 1
  block $b0 ... block $bN
    ...
  end
  ; block k body, emitted by the block emitter in fragment mode
  ; block end: pc = npc, downcount -= cycles(k)
  ;   downcount <= 0           -> return 0
  ;   next pc is in this fragment -> br $dispatch
  ;   direct b/bl to another function -> reloc `jump` (return_call)
  ;   blr / bctr / bctrl         -> reloc `dispatch` (return_call)
end
```

The entry dispatch is a compare chain first (fragments are functions, a few
to a few dozen blocks); a `br_table` over a dense remap comes later if
profiles show it matters.

## Block emitter in fragment mode

The block emitter builds one module per block today. In fragment mode
(a `WasmFragmentRelocs` collector installed):

- helper calls carry a 5-byte LEB index and a reloc by name (done, step 1);
- a block's early exits, which return 1 ("halted") to `RunWasmBlock` today,
  return 2 instead: the region convention;
- the tail that `RunWasmBlock` does in C++ for a completed block
  (`pc = npc`, downcount, performance monitor) is emitted in WASM;
- locals are the fixed groups the emitter already declares, so every block
  of a fragment shares one declaration.

Block bytes outside fragment mode stay identical (cache keys unchanged);
the oracle tests and the homebrew fuzz check it at every step.

## Steps

1. Helper call relocs and the state layout export. Done.
2. Fragment mode in the block emitter: early exits return 2, the completed
   block tail in WASM (pc = npc, downcount -= the block's cycles; the
   performance monitor is not updated yet). `_DolphinWeb_AotTranslateForTest`
   returns the block at an entry as `{entry, entries: [entry], code, relocs}`.
   `tests/aot-region-core.test.mjs` runs the N-slice equivalence on the core:
   per plan function, the block at its entry is a fragment, regions are
   assembled by `src/aot-region-module.js`, compiled and run by the core with
   its real helpers, and the full oracle state and all of RAM must match the
   interpreter (downcount included; a call that does not return within its
   cycle budget is compared at the downcount where the regions ran out, one
   that ends in an exception at the exception). Test exports:
   `DolphinWeb_AotTestSetUp`, `AotTestRam`, `AotTestReset`, `AotTestState`,
   `AotTestInterpretOne`, `AotRunRegionForTest`, `JitHelperName`,
   `AotTestStackPointer`/`StackRestore` (after a trap). Done.
3. A function per fragment: the blocks reachable from its entry through
   static successors inside its plan ranges (at most 64), each block start an
   entry (return points after a `bl` included). Discovery resumes after an
   instruction the direct tier does not take (it runs outside the region,
   which picks up again after it). The fragment is a loop over a compare
   chain on state.pc; after a block: pc = npc, downcount -= cycles, return 0
   once downcount <= 0, a closing b/bl to a PC outside the fragment leaves
   through a `jump` reloc, anything else goes round the loop; a PC the
   fragment does not hold leaves through the `dispatch` reloc. A region
   holding several functions declares each PC once (first fragment wins).
   Done. cpufuzz, 12 seeds: 0 mismatch, 44-55 % of guest cycles in regions
   (2 % with the entry block alone).

   Found on the way, block JIT: the inline `mtmsr` applied MSR without taking
   exceptions held pending or the FP exception FE0/FE1 enable, which
   `Interpreter::mtmsr` and `FastMtmsr` take at once. It now leaves to the
   system helper when one is pending (oracle test).
4. Oracle region mode (`tests/aot-region-oracle.test.mjs`): the oracle's random
   programs as one fragment each, from its random states, with a full and a
   small cycle budget (the region stops between blocks with downcount below
   0; the interpreter is compared at that downcount). A cut prefix is
   analysed alone: whole-block analysis let an op skip FPRF/CR/GPR state a
   later op past the cut overwrites, visible at a region block boundary.
   800 programs, 1 218 runs (DSI, FP program exceptions and downcount exits
   in the middle of regions), 0 mismatch. Done. `icbi` invalidation of
   region code is step 5's (the dispatcher owns region lifetimes).
5. Regions in the dispatcher. `DolphinWeb_AotQueueRegion(bytes, entries,
   ranges, members)` from any thread, which also hashes the bytes (their
   module-cache key); the CPU thread maps queued modules at a slice boundary
   (during the first 3 s, slices of up to 8 ms; then up to 8 per slice while
   the estimate, size x the measured cost per byte, stays under 2.5 ms; a region with an entry HLE hooks, or whose code no
   longer matches the plan's hashes, is left out). With `jitoffthread=1` it
   never compiles one cold: a module not handed over before the boot is
   asked for with a compile request (no bytes: discio holds the Module under
   the key), and the region is installed once the
   worker set its ready byte, its synchronous compile then a hit in V8's
   native module cache (the block JIT runs the code meanwhile; a request
   never answered compiles synchronously after 5 s, counted as
   `installFallbacks`; the first 256 installs are sampled, time, size and
   path, in `DolphinWeb_JitRegionInstallSamples`, read with the stats). `ExecuteOneBlock` runs the region holding the pc before looking for
   a block, with translation and FP on only; block chaining stops at a
   region entry. `JitInterface::InvalidateICache(Line)` drops the regions
   covering the code (a page map rejects the rest in one lookup);
   `ClearCache` has them hashed again before they next run. On with `aot=1`, their only producer
   (`wasmjit` already carries 0/1/2). Stats: `DolphinWeb_JitRegionStats`,
   layout v1 agreed with the harness (88 bytes, off until enabled). Tests:
   `tests/aot-region-dispatch.test.mjs`. Done; the live check needs P7.
6. The FP analyses over a region, each behind its own flag.

## Open follow-ups (review of #43)

The three P1s and the trivial P2s are fixed in #43; the rest is tracked here.

- [ ] **Translator off the CPU thread reads CPU-thread state**: `Analyze` consults `HLE::TryReplaceFunction(symbol_db)`, `GetMode()` and breakpoints unsynchronised. Give the translator its own read-only view (or snapshot them on the CPU thread).
- [ ] **Analyzer options**: the translator's `PPCAnalyzer` does not take the JIT's options (e.g. DivByZeroExceptions, set by 2 game INIs), and they are not in the region cache key. Mirror the JIT's options and add them to `codegenMask`.
- [ ] **Emit diagnostics counters** (`s_wasm_emit_*`, `s_fmh_*`, `s_wasm_emit_fail_*`) are incremented by the translator and the CPU thread at once: thread_local or atomic.
- [ ] **Return code 1 after a mid-region `dispatch` exit** (an op outside the tier at `resume_pc`): code already ran, 1 claims nothing did. Harmless today; it skews `regionNotEntry`.
- [ ] **DropRegion rebuilds the entry filter** from ~135k entries per dropped region: O(N·135k) for a wide invalidation. Rebuild once per invalidation; free dropped handles; clear regions and the queue on shutdown.
- [ ] **Shared entry not remapped** when the first region holding it is dropped (speed only).
- [ ] **Oracle region mode forces `Exceptions=0`** at entry: no pending exception enters a region in the tests. Add cases.
- [ ] **No oracle case for icbi on the running region** (only lane 10 covers it).
- [ ] **Time shares**: validate the sampled shares against a V8 CPU profile once (< 5 points).
- [ ] **FP analyses over a region** (known-single, FPRF once per region, FPSCR in a local), each behind its own flag with oracle + race-perf pair (plan P4, next PR).
- [ ] **Flag name**: plan says `wasmjit=region`, shipped as `aot=1`; `docs/jit-flags.md` not updated.
- [ ] **One compiler worker**: blocks and regions not in the module map share a single worker, FIFO. Regions never queue there today (their live Module is in the map under their bytes' key), but a full map (49 152 entries) would send them behind every block. A second worker, or a priority lane for regions already hit, needs the client's watchdog and stats per worker: not trivial.
- [ ] **Bimodal hitch bursts on main** (not P4, found while reviewing #37): in about one race-perf run in six, on main as on a candidate, single dropped frames (36–47 ms) every ~20 VI in two segments of the race savestate (viSinceLoad ~1370–1720 and ~1920–2090); the other runs have 0–2. Measures: `measures/jit-robustness/race-perf/p37-review-vs-main-1300` and `p37-hitches-1500` (`cold.hitchList`). Next: `--pcsample` restricted to those VI ranges, runs with and without a burst compared (after #43).
- [x] **Late ready signal on the last region** (pair 16:00): a state load (`ClearCache`) zeroed the ready table and forgot the requests in flight; a mark that landed before it was lost and the region waited out the 5 s. Waiting regions now ask again after a cache clear. (#58; review: the re-post goes through the plan-hash and HLE checks and the slice budget, region posts also mark the request table for reset, and a region whose code is invalidated while it waits is dropped.)

### From the final review of #43 (P2)

- [ ] **Cold compile counted as Ready**: a ready byte set by another key of the slot, or a full module map, makes the CPU thread's compile of a region a cold one while `InstallPath::Ready` is recorded. Check the pthread's map before trusting the byte; count such installs apart.
- [ ] **Budget escapes**: the first module of a slice and the fallback compile are never refused by the slice budget. Bound both (defer a module whose estimate alone exceeds the slice target to a slice with nothing else).
- [ ] **Boot window on a first launch**: the 3 s window starts at the first install, which on a first launch (regions from the optimisation, minutes in) falls in the middle of play. Open it only for installs that come from the cache before the first image.
- [ ] **Hand-over before boot races**: `retain` does not receive the bytes, so the region's byte key is registered by an async digest that may land after the pthread barrier. Pass the bytes (or the key) to `retain` and await it before the barrier.
- [ ] **Modules kept for the session**: every region Module stays alive in discio's map (127 MB of wire bytes for MKDD) for the whole session. Release a region's Module once installed on every pthread, or cap by bytes.

Order after #43 (Main, 2026-10-20): TTFF aot=1 vs off on main; the late ready signal; the FP analyses; the dispatch share (22 % of host time).
- [ ] **Orphan request after a late mark** (review of #58, P3): when discio marks an old request after a cache clear but before the re-post, the region installs synchronously with the in-flight key still set, and the re-post's answer later leaves a stale 1 in the slot; a block sharing it compiles cold once. Same family as "Cold compile counted as Ready".

## Function names (2026-10-22)

A region module carries a `name` section: the module is `r<lowest entry PC>`,
its functions `r<id>_dispatch`, `r<id>_inner`, `r<id>_exit` and
`r<id>_f<entry PC>` per fragment (8 hex digits each). Profiles (V8's
DevTools profiles, perf maps, jitdump) then show which region and which
guest function runs instead of `wasm-function[N]`. V8's code generation
ignores the section; the cache key holds the members, not the bytes, so a
module cached before it is still used (without names). `names: false` in
`assembleRegion` leaves it out.

## Heap layout guard (patch 0078, 2026-10-21)

Region code, like block code, embeds absolute addresses of the core's heap:
the emulated RAM and L1 (`WasmStateLayout.ram_base`, `l1_base`, read by the
fastmem paths). A block is regenerated live and keyed by the SHA-256 of its
bytes, so a moved RAM is a cache miss; a region is translated once and kept.
On a second launch with `aot=1`, P7 queued every cached region before the
boot: 127 MB copied into the core's heap before the core allocated the
emulated RAM, which then sat elsewhere. The cached regions read and wrote the
old address; the game diverged (a loop of "Invalid read" at frame ~130, a
million console lines, the browser process at 7-14 GB).

- `DolphinWeb_AotTranslate`'s sixth word is `WasmLayoutHash` of the layout
  the code was emitted for (every field: offsets and the RAM/L1 addresses);
  the region module carries it in a `region-layout` custom section.
- `DolphinWeb_AotQueueRegion` takes it (ninth argument); the install refuses
  a region whose layout differs from the session's, or that has none
  (`DolphinWeb_AotLayoutRefused` counts them). Compiler version 2: modules of
  version 1 have no layout.
  `DolphinWeb_AotLayoutWords` returns the layout's fields (which one moved).
- Checked live (2026-10-21, 3 relaunches of a seeded profile): 143 regions
  installed from the cache, 0 "Invalid read", ~6 900 frames in 40 s, peak
  3.9 GB. One earlier relaunch found the RAM elsewhere (all 143 refused, the
  game correct and slower): the heap is not always laid out the same, which
  is what position-independent code removes.
- Discio copies no region into the core's heap before the core has
  allocated the emulated RAM (`DolphinWeb_AotRamReady`, polled after the boot
  is submitted), and none whose layout already differs from the core's
  (counted with the core's refusals as `layoutRefused`).
- Installed regions keep their layout: a cache clear (a new boot) has them
  checked again, layout included, before they run; `CachedInterpreter::Shutdown`
  forgets every region, installed, waiting or queued (review of #62).
- After a refusal the session runs without those regions and nothing
  retranslates them: the cache keeps its modules, a relaunch under the same
  moved layout refuses again (counted per launch). The code's other absolute
  address, the `frsqrte_expected` table, is static data of the binary,
  covered by the core hash in the cache identity.
- Lane 11 of P4/P7 (`harness/probes/aot-second-launch.mjs`): seed, then launch
  again on the seed's origin (checked); pass when modules came from the
  region cache and were installed, 0 "Invalid read"; `refused-layout` (the
  heap moved, the game still correct) is told apart.
- [ ] **Retranslate after a layout refusal**: compare a cached module's
  layout with the core's once the RAM exists, mark the key not done, translate
  it again and overwrite the entry (review of #62, P1-3).
- [x] **Position-independent region code** (patch 0084): the machine code
  is main's (`i32.const base; offset; i32.add`), but the `i32.const` of each
  RAM or L1 base is a 5-byte padded signed LEB listed as a heap site (reloc
  kind 3; the module's `region-heap` section: the bases it holds and its
  sites, each with its form, `const` or a memarg `offset`). Discio patches a
  cached module's sites to this session's bases (`patchRegionHeap`) and
  compiles the patched bytes off the CPU thread before it queues them;
  `DolphinWeb_AotQueueRegion` takes the bases the sites hold, and the core
  refuses a region whose bases are not this session's, at install and when an
  installed one is checked again (a RAM allocated again under it, #62 P1-1).
  `WasmLayoutHash` leaves the two addresses out; the other fields stay
  guarded. Block modules are unchanged. Compiler version: 3 was reserved for
  0084; 0087 (merged first) bumps it to 5, which covers it.
  Measured on the race with aot=1 (Spark pairs) before this form: imported
  globals −0.8 %, locals copied at fragment entry −0.6 %, the base folded into
  the memarg offset −1.3 % (ARM rematerialises a large offset at every
  access; the `offset` form is kept for x64, where it folds into the
  addressing mode, untested without an x86 machine).
  Discio queues a module with the bases its final bytes hold (none without a
  section, which the core refuses), and the core checks the module's own
  `region-heap` section and every site against this session's bases. When the
  heap moved, the cache loader's compile of each unpatched module is thrown
  away: counted with the patched ones (`heapPatched`, `heapPatchedBytes`,
  `heapPatchFailed` in the region stats reply), up to the whole cache.
  Tests: a module patched for another heap runs there; a module with another
  session's bases is refused, and runs once patched back; a module without
  its section, with a site changed, or whose section claims other bases is
  refused by the core; a malformed section throws; the RAM moved under
  an installed region drops it; every fragment site holds the base, and no
  immediate holds a heap address outside the sites.
- [x] **35 regions dropped on every second launch** (KPI, d18249e, and locally): installed during the OS init, they were dropped by invalidations (icbi or DMA) over their ranges, and the code then ran in the block JIT for the session. Patch 0085: an invalidation over an installed region marks it unverified instead; before it next runs it is checked against the plan's hashes (as after a cache clear), and dropped only if its code changed. A region with a member that has no hash, or an HLE hook installed at an entry since, is dropped (a hook changes no byte); a forced invalidation (breakpoints) drops at once, as before; a region already due for a check is skipped by later invalidations. `DolphinWeb_AotRegionRechecks` counts the regions kept for a check, the checks passed and the regions invalidations looked at.
- [ ] **Second-launch TTFF +0.8 s** (first core frame 1.55 s against 0.72 s cold): the region cache read and compiled before the boot (`installBeforeBoot`). Load fewer modules before the boot, the rest after (target 10 s, today 2.05 s).

## MMU mode (patch 0091, with dispatch's 0090, 2026-10-22)

Under the MMU (bMMU, set by a game's INI) no wasm code of ours runs. The
slow paths of the emitter's loads and stores (the `read_u32` ... `write_u16`
helpers) take a DSI and go on with 0. The block JIT already refuses every
block when `jo.memcheck` is set, which the MMU mode sets
(`TryWriteWasmBlock`). Regions now do the same: the translator refuses
(`BuildRegionFragment`), and so does the install, even for a region from the
cache translated in a session without the MMU (`RegionInstallable`,
counted by `DolphinWeb_AotRegionsSkippedMmu`). MMU games keep the
CachedInterpreter with `aot=1`. Lifted once faults are delivered from our
code (deferred delivery on the slow paths: backlog).

## Memory-access counts (patch 0104, 2026-10-22)

`DolphinWeb_MemAccessStats(reset)` returns a 192-byte struct, layout v1
agreed with the harness (`race-perf --mem-stats`): guest instructions,
memory instructions by kind (integer, FP and paired-quantized loads and
stores), slow accesses by kind, `cyclesCovered`/`cyclesTotal`, the regions'
estimates and `staticSaturations`. `reset >= 0` zeroes it and turns counting
on at the next slice boundary; the CPU thread writes the struct whole at each
boundary, so read it twice.

- **Blocks**: every block end (`EndBlock`, a `RunWasmBlock` that ends its
  block) carries an index into interned static counts taken where its
  downcount is, so the counts and the cycles they cover agree. Executions
  that leave a block early (an exception, a halted wasm block) are not
  counted and show in `cyclesCovered`.
- **Slow accesses**: served by Dolphin's MMU or interpreter instead of a
  direct RAM access: the emitter's `read_*`/`write_*`, `lfs`/`lfd`/`stfs`
  helpers, memory instructions the helpers hand to the interpreter, the
  cached interpreter's fast instructions outside MEM1, and the memory
  instructions a cached-interpreter block interprets (static, every
  execution). They include those of regions.
- **Regions**: their cycles times their code's static accesses and
  instructions per cycle, computed at install.

Cost with stats off: one load and branch per block end. Tests:
`tests/mem-access-stats.test.mjs` (the Node core has no CachedInterpreter
instance: block counts are checked in a browser run).

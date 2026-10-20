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
   (8 per slice or 2 ms; a region with an entry HLE hooks, or whose code no
   longer matches the plan's hashes, is left out). With `jitoffthread=1` it
   never compiles one cold: a module not handed over before the boot is
   asked for with a compile request, and the region is installed once the
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

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
   ranges)` from any thread; the CPU thread compiles and maps queued modules
   at a slice boundary (4 per slice; a region with an entry HLE hooks is left
   out). `ExecuteOneBlock` runs the region holding the pc before looking for
   a block, with translation and FP on only; block chaining stops at a
   region entry. `JitInterface::InvalidateICache(Line)` drops the regions
   covering the code (a page map rejects the rest in one lookup);
   `ClearCache` drops them all. On with `aot=1`, their only producer
   (`wasmjit` already carries 0/1/2). Stats: `DolphinWeb_JitRegionStats`,
   layout v1 agreed with the harness (88 bytes, off until enabled). Tests:
   `tests/aot-region-dispatch.test.mjs`. Done; the live check needs P7.
6. The FP analyses over a region, each behind its own flag.

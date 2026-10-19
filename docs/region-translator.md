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
3. Fragments of several blocks with the entry dispatch and intra-fragment
   branches; `jump` and `dispatch` relocs, the whole function per fragment.
4. Oracle region mode: an assembled region against the interpreter, exits in
   the middle of a region (downcount, DSI, FP exception, icbi).
5. `RunWasmRegion` and `wasmjit=region` in the dispatcher.
6. The FP analyses over a region, each behind its own flag.

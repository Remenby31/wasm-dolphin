# Session 2026-05-11 (Day 2) — vendor/dolphin source changes for the JIT carry-op fix

This session bisects and fixes the WASM JIT post-frame-700 corruption that's
been documented in `docs/ogl-performance-plan.md` since the start. The bug
sat across **six** WASM JIT emit functions in
`Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp`, all
exhibiting the same pattern: store the computed result to `GprOffset(RD)`,
then re-read `RA`/`RB` from memory to compute the new XER.CA.

PowerPC commonly emits `adde rD, rA, rB` (or `addic`, `subfic`, etc.) with
`rD == rA` (or `rB`). After the result store, the re-read of `RA`/`RB`
picks up the post-store value instead of the original, producing a wrong
carry bit. The corrupted CA then cascades through subsequent
`adde`/`subfe`/`addze` chains and breaks the game's 3D rendering pipeline at
the moment the JIT compiles its first hot block (~frame 700, JIT engagement
threshold). Symptoms in the broken state: `prim:1540 draw:250 verts:0 rast:0`
— draw calls fire but vertex/raster state is corrupt, screen freezes at
~4 distinct canvas hashes.

**Bisection trail (full audit in commit message + `.omx/menu-progress/day2-*`):**

| Probe                                 | distinct | game speed | Conclusion           |
|---------------------------------------|---------:|-----------:|----------------------|
| `FORCEJIT=1` no disable (baseline)    |        4 |       98 % | broken               |
| `DISABLE=wasmblock`                   |       56 |       87 % | bug is in WASM JIT   |
| `DISABLE=wasmcarry` (all 5 carry ops) |       84 |       76 % | bug in carry family  |
| `DISABLE=wasmaddc,wasmsubfc` (gens)   |        4 |       98 % | not in generators    |
| `DISABLE=wasmadde,wasmsubfe,wasmaddze`|       78 |       76 % | in consumers         |
| `DISABLE=wasmaddze` alone             |        4 |       98 % | freeze without addze |
| `DISABLE=wasmadde` alone              |        4 |       99 % | freeze without adde  |
| `DISABLE=wasmsubfe` alone             |        4 |       97 % | freeze without subfe |
| `DISABLE=wasmadde,wasmsubfe`          |       66 |       98 % | addzex alone is OK   |
| `DISABLE=wasmadde,wasmaddze`          |       26 |      116 % | subfex alone is OK   |
| `DISABLE=wasmsubfe,wasmaddze`         |        4 |       98 % | addex alone is bad   |

So the canonical culprit is `addex` (SUBOP10=138). `addzex`'s emit code
caches `result` into local[3] and never re-reads `RA`/`RB` — that's why
isolating addzex never reproduces the bug. `addex`/`subfex`/`addcx`/
`subfcx`/`addic`/`subfic` all share the buggy pattern; the fix is
identical for all six: reorder so the new XER.CA is computed and stored
**before** the `GprOffset(RD)` write.

---

## The fix (applied to six emit sites in `CachedInterpreter.cpp`)

For each of `addex` (SUBOP10=138), `subfex` (SUBOP10=136), `addcx`
(SUBOP10=10), `subfcx` (SUBOP10=8), `addic`/`addic.` (OPCD=12/13 via
`EmitAddic`), and `subfic` (OPCD=8): move the `EmitStateStoreU32Suffix(...,
GprOffset(layout, inst.RD))` call to **after** the `EmitStateStoreU8Suffix(...,
layout.xer_ca_offset)` call, with the prefix push duplicated as needed.

Concretely (addex shown; pattern is the same elsewhere):

```diff
 if (inst.SUBOP10 == 138 && !inst.OE)
 {
+  // Compute the result (RA + RB + CA) into local[3].
   EmitStateLoadU8(body, layout.xer_ca_offset);
   EmitLocalSet(body, 2);
   EmitStateLoadU32(body, GprOffset(layout, inst.RA));
   EmitStateLoadU32(body, GprOffset(layout, inst.RB));
   body.push_back(0x6a);
   EmitLocalGet(body, 2);
   body.push_back(0x6a);
   EmitLocalSet(body, 3);
-  EmitStateStoreU32Prefix(body);
-  EmitLocalGet(body, 3);
-  EmitStateStoreU32Suffix(body, GprOffset(layout, inst.RD));
-
+
+  // Compute new XER.CA using ORIGINAL RA/RB and store it FIRST. The
+  // RD store must come last because RD may alias RA or RB; otherwise
+  // the re-read below would pick up the result value, miscomputing CA.
   EmitStateStoreU32Prefix(body);
   EmitStateLoadU32(body, GprOffset(layout, inst.RB));
   EmitStateLoadU32(body, GprOffset(layout, inst.RA));
   EmitI32Const(body, 0xffffffff);
   body.push_back(0x73);
   body.push_back(0x4b);
   EmitLocalGet(body, 2);
   EmitLocalGet(body, 3);
   EmitLocalGet(body, 2);
   body.push_back(0x6b);
   EmitI32Const(body, 0xffffffff);
   body.push_back(0x46);
   body.push_back(0x71);
   body.push_back(0x72);
   EmitStateStoreU8Suffix(body, layout.xer_ca_offset);
+
+  // NOW the RD store is safe.
+  EmitStateStoreU32Prefix(body);
+  EmitLocalGet(body, 3);
+  EmitStateStoreU32Suffix(body, GprOffset(layout, inst.RD));
+
   if (inst.Rc)
     EmitUpdateCr0FromLocal(body, layout, 3);
   return true;
 }
```

The other five emit sites take the same shape — only the new-CA formula
differs.

---

## Diagnostic infrastructure also landed (in-repo)

For the bisection, this session also added narrower disable bits to the
`DOLPHIN_WEB_DISABLE_*` constant table and per-bit gates in
`IsPpcWasmDirectInstructionCandidate`:

```cpp
constexpr u32 DOLPHIN_WEB_DISABLE_WASMCARRY   = 1u << 9;  // umbrella: all 5 carry ops
constexpr u32 DOLPHIN_WEB_DISABLE_WASMADDC    = 1u << 10; // addcx  only
constexpr u32 DOLPHIN_WEB_DISABLE_WASMSUBFC   = 1u << 11; // subfcx only
constexpr u32 DOLPHIN_WEB_DISABLE_WASMADDE    = 1u << 12; // addex  only
constexpr u32 DOLPHIN_WEB_DISABLE_WASMSUBFE   = 1u << 13; // subfex only
constexpr u32 DOLPHIN_WEB_DISABLE_WASMADDZE   = 1u << 14; // addzex only
```

These remain in the build as **future-proofing**: any further regression
in the carry-emitting ops can be bisected from JS via `?disable=wasmadde`
without rebuilding.

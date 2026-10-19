# PPC-to-WASM JIT flags

These URL parameters control the experimental PowerPC-to-WebAssembly JIT and
its diagnostic/bisection features. Defaults favor the known-good Melee
software-hybrid configuration. Several optimizations stay off until their
correctness is established.

| Flag | Meaning |
| --- | --- |
| `wasmjit=0` | Disable the PPC-to-WASM JIT. |
| `wasmjit=1` | Enable the guarded JIT tier. This is the normal software-path setting. |
| `wasmjit=2` | Enable the mixed tier; equivalent to selecting `jittier=mixed` while enabling the JIT. |
| `jittier=guarded` | Use conservative guarded compilation. This is the default tier. |
| `jittier=mixed` | Use the broader experimental mixed tier. Treat it as a bisection setting. |
| `forcejit=1` | Keep/force JIT use past normal safety decisions. It can bypass protective behavior and is opt-in. |
| `jitwarmup=N` | Engage the JIT `N` emulated VI fields after boot or after a state load (`0`-`60000`, default `60`). The CPU thread decides on its own field counter (the one saved in states), so the engage field is the same on every run, `cpu=dual` included, whatever the machine load, pauses or JIT cache state. |
| `unsafejitwarmup=1` | Bypass staged-warmup and OGL warmup protections. Diagnostic only. |
| `regalloc=0` | Disable the default-on GPR register cache/register allocation and return to the baseline path. |
| `smearcompile=0` | Disable default-on compile smearing and compile eagerly. |
| `blockmerge=1` | Opt into adjacent-block merging. Default-off because it is correctness-sensitive. |
| `shortprefix=1` | Compile shorter PPC prefixes. Default-off pending stronger correctness evidence. |
| `fastmemhoist=1` | Hoist per-block fastmem bounds checks. Default-off because a bad proof could permit an out-of-bounds access. |
| `disable=...` | Disable named JIT helper/optimization categories, or pass a decimal/hex mask, for bisection. |
| `nojitcache=1` | Skip the browser-side compiled JIT cache/prewarm path for a cold-cache comparison. |
| `jitoffthread=1` | The CPU thread does not compile a missed block first: it zeroes the key's byte in a shared ready table (`DolphinWeb_JitReadyBitsPtr()`, slot = first 16 SHA bits of the key), posts `dolphin-jit-compile-request {key, bytes, kind, readyPtr, readySlot}` once, and interprets the block. discio stores 1 in that byte once the compiler worker has compiled, warmed and retained the module, or failed; the block is then recompiled synchronously, which hits V8's per-process module cache for the same bytes (or raises the same engine error and is blacklisted). A retried block whose bytes changed compiles in place. The pthread never needs to receive a message (it does not return to its event loop). Needs the JIT cache (ignored with `nojitcache=1`); pair it with `aotcompiler=1` so the modules come back warmed (without it discio compiles them, unwarmed). |
| `aotcompiler=1` | Compile cached and requested JIT modules in a dedicated compiler worker (`src/aot-compiler-worker.js`) that warms them on scratch memory, and keep them alive so the CPU thread's own compile of the same bytes hits V8's cache. Off by default until its memory cost is measured. |
| `metrics=1` | Enable on-screen and validation metrics used to judge behavior and performance. |

## Defaults and safety

- Block merge is default-off; enable it only with `blockmerge=1`.
- Short-prefix compilation is default-off; enable it only with
  `shortprefix=1`.
- Fastmem bounds-check hoisting is default-off; enable it only with
  `fastmemhoist=1`.
- Register allocation/GPR caching is default-on. `regalloc=0` is the immediate
  escape hatch.
- Compile smearing is default-on. `smearcompile=0` restores eager compilation.
- `forcejit`, mixed-tier selection, and unsafe warmup are experimental
  diagnostics, not implied by the recommended URL.
- There is no wall-clock fuse: once engaged, the JIT stays on. A block the
  browser engine rejects (`CompileError`/`LinkError`) is blacklisted by its
  exact bytes and interpreted instead. An out-of-memory while compiling or
  instantiating is transient: that attempt is interpreted, the block is tried
  again after the next cache clear. A function table that cannot grow stops
  new compiles for the session (the table never shrinks). The helper stats
  count these (`enginereject`, `blacklisthit`, `transientreject`,
  `tablefull`).

The OGL path has stricter defaults. If neither `wasmjit` nor `forcejit=1` is
specified, JIT use defaults off for OGL. When JIT is explicitly enabled, a
5000-frame safety floor applies to warmup unless `forcejit=1` or
`unsafejitwarmup=1` overrides it.

## Bisection with `disable`

`disable` accepts comma-, plus-, or whitespace-separated category names, a
decimal bitmask, or a `0x` hexadecimal bitmask. Unknown names are logged and
ignored. Current named categories include:

```text
meleeloop meleecall osinterrupt dcbxloop fastbranch fastfp fastinteger
fastsystem wasmblock wasmcarry wasmaddc wasmsubfc wasmadde wasmsubfe
wasmaddze blockredispatch blockmerge regalloc shortprefix smearcompile
fastmemhoist inlinefma all
```

Aliases include `fastinputpoll` for `meleecall` and `fastmem` for
`fastsystem`. Because this surface is for controlled experiments, always save
the complete URL alongside results.

## Interpreting JIT metrics

- **Block compile count** is how many PPC blocks were translated/compiled. A
  rising count proves compilation activity, not that the compiled blocks are
  useful or amortized.
- **Block run count** is how often compiled blocks actually executed. Compare
  it with compile count to distinguish productive reuse from compile churn.
- **Helper stats** show which fallback or specialized helpers are being used.
  They are useful for finding hot unsupported operations and for validating a
  `disable` bisection.
- **Profile stats** attribute time and work across capture, copying,
  presentation, hashing, pacing, and related windows. Read them together with
  game speed, core FPS, presentation FPS, and unique/visual FPS.

“JIT enabled” does not automatically mean “faster” for every backend. Compile
bursts, low block reuse, helper overhead, renderer bottlenecks, browser codegen,
and backend-specific synchronization can hide or reverse a CPU-side gain. Use
same-machine A/B runs and distinguish emulation progress from presentation and
unique-frame cadence.

## Correctness contract and the oracle

A compiled block must leave exactly the state the interpreter leaves: GPRs,
CR, XER, LR, CTR, FPRs bit for bit (NaN payloads, signalling bits, denormals,
Gekko's single rounding of frC), FPSCR including FPRF/FI/FR and the sticky
exception bits, memory, and on an exception SRR0/SRR1/DAR/DSISR and the MSR.
The direct tier computes zero and normal results in WASM. The FMA family
(`fmadd`, `fmsub`, `fnmadd`, `fnmsub`, their single forms and `ps_madd*`,
`ps_msub`, `ps_nmadd`, `ps_nmsub`) must round once, as `std::fma` does, and
the WASM code does it without a hardware or relaxed-SIMD FMA, so the result is
the same on every machine. Inline, frC is first rounded to 25 bits for single
ops. When a·c is exact in double (the significands need 53 bits or fewer
together, counted with `i64.ctz`; always the case for a single-precision a in
single and paired-single forms) and the product is normal (a zero or
subnormal product of nonzero operands underflowed and is not exact), or when a
or frC is zero, the result is simply p + b. Otherwise TwoProduct (Veltkamp split) gives a·c = p + e exactly, TwoSum gives
p ± b = s + t, and the result is RN(s + RO(t + e)), RO rounding to odd
(u + v = t + e by TwoSum; when v ≠ 0 and u is even, u moves one ulp toward
v). Boldo and Melquiond prove this rounds a·c ± b once, in binary64, without
underflow or overflow ("Emulation of FMA and correctly rounded sums: proved
algorithms using rounding to odd", IEEE TC 2008). The `fma` import (the
interpreter's own `NI_madd_msub`) takes the rest: operands outside |a|, |c|,
|b| ≤ 2^995 with |p| ≥ 2^-900, and a denormal a or frC. For single forms, when the double result sits exactly
on a single-precision midpoint, `NI_madd_msub` moves it one ulp toward the
exact value with its own error estimate (b − r, r + a′, fma(a, c, a′)…); the
JIT computes that same estimate inline, the inner fma from the same exact
product (p + a′ when a·c is exact). That estimate is exact for single-precision inputs only (Dolphin's
comment); with a double b it can differ from a single rounding, and the JIT
then differs exactly as the interpreter does (`singleInexact` in the fuzz).
`disable=inlinefma` sends the whole family to the import, for A/B.

Either way the result stays inline under the zero-or-normal rule. `frsqrte`
reads Gekko's estimate table inline for positive normal inputs. NaN, infinity,
denormal results, a denormal frC, `fres`, the other `frsqrte` inputs and
`MSR.FE0/FE1` set re-run the instruction through the interpreter helper
before anything is written. FPRF is skipped only when the analyzer proves a
later op of the block rewrites it and FPSCR.VE = ZE = 0.

The interpreter's `std::fma` must round once too. The core links naga's
Rust `compiler_builtins`, whose weak `fma` double-rounds near a midpoint and
used to win the link over musl's; `core/upstream/dolphin_web_fma.h` defines
musl's as a strong symbol. The oracle checks the interpreter's double FMA
results against exact integer arithmetic.

`tests/jit-oracle-fuzz.mjs` checks this in Node against the built core
(`DolphinWeb_JitOracleRun` runs the same program from the same state through
the interpreter, then through the CPU thread's block pipeline):

```sh
node tests/jit-oracle-fuzz.mjs --per-instruction 300          # every instruction class
node tests/jit-oracle-fuzz.mjs --programs 20000 --length 48 --seed 2 --reduce
node tests/jit-oracle-fuzz.mjs --programs 10000 --mask 0x20000  # shortprefix on
node tests/jit-oracle-fuzz.mjs --fma 220000 --seed 3       # FMA family, adversarial operands
```

`--fma` draws operands for the FMA family: cancellations (b ≈ −a·c),
products beside the inline path's range guards, overflows, zeros, denormal
b and frC, single values, and constructed double-rounding traps (a·c rounds
to 2^m with a tiny error, b's ulp is 2^(m+1): p + b is an exact tie that
only the error resolves); double forms in round-to-nearest are also checked
against exact integer arithmetic (`exactMismatch`). All modes run with the GPR register cache on and off; `--reduce` shrinks a
diverging program to the instructions that matter. Programs that raise (FP
program exceptions: one state in six sets FE0/FE1) are compared at the
exception vector (SRR0/SRR1/MSR included), counted as `raisedException`.
Accesses through a base no BAT maps and misaligned `lmw` are generated too;
without MMU emulation the core does not vector them, and both sides must
still agree. The summary
counts value divergences (`divergent`) and FPSCR-status-only ones
(`fpscrStatus`) separately; either makes the run fail. `npm test` runs a small
fixed-seed slice (`tests/jit-oracle.test.mjs`). The browser-side check is the
harness's `cpufuzz` discs, which compare interpreter and JIT runs at the same
VI output.

## Executed-block export

The first-launch profile (docs/aot-plan.md) reads the blocks the CPU thread
has run without a sampler: `DolphinWeb_JitDumpBlocksRequest()` returns a
sequence number, the CPU thread serves it at its next slice boundary, and
once `DolphinWeb_JitDumpBlocksDone()` reaches that number,
`DolphinWeb_JitDumpBlocksCount()` triplets `{effective address, PPC byte
length, flags}` sit at `DolphinWeb_JitDumpBlocksBuffer()` (flags: bit 0
executed, bit 1 reserved, bit 2 real mode). The block cache is cleared on
icbi floods and state loads, so callers dump periodically and merge.

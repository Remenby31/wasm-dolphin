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
| `aotcompiler=0` | Compile cached and requested JIT modules in place on the discio worker instead of in the compiler worker (`src/aot-compiler-worker.js`), without the scratch-memory warm-up. A/B and escape hatch. |
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
fastmemhoist all
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
`ps_msub`, `ps_nmadd`, `ps_nmsub`) must round once. When the product a·frC
is exact in double (their significant bits add up to 53 or fewer, frC
rounded to 25 bits first for single ops, the product normal or an operand
zero), `a·c ± b` is computed inline and rounds once like `std::fma`; on the
single-precision tie that the interpreter corrects, and whenever the product
is not exact, it calls the interpreter's own `NI_madd_msub` through the `fma`
import. Either way the result stays inline under the zero-or-normal rule. NaN, infinity,
denormal results, a denormal frC, the reciprocal estimates and
`MSR.FE0/FE1` set re-run the instruction through the interpreter helper
before anything is written. FPRF is skipped only when the analyzer proves a
later op of the block rewrites it and FPSCR.VE = ZE = 0.

`tests/jit-oracle-fuzz.mjs` checks this in Node against the built core
(`DolphinWeb_JitOracleRun` runs the same program from the same state through
the interpreter, then through the CPU thread's block pipeline):

```sh
node tests/jit-oracle-fuzz.mjs --per-instruction 300          # every instruction class
node tests/jit-oracle-fuzz.mjs --programs 20000 --length 48 --seed 2 --reduce
node tests/jit-oracle-fuzz.mjs --programs 10000 --mask 0x20000  # shortprefix on
```

Both modes run with the GPR register cache on and off; `--reduce` shrinks a
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

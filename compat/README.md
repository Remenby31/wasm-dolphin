# compat: accuracy tests without a commercial game

Checks whose expected values come from real hardware, not from our own
interpreter (the JIT oracle and the fuzzers compare the JIT with the
interpreter, so a defect both share passes them). Nothing here reads a disc
or any game data.

## CPU: ported hwtests

`hwtests/cputest/*.mjs` port [dolphin-emu/hwtests](https://github.com/dolphin-emu/hwtests)
`cputest/` at `f28077b` (2024-11-24), GPLv2 (see `hwtests/LICENSE.md`). Each
hwtest `asm` block becomes a short PowerPC program; its inputs go into the
oracle state and its result is read from the final state. The core's JIT
oracle (`DolphinWeb_JitOracleRun`, patch 0071) runs each program on the
interpreter, then on the WASM JIT, and both results are compared with the
console's value. The JIT runs with the production disable mask except for
bit 21 (shortprefix): blocks of two ops compile, which production leaves to
the interpreter (minimum four), so block shapes differ from the product's.

    node compat/run.mjs [--json out.json] [--md out.md] [--only frsp,ni]

| port | hwtest | checks | note |
|---|---|---:|---|
| mtspr | mtspr.cpp | 2 | reserved bits of GQR and XER |
| cr | cr.cpp | 54 | cmpwi + crset/crclr with XER[SO] |
| rlw | rlw.cpp | 4200 | full grid of the hwtest |
| srawix | srawix.cpp | 2048 | 64 inputs per shift (hwtest: 4096 rand()) |
| frsp | frsp.cpp | 18 | NI and RN modes |
| fctiwz | fctiwz.cpp | 12 | |
| fctiw | fctiw.cpp | 1856 | sample of the hwtest's ~2^31 inputs, 4 RN modes |
| ni | ni.cpp | 10 | non-IEEE mode |
| fprf | fprf.cpp | 90 | with Config::MAIN_FPRF on |
| fprf-default | fprf.cpp | 90 | with the core's default (FPRF off) |
| load | load.cpp | 1088 | 16 load forms, hwtest operand roles |
| nan | nan.cpp | 626 | asm blocks transcribed by script, assembled in `nan.mjs` |
| reciprocal | reciprocal.cpp | 10240 | fres/frsqrte: 5120 of the hwtest's 2^32 inputs |
| pairedmove | pairedmove.cpp | 8800 | the hwtest's full grid |

Values were measured on a Wii (Broadway), not on a GameCube; Gekko and
Broadway share the CPU core. A check counts for the JIT only when the JIT
compiled its whole program; `jitCoverage` in `expected-failures.json` pins
that count per suite. Not compiled today (interpreter-only checks): fctiw,
ps_div, ps_sel, ps_rsqrte. Any check whose final JIT state differs from the
interpreter's fails the run, listed failure or not.

`lib/float-ref.mjs` ports the hwtests' models of the fres/frsqrte tables and
of the paired-single mantissa rounding (`Common/FloatUtils.h`).

`expected-failures.json` lists the checks that fail today, per tier, with a
reason: one check by `id`, or a family by `match` (a regex) whose number of
failures per tier must stay exactly `count`. The pairedmove families: 3,652
moves (mantissa rounding after lfd) and 296 ps_res/ps_rsqrte estimates (a
different cause: denormal inputs and the ps1 sign rule). `run.mjs` exits 1 on a failure not listed and on a listed failure
that passes (so a fix updates the list). `tests/compat-hwtests.test.mjs` runs
the same in `npm test`, which core-build.yml runs on a core pull request's
own build. `.github/workflows/compat.yml` publishes the table on every pull
request and push to main.

## Not yet ported

`gxtest/` (needs the whole
machine and an EFB-to-RAM read back: a devkitPPC build booted by the
harness), homebrews for MMU/BAT, VI modes and memory cards.

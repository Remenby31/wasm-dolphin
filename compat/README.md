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
interpreter, then on the WASM JIT (production disable mask, but blocks of two
ops allowed), and both results are compared with the console's value.

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

Values were measured on a Wii (Broadway); the GameCube's Gekko shares the
core. A check is `n/c` for the JIT when the JIT left the block to the
interpreter (fctiw today).

`expected-failures.json` lists the checks that fail today, per tier, with a
reason. `run.mjs` exits 1 on a failure not listed and on a listed failure
that passes (so a fix updates the list). `tests/compat-hwtests.test.mjs` runs
the same in `npm test`, which core-build.yml runs on a core pull request's
own build. `.github/workflows/compat.yml` publishes the table on every pull
request and push to main.

## Not yet ported

`cputest/{nan,load,pairedmove,reciprocal}.cpp`, `gxtest/` (needs the whole
machine and an EFB-to-RAM read back: a devkitPPC build booted by the
harness), homebrews for MMU/BAT, VI modes and memory cards.

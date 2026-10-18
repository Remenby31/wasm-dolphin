# Selftest results

Core sha256:230f25cb… (rebuilt with the harness hooks), branch qa/harness-p0, run 2026-10-18 on Apple M4 Pro (load 10-57), headed Chrome 155. `node harness/selftest/run.mjs --clean 5`.

| Case | Kind | What | Gate | Blocked by | Expected |
|---|---|---|---|---|---|
| geometry | mutant | 3D objects missing from the picture (interpreter and JIT alike) | BLOCK | renderVsBaseline r1 regressed<br>renderVsBaseline r1 regressed | yes |
| color | mutant | one tile colour off by 3/255 in blue | BLOCK | renderVsBaseline r1 regressed<br>renderVsBaseline r1 regressed | yes |
| jit-crash | mutant | the JIT emits an invalid module (cpufuzz block with mcrf) | BLOCK | fuzz:jit-crash regressed | yes |
| port | mutant | gamepads no longer reach port 1 (ports 2-4 are already dead on main) | BLOCK | pads:port-1 regressed | yes |
| core-freeze | mutant | the core stops for 3 s in the measured window | BLOCK | coreFreeze regressed | yes |
| worker-error | mutant | the worker sends a message nobody handles (swallowed) | BLOCK | errors regressed | yes |
| audio-cut | mutant | the output gain is zero | BLOCK | audio regressed | yes |
| perf-30 | mutant | emulation runs at 70 % speed | BLOCK | perf speed -30 %<br>perf frameP95 -32 % | yes |
| clean-1 | clean | this tree vs itself | PASS | – | yes |
| clean-2 | clean | this tree vs itself | PASS | – | yes |
| clean-3 | clean | this tree vs itself | PASS | – | yes |
| clean-4 | clean | this tree vs itself | PASS | – | yes |
| clean-5 | clean | this tree vs itself | PASS | – | yes |

8/8 mutants blocked, 5/5 clean runs passed.

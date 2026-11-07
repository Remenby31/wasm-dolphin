# Cached-interpreter static exit links: local promotion

The WebAssembly core now reuses linked targets for known block exits, reducing repeated cache lookups while retaining the original execution, timing, input-policy and invalidation checks. Patch `0066-cached-interpreter-static-exit-links.patch` enables the lean implementation by default under Emscripten. An explicit `DOLPHIN_WEB_STATIC_EXIT_LINKS=0` still disables it, and diagnostic counters default off.

The first broad-link implementation had mixed results on the fighting game and was not promoted. The lean version installs the thread-local context once per `ExecuteOneBlock` call and refreshes its completion, epoch and feature state at each actual block. It keeps the same link descriptors and base cache unlink behavior. No shared JIT-cache layout or new package dependency was introduced.

Paired tests of this exact core showed fighting-game gains of **9.52% and 11.09%**, and Wii racing-game gains of **8.52% and 12.97%**. Candidate results were **46.19–47.27 core FPS** for the tested battle and **34.27–35.36 core FPS** for the settled, idle-kart Wii fixture. These remain below full speed. The separate diagnostic build bypassed 82.233% of post-block lookups; that percentage is not an FPS gain.

## Reproduction and installation

Production Ninja rebuilt all four dependent objects: `CachedInterpreter.cpp`, `CachedInterpreter_Disassembler.cpp`, `CachedInterpreterBlockCache.cpp`, and the factory consumer `JitInterface.cpp`. Every object matched the measured candidate exactly. The final in-place Windows link failed when `wasm-metadce` could not reopen its output WASM, so the working baseline runtime was restored while the link was recovered.

A private optimized link used the current production `libcore.a`, the same flags and toolchain, and separate output/temporary paths. All 890 pinned inputs remained unchanged. Both resulting files matched the measured candidate byte for byte before installation:

| Artifact | SHA-256 |
| --- | --- |
| WASM | `e8a1c1bb9aec817bdf96f88f41c9681caa1b8001620a35e658deff7c7a9630a2` |
| JS, raw bytes | `a589ee9e0f9ff3feb0a466f46a54b0151b058d6d3307ba7356db1a8a88d6cdd6` |
| Renderer worker | `f2ff1fda27fde40b7d018303dfa1a9454e39b0619901663634aed3514ab68677` |

The installed files were packaged using the standard build-info and candidate helpers. The ABI manifest and default worker core identity were refreshed. The source snapshot has 66 patches, series hash `467b031ca41d8e82da59f0657d606f47561ffb7b3688fb5648f89bf13a6ae955`, and result tree `f7486fd3c967e88fe89a00d5ad44a0bf95cdfb76`. The installed patch uses LF-normalized patch text so both working-tree application and cached provenance replay succeed; applied source bytes match the prepared promotion files. Historical experimental bindings in the measurement reports describe the inputs at measurement time and were not relabelled.

## Verification and limits

`npm test` passed **975 tests, zero failed and zero skipped**. The installed native regression package includes 52 groups plus its parent test, reads actual vendor source, and derives its differential reference from explicit macro zero. Coverage includes real base cache linking/unlinking, epoch invalidation, feature variants, early halts, nested contexts, failed emission, specialized helpers, policy gates, and coherent diagnostic publication. The native host harness documents the small adapters required for WebAssembly's 32-bit callable ABI; its POSIX protected-memory adapter was not exercised on this Windows host.

`npm run check` and `npm run verify:provenance` passed after installation. The source lock also replayed and verified before the build. No native builds or tests overlapped the timed browser measurements.

Battle and Wii fixture screenshots, input isolation, JIT policy, audio counters and GPU fences passed their bounded checks. Wii's course outline is visible using the separately repaired checkpoint, with no displaced left-side overlay apparent in the inspected boundaries. A 3D platformer passed only an animated file-select menu smoke check: 59.94 core FPS, approximately 29.89 submitted presentations per second. This is not gameplay coverage for that title or proof that all games run at full speed.

General GPU save-state readback remains unresolved, as do wider gameplay coverage and sustained native cadence across all games. The Wii fixture restores one previously blank map image; it does not repair the other lost cached images. See [the viewport and minimap investigation](../webgpu-viewport-fix.md). The Windows in-place link failure was recovered for this build; the build wrapper itself was not changed.

Private build logs, input pins, installation evidence, source contracts and game captures remain under `.omx/full-speed/static-exit-links-lean/` and the associated benchmark directories. Game data and raw captures are excluded from source deliverables.

## Re-measured after the rebase onto main (2026-09-11)

The numbers above were taken against a prototype tree with two reps an arm.
This series was rebased onto main as patches 0066 and 0067 and measured again
with more pairs, against main's current core `286e7287`:

| workload | A median | B median | median delta | positive | two-tailed sign |
| --- | ---: | ---: | ---: | ---: | ---: |
| Wii racing game (race state) | 1680.9 | 2034.1 | **+22.28%** | 8/8 | p = 0.0078 |
| fighting game (reference battle) | 1760.7 | 1969.4 | **+11.65%** | 6/6 | p = 0.0312 |

In emulated frames: Wii racing game 28.0 -> 33.9 fps, fighting game 29.3 -> 32.8 fps.
Neither arm's spread overlaps the other's on either title -- the Wii racing game's
control tops out at 1687 against a treatment floor of 1975 -- which is a
cleaner separation than anything else measured on this fixture.

The fighting game reproduces the original 9.5-11.1% closely. The Wii racing game comes out well
above the original 8.5-13.0%, which is expected rather than suspicious: main
has since gained the renderer work from PR #21, so the control is a different
core from the one the first measurement used.

This is the largest effect measured on this project, and it lands where the
profile said the time was: the CPU emulation thread was the critical path at
0% idle and 0.1% blocked, with roughly 54% of it in interpreter dispatch.

# Executed cached-block exit coverage

A fresh native probe measured how often completed, constant, unconditional non-call exits could avoid the general block-cache lookup. They account for about 8.6–8.8% of sampled lookup opportunities in the checked workloads. This does not justify prioritizing that narrow linking strategy as the main route to full speed. Production execution is unchanged.

| Workload | Completed block samples | Eligible cached targets / attempted lookups | Uncertain observations / samples |
| --- | ---: | ---: | ---: |
| Fighting game, reference battle | 846,212 | 8.772% | 0.00792% |
| Wii racing game, race | 897,626 | 8.572% | 0.00323% |
| 3D platformer, beach file-select menu | 407,643 | 8.813% | 0.00098% |

The two gameplay checks retain coherent before/final scenes, advancing timers, enabled JIT, fixed native input counters, completed GPU fences and clean audio/renderer error counters. The Wii racing game uses the repaired checkpoint: its course outline remains visible and the displaced overlay does not appear in the checked captures. The platformer's animated menu runs correctly in this probe; active gameplay of that title is still uncovered.

Calls account for roughly 15–19% of completed samples, and the `Other` terminal category roughly 73–76%. `Other` is not a proven linkable cohort: it includes conditional/indirect exits and other terminal operations. Lookup frequency does not measure lookup cost, so these shares do not imply an FPS speedup ceiling. The next design should cover a broader set of proven static exits while preserving each block's state accounting, timing, feature checks and invalidation lifecycle.

## Exact build and observation method

Production remains native core `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c` and worker `f2ff1fda27fde40b7d018303dfa1a9454e39b0619901663634aed3514ab68677`. The isolated diagnostic core is `85827cbde5f774aaeb3226357f32b91446f96a6ee91c773fb46649485cd228ac`.

The build pins 1,135 inputs, preserves the original logical source location through VFS and line directives, and changes one translation unit. Both the unmodified-source reference and macro-disabled source copy reproduce the original object and production WASM byte-for-byte. Original inputs remain unchanged. The private header and instrumented source are bound to the diagnostic hash in the build/package record; no new code was installed in production.

Sampling occurs inside the actual cached-block loop while ordinary redispatch remains enabled. Random gaps are uniformly selected from 1 through 2,048, with mean 1,024.5. All three workloads use the same configured seed; independent seed/cadence replication remains a verification gap. Metadata is recorded during emission. A sampled exit must match its normal-completion payload token, source generation, live range, PC and full feature key. The probe observes the existing next `Dispatch()` result before any cache miss compiles its target.

Live counters belong to the CPU thread. Coarse, sequentially consistent atomic snapshots and forced pause-boundary publication supply raw before/after deltas. Reporting never reads mutable live metadata. Missing, invalidated, unmarked and unknown observations remain in the reported uncertainty denominator. Self/idle exclusions are explicit; broad counters produce the same ratios in these intervals because no sampled static exits carried those flags.

Each run uses a fresh browser, identical explicit `0x5555` process affinity, 20 emulated seconds of warm-up and 30 emulated seconds of observation. Native snapshot reads occur while paused outside timing. One Wii control expired at its scene-review gate and was excluded before any measurement; its replacement completed normally.

## Observer cost and verification

The fighting-game control/probe pair measured 49.72/41.06 FPS; the Wii pair measured 35.39/26.66 FPS. These are measurements with and without the observer, not optimization gains. One pair per scene is insufficient to assign a precise stable overhead percentage. The platformer's probe reached its menu cadence of about 59.93 FPS without a matching control, so it does not measure uncapped headroom or gameplay performance.

Twenty native test groups cover terminal identity, early halt/HLE exclusion, nested observations, entry reuse, retirement, resets, outcome partitions and concurrent snapshot coherence. Forty-eight parser tests cover strict schemas, exact integers, stale/reset detection and counter/subset equations. Independent source review found no blocking integration issue. Fresh browser runs verified the actual diagnostic and current worker together.

Changed diagnostic files include the private header/instrumenter, isolated build/package runner, validated analyzer, and refreshed current/platformer harnesses under `.omx/full-speed/`. Only the report files are intended as public source artifacts. The baseline candidate's ABI metadata was refreshed for worker `f2`; historical benchmark files remain untouched. No game data or screenshots belong in source commits.

The next implementation design is recorded privately in `.omx/full-speed/block-exit-coverage/broader-link-design.md`. It proposes terminal link cells managed by existing `LinkData`, consumed after the original redispatch checks with feature/source-lifetime validation. Calls may complete at their target or a helper's known continuation; conditional and known helper exits require explicit handling. The verified minimum rebuild closure includes CachedInterpreter, its disassembler and block cache, plus JitInterface's factory allocation. The one-object diagnostic relinker is insufficient for that candidate. No broader links have been implemented or enabled.

The [machine-readable result](cached-block-exit-coverage-2026-09-07.json) contains exact counts, runtime identities and limitations. Full-speed gameplay across all games remains unverified, and general GPU save-state readback remains incomplete.

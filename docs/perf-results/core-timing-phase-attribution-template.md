# CoreTiming phase attribution — validation template

Use this template for a headed, direct-save reference-battle run after the
`0018-core-timing-phase-attribution.patch` core has been rebuilt. It contains
no benchmark result. Do not replace `TODO` fields with estimates.

The retained 2026-07-10 measurements were recorded separately, so this file
remains a reusable blank validation template.

## Run identity

| Field | Value |
| --- | --- |
| Machine | TODO |
| Browser/version | TODO |
| Branch/commit | TODO |
| Core SHA-256/size | TODO |
| ROM SHA-256 | TODO |
| Save SHA-256 | TODO |
| URL | TODO: include `metrics=1&ppcprof=1` |
| Duration/window | TODO |
| Raw artifact directory | TODO |

The harness must load the exact battle save directly. It must not navigate or
pause at character select.

`metrics=1` captures browser-side validation data. `ppcprof=1` is separately
required to enable the core timing probes and their helper output; omitting it
makes every structured timing record unavailable.

## Retained worst-slice causal attribution

Copy the adjacent `sliceprof:` and `slicephase:v=1` records from the same
helper string. `slicephase` belongs to the exact slice retained by `sliceprof`:
its throttle site is selected from waits in that slice, and its DVD tuple is
the phase-by-phase sum of completions that occurred in that slice. This is the
record used for causal ownership. Do not join `sliceprof` to the independent
aggregate maxima below.

| Run | Slice total ms | Owner | VI throttle site | Site total ms | Site max/requested/overshoot ms | Correlated DVD total ms | Correlated DVD owner |
| --- | ---: | --- | --- | ---: | --- | ---: | --- |
| TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |

## DVD completion ownership

Copy the parsed `dvdprof:v=1` process-wide maximum from
`jit-diagnostics.json`. This is aggregate context, not evidence that the DVD
maximum occurred in the retained worst slice. The phase times are mutually
exclusive. `other` is derived as total completion time minus the measured map,
queue wait, queue pop/reordering, RAM copy, and command finish phases.

| Run | Total ms | Map ms | Queue wait ms | Pop/reorder ms | RAM copy ms | Finish ms | Other ms | Bytes | Queue loops | Owner |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |

## VI throttle sites

Copy both `throttleprof:v=1` records. `count` is the number of measured sleeps,
`slow` counts actual sleeps above 5 ms, and `total` is cumulative actual sleep
time. `requested` and signed `overshoot` belong to the sample that established
the site's maximum actual sleep; they are not independent maxima.

| Run | Site | Count | Slow count | Total actual ms | Average actual ms | Max actual ms | Requested at max ms | Overshoot at max ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| TODO | `vi-end-field` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| TODO | `vi-si-poll` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |

## Reconciliation and acceptance

- [ ] The run URL contains both `metrics=1` and `ppcprof=1`.
- [ ] `npm run jit:analyze` parsed `sliceprof:`, `slicephase:v=1`,
      `dvdprof:v=1`, and both throttle-site records.
- [ ] `slicephase` is adjacent to, and was parsed from the same helper string
      as, the retained `sliceprof` tuple.
- [ ] DVD phase sum plus derived `other` equals the retained DVD total.
- [ ] Each site's `slow` count is no greater than its measured-sleep count.
- [ ] Each site's requested duration is non-negative and overshoot is retained
      with its sign.
- [ ] Each throttle max equals requested plus signed overshoot, and no site max
      exceeds its cumulative site total.
- [ ] Raw `console.log`, `samples.json`, `samples.csv`, `summary.json`, and
      `jit-diagnostics.json` are retained and hashed.
- [ ] Slow CoreTiming event counts are reconciled against the structured
      records; missing categories are reported rather than inferred.
- [ ] Any performance or ownership claim names the exact machine, browser,
      core hash, save, duration, and raw path.

## Interpretation

A long VI callback dominated by requested throttle sleep is deliberate pacing,
not CPU saturation. Positive overshoot measures wake-up lateness beyond the
requested sleep; a negative value means the sleep returned early. A DVD result
may be called queue-wait-owned only when its coherent retained tuple meets the
analyzer's 80% ownership threshold. Otherwise report it as mixed. Any tuple
that fails reconciliation is classified invalid and must not support an
ownership claim.

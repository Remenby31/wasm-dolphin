// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// QA-CHECKLIST.md §1 classification, per (game, config, machine). It is a
// REPORT: the blocking gate (gate.mjs) never uses it, because thresholds on
// timing measured on a shared, loaded machine are not a reliable judge.
// Correctness failures make a cell CASSÉ whatever the load. Pure.
import { median } from "./stats.mjs";

export const THRESHOLDS = Object.freeze({
  realtime: { speedMedian: 98, speedP5: 95, uniqueSlack: 0.05, frameP95Ms: 20, underrunsPerMin: 0 },
  playable: { speedMedian: 90, uniqueShare: 0.5, underrunsPerMin: 2 }
});

const med = (runs, f) => median(runs.map((r) => r.summary?.[f]));
const worst = (runs, f) => {
  const v = runs.map((r) => r.summary?.[f]).filter(Number.isFinite);
  return v.length ? Math.max(...v) : null;
};

export function classify({ runs, checks, game = {} }) {
  const failed = Object.entries(checks).filter(([, c]) => c.status === "fail").map(([k, c]) => `${k}: ${typeof c.detail === "string" ? c.detail : JSON.stringify(c.detail)}`);
  if (failed.length) return { verdict: "CASSÉ", reasons: failed };
  const usable = runs.filter((r) => !r.overloaded);
  if (!usable.length) return { verdict: "INCONCLUSIF", reasons: [`all ${runs.length} runs overloaded`] };
  const reasons = [];
  if (checks.render?.status !== "pass") reasons.push(`render not proven (${checks.render?.detail ?? "unchecked"})`);
  const speed = med(usable, "speed"), p5 = med(usable, "speedP5"), unique = med(usable, "vis"), frameP95 = med(usable, "frameP95");
  const underruns = worst(usable, "audioUnderrunsPerMin");
  const native = Number.isFinite(game.nativeFps) ? game.nativeFps : null;
  const R = THRESHOLDS.realtime, P = THRESHOLDS.playable;
  const uniqueAtLeast = (share) => (game.static ? true : native == null ? null : unique >= native * share);
  const rt = [
    [speed >= R.speedMedian, `speed median ${Math.round(speed)} < ${R.speedMedian}`],
    [p5 >= R.speedP5, `speed p5 ${Math.round(p5)} < ${R.speedP5}`],
    [uniqueAtLeast(1 - R.uniqueSlack), native == null ? "native cadence unknown" : `unique ${unique}/s < native ${native} − 5 %`],
    [frameP95 != null && frameP95 <= R.frameP95Ms, `frame p95 ${frameP95} ms > ${R.frameP95Ms}`],
    [underruns != null && underruns <= R.underrunsPerMin, underruns == null ? "audio underruns not measured" : `${underruns} audio underruns/min`]
  ];
  const playable = [
    [speed >= P.speedMedian, `speed median ${Math.round(speed)} < ${P.speedMedian}`],
    [uniqueAtLeast(P.uniqueShare) !== false, `unique ${unique}/s < 50 % of native ${native}`],
    [underruns == null || underruns <= P.underrunsPerMin, `${underruns} audio underruns/min > ${P.underrunsPerMin}`]
  ];
  const fails = (list) => list.filter(([ok]) => ok !== true).map(([, why]) => why);
  // Any class above LENT needs the picture proven right.
  if (reasons.length) return { verdict: "LENT", reasons: [...reasons, ...fails(playable)] };
  if (!fails(rt).length) return { verdict: "TEMPS RÉEL", reasons: [] };
  if (!fails(playable).length) return { verdict: "JOUABLE", reasons: fails(rt) };
  return { verdict: "LENT", reasons: fails(playable) };
}

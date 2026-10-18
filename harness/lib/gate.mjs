// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The blocking gate, baseline (e.g. origin/main) vs candidate. Pure.
//
// Correctness (crash, swallowed errors, core freeze, exact-frame render, and
// the fuzz/pads results) blocks on any check the baseline passes and the
// candidate fails, and on any check the candidate cannot be judged on while
// the baseline could: INCONCLUSIF blocks. A failure both sides share is a
// known failure, reported, not blocking. Nothing passes by default.
//
// Performance never goes through verdict thresholds. It only blocks on a
// clear, confirmed regression: the median of the paired (same run index,
// alternated) relative changes is worse by PERF_REGRESSION or more, and still
// is after the confirmation pairs.
import { CHECKS, crashSignature } from "./correctness.mjs";
import { median } from "./stats.mjs";

export const PERF_REGRESSION = 0.15;
// metric → which direction is better
export const PERF_METRICS = Object.freeze({ speed: "higher", vis: "higher", frameP95: "lower" });

const key = (c) => `${c.game}\u0000${c.config}`;

export function correctnessGate(baselineCells, candidateCells) {
  const base = new Map(baselineCells.map((c) => [key(c), c]));
  const rows = [];
  for (const cand of candidateCells) {
    const b = base.get(key(cand));
    base.delete(key(cand));
    for (const check of CHECKS) {
      const bs = b?.checks?.[check]?.status ?? null;
      const cs = cand.checks?.[check]?.status ?? "unjudged";
      let status;
      // A failure is "known" only if the baseline failed the same way: a new
      // crash signature where the baseline crashed differently, or could not
      // be judged, is a regression.
      const same = check !== "crash" || b?.checks?.crash?.detail === cand.checks?.crash?.detail;
      if (cs === "fail") status = bs === "fail" && same ? "known-failure" : "regressed";
      else if (cs === "unjudged") status = bs === "unjudged" ? "not-covered" : "inconclusive";
      else status = bs === "fail" ? "fixed" : "ok";
      rows.push({ game: cand.game, config: cand.config, check, baseline: bs, candidate: cs, status, detail: cand.checks?.[check]?.detail ?? null });
    }
  }
  for (const b of base.values()) rows.push({ game: b.game, config: b.config, check: "*", baseline: "present", candidate: null, status: "missing" });
  return summarize(rows);
}

// Findings of single-shot correctness commands (fuzz, pads): kinds the
// candidate shows that the baseline did not are regressions. A candidate
// that produced no result at all is inconclusive.
export function findingsGate(name, baselineFindings, candidateFindings) {
  if (!candidateFindings) return summarize([{ game: name, config: "-", check: name, baseline: "ran", candidate: null, status: "inconclusive" }]);
  // Crash findings are keyed by their signature too, so a different crash is
  // never "known".
  const keyOf = (f) => `${f.iso ?? ""}:${f.kind}${/crash/.test(f.kind) ? `:${crashSignature(f.error)}` : ""}`;
  const known = new Set((baselineFindings ?? []).map(keyOf));
  const rows = candidateFindings.map((f) => ({
    game: f.iso ?? name, config: "-", check: `${name}:${f.kind}`, baseline: null, candidate: "fail",
    status: known.has(keyOf(f)) ? "known-failure" : "regressed", detail: f.error ?? f.rows ?? null
  }));
  return summarize(rows.length ? rows : [{ game: name, config: "-", check: name, baseline: null, candidate: "pass", status: "ok" }]);
}

function summarize(rows) {
  const blocking = rows.filter((r) => r.status === "regressed" || r.status === "missing" || r.status === "inconclusive");
  return {
    ok: rows.length > 0 && blocking.length === 0,
    inconclusive: rows.length === 0 || (blocking.length > 0 && blocking.every((r) => r.status === "inconclusive")),
    rows,
    blocking
  };
}

// Rows from renderVsBaseline (render-check.mjs) on the candidate records.
export function crossCommitGate(candRecords) {
  const rows = candRecords.map((r) => {
    const st = r.renderVsBaseline?.status ?? "unjudged";
    return {
      game: r.game, config: r.config, check: `renderVsBaseline r${r.run}`, baseline: "capture", candidate: st,
      status: st === "fail" ? "regressed" : st === "pass" ? "ok" : st === "not-covered" ? "not-covered" : "inconclusive",
      detail: r.renderVsBaseline?.detail ?? null
    };
  });
  return summarize(rows);
}

export function mergeGates(...gates) {
  return summarize(gates.flatMap((g) => g.rows));
}

// Paired relative change of one metric, oriented so that negative = worse.
// Pairs are runs with the same index (run alternately on both sides).
export function pairedChange(baseRuns, candRuns, metric) {
  const dir = PERF_METRICS[metric];
  const changes = [];
  for (const c of candRuns) {
    const b = baseRuns.find((x) => x.run === c.run);
    const bv = b?.summary?.[metric], cv = c.summary?.[metric];
    if (!Number.isFinite(bv) || !Number.isFinite(cv) || bv === 0) continue;
    const rel = (cv - bv) / Math.abs(bv);
    changes.push(dir === "higher" ? rel : -rel);
  }
  return { pairs: changes.length, median: median(changes) };
}

// runsByCell: Map("game\0config" → runs). One row per cell and metric. A
// regression only counts as confirmed when confirmation pairs (run index
// above `initialRuns`) exist and the median over all pairs is still worse
// by PERF_REGRESSION: three noisy runs alone never block.
export function perfReport(baseRunsByCell, candRunsByCell, { initialRuns = Infinity } = {}) {
  const rows = [];
  for (const [k, candRuns] of candRunsByCell) {
    const baseRuns = baseRunsByCell.get(k) ?? [];
    const [game, config] = k.split("\u0000");
    const confirmationRuns = candRuns.filter((r) => r.run > initialRuns);
    for (const metric of Object.keys(PERF_METRICS)) {
      const ch = pairedChange(baseRuns, candRuns, metric);
      const worse = ch.pairs > 0 && ch.median <= -PERF_REGRESSION;
      // A confirmation counts only if both sides of the pair measured this
      // metric: an unmeasured run (null) confirms nothing.
      const measured = (r) => Number.isFinite(r?.summary?.[metric]);
      const confirmations = confirmationRuns.filter((r) => measured(r) && measured(baseRuns.find((b) => b.run === r.run))).length;
      rows.push({
        game, config, metric, ...ch, confirmations, worse,
        regressed: worse && confirmations > 0,
        // Replays happened but none measured it: neither pass nor fail.
        inconclusive: worse && confirmationRuns.length > 0 && confirmations === 0
      });
    }
  }
  return rows;
}

export function runsByCell(records) {
  const m = new Map();
  for (const r of records) {
    const k = `${r.game}\u0000${r.config}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// The final decision, from what is persisted (gate.json): `perf` holds the
// rows after confirmation, so re-running the gate on the same files gives
// the same answer.
export function decide({ correctness, perf = [] }) {
  if (!correctness.ok) return { ok: false, reason: correctness.inconclusive ? "inconclusive" : "correctness" };
  if (perf.some((r) => r.regressed)) return { ok: false, reason: "performance" };
  if (perf.some((r) => r.inconclusive)) return { ok: false, reason: "inconclusive" };
  return { ok: true, reason: null };
}

export function gateMarkdown({ correctness, perf = [] }) {
  const lines = ["## Correctness (blocking)", "", "| Game | Config | Check | Baseline | Candidate | Status |", "|---|---|---|---|---|---|"];
  for (const r of correctness.rows) if (r.status !== "ok") lines.push(`| ${r.game} | ${r.config} | ${r.check} | ${r.baseline ?? "–"} | ${r.candidate ?? "–"} | ${r.status} |`);
  lines.push("", `${correctness.rows.filter((r) => r.status === "ok").length} check(s) ok.`, "");
  lines.push("## Performance (paired; blocks only a confirmed ≥ 15 % regression)", "", "| Game | Config | Metric | Pairs | Median change | Regressed |", "|---|---|---|---|---|---|");
  for (const r of perf) lines.push(`| ${r.game} | ${r.config} | ${r.metric} | ${r.pairs} (${r.confirmations ?? 0} confirmation) | ${r.median == null ? "–" : `${Math.round(r.median * 1000) / 10} %`} | ${r.regressed ? "yes, confirmed" : r.inconclusive ? "worse, confirmations unmeasured" : r.worse ? "worse, not confirmed" : "no"} |`);
  const d = decide({ correctness, perf });
  const text = d.ok
    ? "Gate: PASS."
    : d.reason === "inconclusive"
      ? "Gate: INCONCLUSIF, blocking (a check, or a performance confirmation, could not be judged on the candidate)."
      : d.reason === "correctness"
        ? `Gate: FAIL (${correctness.blocking.length} correctness regression(s)).`
        : `Gate: FAIL (confirmed performance regression: ${perf.filter((r) => r.regressed).map((r) => `${r.game}/${r.config} ${r.metric}`).join(", ")}).`;
  lines.push("", text);
  return lines.join("\n");
}

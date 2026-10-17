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
import { CHECKS } from "./correctness.mjs";
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
      if (cs === "fail") status = bs === "fail" ? "known-failure" : "regressed";
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
  const known = new Set((baselineFindings ?? []).map((f) => `${f.iso ?? ""}:${f.kind}`));
  const rows = candidateFindings.map((f) => ({
    game: f.iso ?? name, config: "-", check: `${name}:${f.kind}`, baseline: null, candidate: "fail",
    status: known.has(`${f.iso ?? ""}:${f.kind}`) ? "known-failure" : "regressed", detail: f.error ?? f.rows ?? null
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

// runsByCell: Map("game\0config" → runs). One row per cell and metric.
export function perfReport(baseRunsByCell, candRunsByCell) {
  const rows = [];
  for (const [k, candRuns] of candRunsByCell) {
    const baseRuns = baseRunsByCell.get(k) ?? [];
    const [game, config] = k.split("\u0000");
    for (const metric of Object.keys(PERF_METRICS)) {
      const ch = pairedChange(baseRuns, candRuns, metric);
      rows.push({ game, config, metric, ...ch, regressed: ch.pairs > 0 && ch.median <= -PERF_REGRESSION });
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
  return { ok: true, reason: null };
}

export function gateMarkdown({ correctness, perf = [] }) {
  const lines = ["## Correctness (blocking)", "", "| Game | Config | Check | Baseline | Candidate | Status |", "|---|---|---|---|---|---|"];
  for (const r of correctness.rows) if (r.status !== "ok") lines.push(`| ${r.game} | ${r.config} | ${r.check} | ${r.baseline ?? "–"} | ${r.candidate ?? "–"} | ${r.status} |`);
  lines.push("", `${correctness.rows.filter((r) => r.status === "ok").length} check(s) ok.`, "");
  lines.push("## Performance (paired; blocks only a confirmed ≥ 15 % regression)", "", "| Game | Config | Metric | Pairs | Median change | Regressed |", "|---|---|---|---|---|---|");
  for (const r of perf) lines.push(`| ${r.game} | ${r.config} | ${r.metric} | ${r.pairs} | ${r.median == null ? "–" : `${Math.round(r.median * 1000) / 10} %`} | ${r.regressed ? "yes" : "no"} |`);
  const d = decide({ correctness, perf });
  const text = d.ok
    ? "Gate: PASS."
    : d.reason === "inconclusive"
      ? "Gate: INCONCLUSIF, blocking (a check could not be judged on the candidate)."
      : d.reason === "correctness"
        ? `Gate: FAIL (${correctness.blocking.length} correctness regression(s)).`
        : `Gate: FAIL (confirmed performance regression: ${perf.filter((r) => r.regressed).map((r) => `${r.game}/${r.config} ${r.metric}`).join(", ")}).`;
  lines.push("", text);
  return lines.join("\n");
}

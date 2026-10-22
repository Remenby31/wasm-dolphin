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

// Expected failures (harness/known-failures.json, "mode": "expected-fail"):
// a check main is known to fail until a named follow-up fixes it, e.g. a
// test added before its implementation. The entry pins how it fails
// (`detail`, a regular expression on the check's detail): that failure is
// XFAIL, reported and not blocking; any other failure of the cell, a blank
// picture above all, stays a regression. A pass is XPASS and blocks, so the
// PR that fixes it must also remove the entry. `until` names that follow-up.
//
// The list is read from the candidate's tree: a PR could break a check and
// declare it expected-fail at once. So an XFAIL whose baseline PASSES the
// check (a new entry, or a feature main cannot exercise) carries a visible
// warning for the reviewer. An entry for a game the run has but a cell it
// does not is stale and blocks; games the run does not have are not judged.
export const EXPECTED_FAIL = "expected-fail";
export function expectedFailures(known = []) {
  const out = new Map();
  for (const x of known) {
    if (x.mode !== EXPECTED_FAIL) continue;
    if (typeof x.cell !== "string" || !/^[^/]+\/[^/]+$/.test(x.cell)) throw new Error(`known-failures: expected-fail entry needs a cell "game/config", got ${JSON.stringify(x.cell)}`);
    if (!CHECKS.includes(x.check)) throw new Error(`known-failures: expected-fail ${x.cell} needs a check among ${CHECKS.join(", ")}, not "${x.check}"`);
    for (const field of ["reason", "until", "detail"]) {
      if (typeof x[field] !== "string" || !x[field].trim()) throw new Error(`known-failures: expected-fail ${x.cell} needs a ${field}`);
    }
    const k = `${x.cell}\u0000${x.check}`;
    if (out.has(k)) throw new Error(`known-failures: expected-fail ${x.cell} ${x.check} is listed twice`);
    out.set(k, { cell: x.cell, check: x.check, reason: x.reason.trim(), until: x.until.trim(), detail: new RegExp(x.detail) });
  }
  return out;
}

export function correctnessGate(baselineCells, candidateCells, { expected = new Map() } = {}) {
  const base = new Map(baselineCells.map((c) => [key(c), c]));
  const rows = [];
  const used = new Set();
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
      const xkey = `${cand.game}/${cand.config}\u0000${check}`;
      const xf = expected.get(xkey);
      if (xf) used.add(xkey);
      let detail = cand.checks?.[check]?.detail ?? null;
      const asExpected = xf && cs === "fail" && xf.detail.test(String(detail ?? "")) && !/blank/.test(String(detail ?? ""));
      if (asExpected) {
        status = "xfail";
        detail = `expected to fail until ${xf.until}: ${xf.reason} (failed: ${detail})` +
          (bs === "pass" ? ". WARNING: the baseline passes this check; a new expected-fail must be justified in the PR" : "");
      } else if (xf && cs === "pass") { status = "xpass"; detail = `passes but is listed as expected-fail (until ${xf.until}): remove its entry from harness/known-failures.json`; }
      else if (cs === "fail") {
        status = bs === "fail" && same ? "known-failure" : "regressed";
        if (xf) detail = `${detail} (listed as expected-fail, but not the expected failure ${xf.detail})`;
      }
      else if (cs === "unjudged") status = bs === "unjudged" ? "not-covered" : "inconclusive";
      else status = bs === "fail" ? "fixed" : "ok";
      rows.push({ game: cand.game, config: cand.config, check, baseline: bs, candidate: cs, status, detail });
    }
  }
  for (const b of base.values()) rows.push({ game: b.game, config: b.config, check: "*", baseline: "present", candidate: null, status: "missing" });
  const games = new Set(candidateCells.map((c) => c.game));
  for (const [k, xf] of expected) {
    if (used.has(k) || !games.has(xf.cell.split("/")[0])) continue;
    const [game, config] = xf.cell.split("/");
    rows.push({ game, config, check: xf.check, baseline: null, candidate: null, status: "stale-expected", detail: "listed as expected-fail, but the run has no such cell: remove or fix the entry" });
  }
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
  const blocking = rows.filter((r) => r.status === "regressed" || r.status === "missing" || r.status === "inconclusive" || r.status === "xpass" || r.status === "stale-expected");
  return {
    ok: rows.length > 0 && blocking.length === 0,
    inconclusive: rows.length === 0 || (blocking.length > 0 && blocking.every((r) => r.status === "inconclusive")),
    rows,
    blocking
  };
}

// Chrome renderer crashes that did not happen again when the cell was run
// once more (runPlan): "infra-crash", reported, not blocking. Crashes that
// did happen again are in the crash check. One exception: renderer crashes
// only on the candidate, twice or more in one comparison, are a regression
// (a rare crash the candidate makes less rare). CDP pipe faults (the harness
// lost Chrome, browser.mjs) are listed but never counted against a side.
export function infraCrashGate(baseRecords, candRecords) {
  const infra = (records) => records.filter((r) => r.infraCrash);
  const b = infra(baseRecords), c = infra(candRecords);
  const what = (r) => (r.infraCrash.kind === "cdp-pipe" ? `CDP pipe fault${r.infraCrash.repeated ? ", again: unjudged" : ", not again"}` : "renderer crash, not again");
  const rows = [
    ...b.map((r) => ({ game: r.game, config: r.config, check: `infraCrash r${r.run}`, baseline: what(r), candidate: null, status: "infra-crash", detail: r.infraCrash.evidence })),
    ...c.map((r) => ({ game: r.game, config: r.config, check: `infraCrash r${r.run}`, baseline: null, candidate: what(r), status: "infra-crash", detail: r.infraCrash.evidence }))
  ];
  const renderer = (list) => list.filter((r) => r.infraCrash.kind !== "cdp-pipe").length;
  if (renderer(c) >= 2 && renderer(b) === 0) {
    rows.push({ game: "*", config: "*", check: "infraCrash", baseline: "0", candidate: String(c.length), status: "regressed", detail: "renderer crashes on the candidate only, twice or more" });
  }
  // No rows is fine here (no crash), unlike the other gates.
  const g = summarize(rows);
  return { ...g, ok: g.blocking.length === 0, inconclusive: false, infraCrashes: { baseline: b.length, candidate: c.length } };
}

// Rows from renderVsBaseline (render-check.mjs) on the candidate records.
export function crossCommitGate(candRecords) {
  const rows = candRecords.map((r) => {
    const st = r.renderVsBaseline?.status ?? "unjudged";
    // report-only (known-failures.json): shown with what it would have been, never blocking.
    const candidate = st === "report-only" ? `report-only (would be ${r.renderVsBaseline.wouldBe})` : st;
    return {
      game: r.game, config: r.config, check: `renderVsBaseline r${r.run}`, baseline: "capture", candidate,
      status: st === "fail" ? "regressed" : st === "pass" ? "ok" : st === "known" ? "known-failure" : st === "not-covered" ? "not-covered" : st === "report-only" ? "report-only" : "inconclusive",
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
  const infra = correctness.rows.filter((r) => r.status === "infra-crash");
  for (const r of correctness.rows.filter((x) => ["xfail", "xpass", "stale-expected"].includes(x.status))) {
    const label = r.status === "xpass" ? "**XPASS (blocks)**" : r.status === "stale-expected" ? "**Stale expected-fail entry (blocks)**" : /WARNING/.test(r.detail) ? "XFAIL (not blocking) ⚠" : "XFAIL (not blocking)";
    lines.push("", `${label} ${r.game}/${r.config} ${r.check}: ${r.detail}`);
  }
  lines.push("", `${correctness.rows.filter((r) => r.status === "ok").length} check(s) ok.${infra.length ? ` ${infra.length} infra crash(es): a Chrome renderer crash that did not happen again on a second run (not blocking; counted in harness/results/infra-crashes.jsonl).` : ""}`, "");
  lines.push("## Performance (paired; blocks only a confirmed ≥ 15 % regression)", "", "| Game | Config | Metric | Pairs | Median change | Regressed |", "|---|---|---|---|---|---|");
  for (const r of perf) lines.push(`| ${r.game} | ${r.config} | ${r.metric} | ${r.pairs} (${r.confirmations ?? 0} confirmation) | ${r.median == null ? "–" : `${Math.round(r.median * 1000) / 10} %`} | ${r.regressed ? "yes, confirmed" : r.inconclusive ? "worse, confirmations unmeasured" : r.worse ? "worse, not confirmed" : "no"} |`);
  const d = decide({ correctness, perf });
  const text = d.ok
    ? "Gate: PASS."
    : d.reason === "inconclusive"
      ? "Gate: INCONCLUSIF, blocking (a check, or a performance confirmation, could not be judged on the candidate)."
      : d.reason === "correctness"
        ? `Gate: FAIL (${correctness.blocking.length} correctness regression(s)${correctness.blocking.some((r) => r.status === "xpass") ? ", including an expected failure that now passes: remove its entry" : ""}).`
        : `Gate: FAIL (confirmed performance regression: ${perf.filter((r) => r.regressed).map((r) => `${r.game}/${r.config} ${r.metric}`).join(", ")}).`;
  lines.push("", text);
  return lines.join("\n");
}

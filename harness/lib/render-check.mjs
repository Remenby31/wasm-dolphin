// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Render check on exact captures only (core-side capture at a VI output,
// see browser.mjs captureAtVi). Each run's capture is compared with the
// reference config's capture of the same game and the same run, and must be
// the same VI output. Wall-clock screenshots are never judged.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { compareFrames, DEFAULT_THRESHOLDS, differingPixels, identical } from "./image-diff.mjs";
import { decodePng } from "./png.mjs";

const PASS = new Set(["identical", "match"]);
const cpuOf = (url) => {
  try {
    return new URL(url).searchParams.get("cpu") ?? "dual";
  } catch {
    return null;
  }
};
const videoOf = (url) => {
  try {
    return new URL(url).searchParams.get("video") ?? "software";
  } catch {
    return null;
  }
};

export function renderChecks(records, reference, loadFrame = (file) => (existsSync(file ?? "") ? decodePng(readFileSync(file)) : null)) {
  const frames = new Map();
  const load = (file) => {
    if (!file) return null;
    if (!frames.has(file)) frames.set(file, loadFrame(file));
    return frames.get(file);
  };
  const isBlank = (f) => compareFrames(f, f).candidateSigma < DEFAULT_THRESHOLDS.blankSigma;
  for (const r of records) {
    const cap = r.capture;
    if (!cap?.file) { r.render = { status: "unjudged", detail: cap?.error ?? "no exact capture" }; continue; }
    const frame = load(cap.file);
    if (!frame) { r.render = { status: "unjudged", detail: "capture file missing" }; continue; }
    // The absolute check applies to everyone, the reference included.
    if (isBlank(frame)) { r.render = { status: "fail", detail: "blank" }; continue; }
    if (!reference || r.config === reference) { r.render = { status: "pass", detail: reference ? "reference" : "not blank (no reference config)" }; continue; }
    const ref = records.find((x) => x.game === r.game && x.config === reference && x.run === r.run);
    const refFrame = ref?.capture?.file && load(ref.capture.file);
    if (!refFrame) { r.render = { status: "unjudged", detail: `no reference capture for run ${r.run}` }; continue; }
    if (isBlank(refFrame)) { r.render = { status: "unjudged", detail: `reference ${ref.label} is blank` }; continue; }
    if (ref.capture.index !== cap.index || Boolean(ref.capture.fromLoad) !== Boolean(cap.fromLoad)) {
      r.render = { status: "unjudged", detail: `not the same VI output as ${ref.label}` };
      continue;
    }
    // A cpu=single cell against a cpu=dual reference (or the reverse): VI
    // output N is not the same emulated frame, even with the same renderer.
    if (cpuOf(r.url) !== cpuOf(ref.url)) {
      r.render = { status: "unjudged", detail: `not blank; reference ${ref.label} runs another cpu mode (${cpuOf(ref.url)}): VI output N is not the same emulated frame` };
      continue;
    }
    const { blockMap, ...score } = compareFrames(refFrame, frame);
    const verdict = identical(refFrame, frame) ? "identical" : score.verdict;
    // Same renderer, same emulated frame: the pictures must be the same
    // bytes (a still scene shifted by 4 px is a failure, not a "match").
    // Only different renderers may legitimately differ in detail.
    const sameRenderer = videoOf(r.url) === videoOf(ref.url);
    // Across renderers, VI N is the same emulated frame only single-threaded.
    if (!sameRenderer && !(cpuOf(r.url) === "single" && cpuOf(ref.url) === "single")) {
      r.render = { status: "unjudged", detail: "different renderers in dual core: VI output N is not the same emulated frame (use cpu=single)" };
      continue;
    }
    const ok = sameRenderer ? verdict === "identical" : PASS.has(verdict);
    r.render = { status: ok ? "pass" : "fail", detail: verdict, exact: sameRenderer, ssim: score.ssim, lostDetail: score.lostDetail, extentDelta: score.extentDelta, against: ref.label };
  }
  return records;
}

// Cross-commit check (ab), per cell (game, config). Each side's captures of
// the cell (one per run, same VI output) must first agree with each other:
// - both sides consistent: the candidate's picture must be the baseline's
//   (byte for byte); an intended change is accepted only explicitly
//   (`accept`: "game/config").
// - baseline inconsistent, candidate consistent: "known" (not blocking) if
//   the candidate's picture is one of main's; if not, and the cell is listed
//   in harness/known-failures.json, "known" only if it is no further from
//   the closest baseline picture than main's pictures are from each other;
//   otherwise "inconclusive" (blocks). A stable but wrong candidate never passes.
// - baseline consistent, candidate inconsistent: the candidate introduced
//   nondeterminism: "fail".
// - both inconsistent: "known" if the cell is listed in
//   harness/known-failures.json, otherwise "inconclusive" (blocks).
// This catches what all configs of one commit get wrong together (e.g.
// geometry gone under interpreter and JIT alike).
//
// A cell listed with `"mode": "set-equal"` (and a mandatory `reason`) is one
// whose picture order is known to vary between runs (e.g. a dual-core race
// state). It is judged on the sets of pictures instead, both sides together:
// - "fail" if a side crashed or gave a blank picture;
// - "inconclusive" with fewer than SET_EQUAL_MIN_RUNS runs on a side;
// - "fail" if the candidate gave a picture the baseline never gave in any run;
// - "pass" otherwise: every candidate picture was seen on the baseline (a
//   baseline picture the candidate did not hit is sampling, not a regression).
// Cells not listed this way keep the rules above.
//
// A cell listed with `"mode": "report-only"` (and a mandatory `reason`) is
// one whose picture cannot be held to a baseline at all (e.g. the race state
// in dual core: several pictures per commit, none of them a fixed set). Its
// verdict is computed as if it were not listed, shown, and never blocks
// ("report-only"). Only renderVsBaseline is relaxed: the cell's crash,
// errors, coreFreeze, render (not blank), audio and perf checks still block.
// The exact render check of such a game belongs to a cpu=single cell.
export const SET_EQUAL_MIN_RUNS = 3;
export const RENDER_MODES = Object.freeze(["set-equal", "report-only"]);

// cell → { mode, reason } for the renderVsBaseline entries that set a mode.
export function renderModes(known) {
  const modes = new Map();
  for (const x of known) {
    if (x.check !== "renderVsBaseline" || x.mode == null) continue;
    if (!RENDER_MODES.includes(x.mode)) throw new Error(`known-failures: unknown mode "${x.mode}" for ${x.cell}`);
    if (typeof x.reason !== "string" || !x.reason.trim()) throw new Error(`known-failures: ${x.mode} cell ${x.cell} needs a reason`);
    if (modes.has(x.cell) && modes.get(x.cell).mode !== x.mode) throw new Error(`known-failures: ${x.cell} listed as both ${modes.get(x.cell).mode} and ${x.mode}`);
    modes.set(x.cell, { mode: x.mode, reason: x.reason.trim() });
  }
  return modes;
}

const cellsWith = (known, mode) => new Set([...renderModes(known)].filter(([, m]) => m.mode === mode).map(([cell]) => cell));
export const setEqualCells = (known) => cellsWith(known, "set-equal");
export const reportOnlyCells = (known) => cellsWith(known, "report-only");

const crashedRun = (r) => Boolean(r.crashed || r.rendererCrash || r.errors?.length);

export function renderVsBaseline(baseRecords, candRecords, { accept = [], known = [], loadFrame = defaultLoad } = {}) {
  const modes = renderModes(known);
  const digests = new Map();
  const digestOf = (file) => {
    if (!digests.has(file)) {
      const f = loadFrame(file);
      digests.set(file, f ? createHash("sha256").update(`${f.width}x${f.height}`).update(f.data).digest("hex") : null);
    }
    return digests.get(file);
  };
  const cells = new Map();
  for (const c of candRecords) {
    const k = `${c.game}/${c.config}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(c);
  }
  for (const [cell, cand] of cells) {
    const base = baseRecords.filter((b) => `${b.game}/${b.config}` === cell);
    const mode = modes.get(cell);
    const verdict = mode?.mode === "set-equal"
      ? setEqualVerdict(base, cand, loadFrame)
      : cellVerdict(cell, base, cand, { accept, known: mode?.mode === "report-only" ? known.filter((x) => x.cell !== cell) : known, digestOf, loadFrame });
    const result = mode?.mode === "report-only" ? reportOnly(verdict, mode.reason) : verdict;
    for (const r of cand) r.renderVsBaseline = result;
  }
  return candRecords;
}

// What a report-only cell would have been given, kept for the report.
function reportOnly(verdict, reason) {
  const { status, detail, ...evidence } = verdict;
  return { status: "report-only", wouldBe: status, detail: `report-only (${reason}): would be ${status}${detail ? `, ${detail}` : ""}`, ...evidence };
}

function cellVerdict(cell, base, cand, { accept, known, digestOf, loadFrame }) {
  // Nothing to compare when the baseline has no capture either; the
  // candidate losing a capture the baseline had cannot be judged (blocks).
  if (!base.some((b) => b.capture?.file)) return { status: "not-covered", detail: base[0]?.capture?.error ?? "baseline has no capture" };
  if (cand.some((c) => !c.capture?.file)) return { status: "unjudged", detail: cand.find((c) => !c.capture?.file).capture?.error ?? "no exact capture" };
  if (base.some((b) => !b.capture?.file)) return { status: "unjudged", detail: "baseline capture missing in some runs" };
  const vi = (r) => `${r.capture.index}/${Boolean(r.capture.fromLoad)}`;
  if (new Set([...base, ...cand].map(vi)).size !== 1) return { status: "unjudged", detail: "not the same VI output as the baseline" };
  const baseSet = [...new Set(base.map((b) => digestOf(b.capture.file)))];
  const candSet = [...new Set(cand.map((c) => digestOf(c.capture.file)))];
  const short = (list) => list.map((d) => d?.slice(0, 8));
  const evidence = { baselineDigests: short(baseSet), candidateDigests: short(candSet) };
  let result;
  const listed = known.some((x) => x.cell === cell && x.check === "renderVsBaseline");
  if (baseSet.length > 1 && candSet.length === 1) {
    if (baseSet.includes(candSet[0])) {
      // The candidate is one of the pictures main produces: nothing new.
      result = { status: "known", detail: "baseline-nondeterministic", ...evidence };
    } else if (listed) {
      // Main's known nondeterminism defines the tolerance: the candidate may
      // differ from the closest baseline picture by no more pixels than
      // main's own pictures differ from each other. (Image-diff "match"
      // thresholds are far too lax for this: removing gxscene's cubes,
      // 8 % of the pixels, still scores SSIM 0.91.)
      const files = [...new Set(base.map((b) => b.capture.file))];
      const frames = files.map((f) => loadFrame(f));
      let spread = 0;
      for (let i = 0; i < frames.length; i += 1) for (let j = i + 1; j < frames.length; j += 1) spread = Math.max(spread, differingPixels(frames[i], frames[j]) ?? Infinity);
      const candFrame = loadFrame(cand[0].capture.file);
      const nearest = Math.min(...frames.map((f) => differingPixels(f, candFrame) ?? Infinity));
      result = nearest <= spread
        ? { status: "known", detail: `baseline-nondeterministic (listed; candidate within main's variation: ${nearest} px ≤ ${spread} px)`, ...evidence }
        : { status: "inconclusive", detail: `baseline-nondeterministic, and the candidate is outside main's variation (${nearest} px > ${spread} px)`, ...evidence };
    } else {
      result = { status: "inconclusive", detail: "baseline-nondeterministic, and the candidate is none of its pictures", ...evidence };
    }
  } else if (baseSet.length === 1 && candSet.length > 1) {
    result = { status: "fail", detail: "candidate-nondeterministic", ...evidence };
  } else if (baseSet.length > 1 && candSet.length > 1) {
    result = { status: listed ? "known" : "inconclusive", detail: `both-nondeterministic${listed ? " (listed in known-failures.json)" : ""}`, ...evidence };
  } else if (baseSet[0] === candSet[0]) {
    result = { status: "pass" };
  } else {
    const accepted = accept.includes(cell);
    result = { status: accepted ? "pass" : "fail", detail: accepted ? "changed (accepted)" : "different from the baseline at the same VI output", ...evidence };
  }
  return result;
}

function setEqualVerdict(base, cand, loadFrame) {
  const sides = [["baseline", base], ["candidate", cand]];
  for (const [side, runs] of sides) {
    const bad = runs.find(crashedRun);
    if (bad) return { status: "fail", detail: `set-equal: ${side} run ${bad.run} crashed` };
  }
  const frames = new Map();
  for (const [side, runs] of sides) {
    for (const r of runs) {
      if (!r.capture?.file) return { status: "unjudged", detail: `set-equal: ${side} run ${r.run} has no exact capture` };
      const f = loadFrame(r.capture.file);
      if (!f) return { status: "unjudged", detail: `set-equal: ${side} run ${r.run} capture file missing` };
      if (compareFrames(f, f).candidateSigma < DEFAULT_THRESHOLDS.blankSigma) return { status: "fail", detail: `set-equal: ${side} run ${r.run} is blank` };
      frames.set(r.capture.file, createHash("sha256").update(`${f.width}x${f.height}`).update(f.data).digest("hex"));
    }
  }
  const vi = (r) => `${r.capture.index}/${Boolean(r.capture.fromLoad)}`;
  if (new Set([...base, ...cand].map(vi)).size !== 1) return { status: "unjudged", detail: "set-equal: not the same VI output on every run" };
  const baseSet = new Set(base.map((r) => frames.get(r.capture.file)));
  const candSet = new Set(cand.map((r) => frames.get(r.capture.file)));
  const evidence = { baselineDigests: [...baseSet].map((d) => d.slice(0, 8)), candidateDigests: [...candSet].map((d) => d.slice(0, 8)) };
  if (base.length < SET_EQUAL_MIN_RUNS || cand.length < SET_EQUAL_MIN_RUNS) {
    return { status: "inconclusive", detail: `set-equal: ${base.length} baseline / ${cand.length} candidate run(s), ${SET_EQUAL_MIN_RUNS} needed per side`, ...evidence };
  }
  const novel = [...candSet].filter((d) => !baseSet.has(d));
  if (novel.length) return { status: "fail", detail: `set-equal: candidate picture(s) never seen on the baseline: ${novel.map((d) => d.slice(0, 8)).join(", ")}`, ...evidence };
  // A baseline picture the candidate did not hit is sampling, not a
  // regression: a wrong picture shows up as a novel digest above.
  const missing = [...baseSet].filter((d) => !candSet.has(d));
  if (missing.length) return { status: "pass", detail: `set-equal (listed): candidate pictures all seen on the baseline; ${missing.length} baseline picture(s) not sampled on the candidate`, ...evidence };
  return { status: "pass", detail: `set-equal (listed): same ${baseSet.size} picture(s) on both sides`, ...evidence };
}

const defaultLoad = (file) => (existsSync(file ?? "") ? decodePng(readFileSync(file)) : null);

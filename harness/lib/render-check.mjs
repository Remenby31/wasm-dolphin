// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Render check on exact captures only (core-side capture at a VI output,
// see browser.mjs captureAtVi). Each run's capture is compared with the
// reference config's capture of the same game and the same run, and must be
// the same VI output. Wall-clock screenshots are never judged.
import { existsSync, readFileSync } from "node:fs";
import { compareFrames, DEFAULT_THRESHOLDS, identical } from "./image-diff.mjs";
import { decodePng } from "./png.mjs";

const PASS = new Set(["identical", "match"]);
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
    const { blockMap, ...score } = compareFrames(refFrame, frame);
    const verdict = identical(refFrame, frame) ? "identical" : score.verdict;
    // Same renderer, same emulated frame: the pictures must be the same
    // bytes (a still scene shifted by 4 px is a failure, not a "match").
    // Only different renderers may legitimately differ in detail.
    const sameRenderer = videoOf(r.url) === videoOf(ref.url);
    const ok = sameRenderer ? verdict === "identical" : PASS.has(verdict);
    r.render = { status: ok ? "pass" : "fail", detail: verdict, exact: sameRenderer, ssim: score.ssim, lostDetail: score.lostDetail, extentDelta: score.extentDelta, against: ref.label };
  }
  return records;
}

// Cross-commit check (ab): the candidate's capture of a cell must be the
// same bytes as the baseline's capture of the same cell, run and VI output.
// This catches what both configs of one commit get wrong together (e.g.
// geometry gone from the software raster under interpreter and JIT alike).
// An intended change is accepted only explicitly (`accept`: "game/config").
export function renderVsBaseline(baseRecords, candRecords, { accept = [], loadFrame = (file) => (existsSync(file ?? "") ? decodePng(readFileSync(file)) : null) } = {}) {
  for (const c of candRecords) {
    const b = baseRecords.find((x) => x.game === c.game && x.config === c.config && x.run === c.run);
    // Nothing to compare when the baseline has no capture either; the
    // candidate losing a capture the baseline had cannot be judged (blocks).
    if (!b?.capture?.file) { c.renderVsBaseline = { status: "not-covered", detail: b ? b.capture?.error ?? "baseline has no capture" : "no baseline run" }; continue; }
    if (!c.capture?.file) { c.renderVsBaseline = { status: "unjudged", detail: c.capture?.error ?? "no exact capture" }; continue; }
    if (b.capture.index !== c.capture.index || Boolean(b.capture.fromLoad) !== Boolean(c.capture.fromLoad)) {
      c.renderVsBaseline = { status: "unjudged", detail: "not the same VI output as the baseline" };
      continue;
    }
    const same = identical(loadFrame(b.capture.file), loadFrame(c.capture.file));
    const accepted = accept.includes(`${c.game}/${c.config}`);
    c.renderVsBaseline = same ? { status: "pass" } : { status: accepted ? "pass" : "fail", detail: accepted ? "changed (accepted)" : "different from the baseline at the same VI output" };
  }
  return candRecords;
}

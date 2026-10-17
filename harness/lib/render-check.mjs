// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Render check on exact captures only (core-side capture at a VI output,
// see browser.mjs captureAtVi). Each run's capture is compared with the
// reference config's capture of the same game and the same run, and must be
// the same emulated frame (same tick count). Wall-clock screenshots are
// never judged.
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
    if (ref.capture.ticks !== cap.ticks) {
      r.render = { status: "unjudged", detail: `not the same emulated frame as ${ref.label} (ticks ${cap.ticks} vs ${ref.capture.ticks})` };
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

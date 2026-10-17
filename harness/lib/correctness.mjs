// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The checks the blocking gate is made of (correctness only, never timing
// thresholds). Each check of each run is "pass", "fail" or "unjudged" (with
// the reason it could not be judged). Machine load changes none of them.
// Pure.

export const CHECKS = Object.freeze(["crash", "errors", "coreFreeze", "render", "audio"]);

export const SILENT_PEAK = 1e-3;

// Crash identity: the first line of the error with numbers blanked, so the
// same failure matches across runs and an unrelated new crash does not.
export function crashSignature(text) {
  return String(text ?? "crash").split("\n")[0].replace(/0x[0-9a-f]+|\d+/gi, "#").trim();
}

export function runChecks(record) {
  const s = record.summary ?? {};
  const out = {};
  const fatal = record.errors?.find((e) => e.text !== "ErrorEvent") ?? record.errors?.[0];
  out.crash = record.crashed || record.errors?.length
    ? { status: "fail", detail: crashSignature(fatal?.text) }
    : { status: "pass" };
  out.errors = s.errorCount > 0 ? { status: "fail", detail: s.swallowed } : { status: "pass" };
  if (!s.viTimeline) out.coreFreeze = { status: "unjudged", detail: s.viTimelineWhy ?? "no VI timeline" };
  else if (!s.timelineComplete) out.coreFreeze = { status: "unjudged", detail: "timeline incomplete (failed read, lost entries or clock mismatch)" };
  else if (s.coreFreezes?.length) out.coreFreeze = { status: "fail", detail: s.coreFreezes };
  else out.coreFreeze = { status: "pass" };
  out.render = record.render ?? { status: "unjudged", detail: "no render check" };
  if (!record.audioRequired) out.audio = { status: "pass", detail: "no sound required" };
  else if (s.audioPeak == null) out.audio = { status: "unjudged", detail: "audio output not tapped" };
  else out.audio = s.audioPeak < SILENT_PEAK ? { status: "fail", detail: `silent (peak ${s.audioPeak})` } : { status: "pass" };
  return out;
}

// A cell fails a check if any run fails it; it is unjudged if any run could
// not be judged (and none failed); it passes only if every run passed.
export function cellChecks(runs) {
  const out = {};
  for (const check of CHECKS) {
    const states = runs.map((r) => (r.checks ?? runChecks(r))[check]);
    const failed = states.filter((x) => x.status === "fail");
    const unjudged = states.filter((x) => x.status === "unjudged");
    out[check] = failed.length
      ? { status: "fail", runs: failed.length, detail: failed[0].detail }
      : unjudged.length
        ? { status: "unjudged", runs: unjudged.length, detail: unjudged[0].detail }
        : { status: "pass" };
  }
  return out;
}

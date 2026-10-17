// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The checks the blocking gate is made of (correctness only, never timing
// thresholds). Each check of each run is "pass", "fail" or "unjudged" (with
// the reason it could not be judged). Machine load changes none of them.
// Pure.

export const CHECKS = Object.freeze(["crash", "errors", "coreFreeze", "render"]);

export function runChecks(record) {
  const s = record.summary ?? {};
  const out = {};
  out.crash = record.crashed || record.errors?.length
    ? { status: "fail", detail: record.errors?.[0]?.text?.split("\n")[0] ?? "crash" }
    : { status: "pass" };
  out.errors = s.errorCount > 0 ? { status: "fail", detail: s.swallowed } : { status: "pass" };
  if (!s.viTimeline) out.coreFreeze = { status: "unjudged", detail: "core has no VI timeline (rebuild the core)" };
  else if (!s.timelineComplete) out.coreFreeze = { status: "unjudged", detail: "timeline ring overflowed" };
  else if (s.coreFreezes?.length) out.coreFreeze = { status: "fail", detail: s.coreFreezes };
  else out.coreFreeze = { status: "pass" };
  out.render = record.render ?? { status: "unjudged", detail: "no render check" };
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

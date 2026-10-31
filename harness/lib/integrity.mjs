// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The replay's integrity gate (glitch-meter G2): every probe reads the
// worker's validationReadIntegrity (src/wgpu-integrity.js) before and after
// what it measures, and a run whose fatal counters moved is INTEGRITY, left
// out like an overloaded one and named in the summary: a pass lost, a draw
// skipped, a resource missing, a record dropped or an uncaptured error passed
// through every speed pair before (the iPhone flicker, 2026-10-31).
import { existsSync } from "node:fs";
import path from "node:path";

import { INTEGRITY_FATAL } from "../../src/wgpu-integrity.js";
import { workerRequest } from "./browser.mjs";

const OLD_WORKER = /Unknown upstream worker message/;

// Whether a served tree has the counters (src/wgpu-integrity.js): then its
// worker must answer, and a missing answer is never "an older worker".
export function treeHasIntegrity(root) {
  return Boolean(root) && existsSync(path.join(root, "src", "wgpu-integrity.js"));
}

// The worker's counters; { unavailable } only for a worker that predates
// them (an older tree measured as a baseline: reported, never a failure);
// { unread } for any other failure to read them (a timeout, a crashed page
// or worker, or a tree that has the counters but did not answer), which
// fails the run like a fatal counter: a dead candidate never passes clean.
export async function readIntegrity(page, { expected = true } = {}) {
  let message;
  try {
    const r = await workerRequest(page, "validationReadIntegrity", {}, 10000);
    if (!r?.error) return r;
    message = String(r.error);
  } catch (e) {
    message = String(e?.message || e);
  }
  if (OLD_WORKER.test(message) && !expected) return { unavailable: "worker without validationReadIntegrity" };
  return { unread: OLD_WORKER.test(message) ? `the tree has the counters but its worker does not answer: ${message}` : message };
}

// TODO(2026-10-31, until patch 0207): a window right after a state load may
// see one batch aborted by the load's placement epoch (Spark, Chrome: 1 in 4
// post-load windows, no upload timeout). There batchAborts is reported, not
// fatal. 0207 gives aborts by cause: then only the load-epoch cause is exempt
// and this exception goes (PROGRAM.md, chutes).
export const POSTLOAD_TOLERATED = Object.freeze(["batchAborts"]);

// Over a window: the delta of every counter and the fatal ones that moved,
// but those allowed (a counter an older core does not print is null: no
// delta, never fatal). postload: a window that starts at a state load.
export function integrityOf(start, end, { allow = [], postload = false } = {}) {
  const unread = start?.unread ?? end?.unread;
  if (unread) return { unread, delta: {}, fatal: [`unread (${String(unread).slice(0, 120)})`], allowed: [] };
  // not read at all: a raw file from before the gate (--analyze)
  if (!start || !end || start.unavailable || end.unavailable) return { unavailable: start?.unavailable ?? end?.unavailable ?? "not read" };
  const delta = {};
  for (const k of Object.keys(end)) {
    if (k === "id" || typeof end[k] !== "number" || typeof start[k] !== "number") continue;
    delta[k] = end[k] - start[k];
  }
  const moved = INTEGRITY_FATAL.filter((k) => delta[k] > 0);
  if (postload) allow = [...allow, ...POSTLOAD_TOLERATED];
  return {
    delta,
    fatal: moved.filter((k) => !allow.includes(k)).map((k) => `${k} ${delta[k]}`),
    allowed: moved.filter((k) => allow.includes(k)).map((k) => `${k} ${delta[k]}`)
  };
}

// --integrity-allow a,b: counters a probe tolerates (a test that injects a
// device loss, say); each name must be a fatal counter.
export function parseIntegrityAllow(text = "") {
  const names = String(text ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const n of names) {
    if (!INTEGRITY_FATAL.includes(n)) throw new Error(`--integrity-allow ${n}: not an integrity counter (${INTEGRITY_FATAL.join(", ")})`);
  }
  return names;
}

// One note for a run's log: nothing when clean or unread.
export function integrityBrief(i) {
  if (!i || i.unavailable) return "";
  return [i.fatal.length ? ` INTEGRITY ${i.fatal.join(", ")}` : "", i.allowed?.length ? ` (allowed: ${i.allowed.join(", ")})` : ""].join("");
}

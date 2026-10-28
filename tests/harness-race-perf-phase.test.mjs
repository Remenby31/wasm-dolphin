// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { STEADY_MIN_WARMUP, windowPhase } from "../harness/probes/race-perf.mjs";

test("race-perf --phase: steady from 20 s after the load, postload the transient itself; defaults unchanged", () => {
  assert.equal(STEADY_MIN_WARMUP, 20);
  // no option: the defaults as before (25 s warmup, 20 s window), steady
  assert.deepEqual(windowPhase({}), { phase: "steady", warmup: 25, secs: 20 });
  // postload: 0 s after the load, 15 s, unless asked otherwise
  assert.deepEqual(windowPhase({ phase: "postload" }), { phase: "postload", warmup: 0, secs: 15 });
  assert.deepEqual(windowPhase({ phase: "postload", warmup: 2, secs: 10 }), { phase: "postload", warmup: 2, secs: 10 });
  // steady refuses a window inside the transient
  assert.throws(() => windowPhase({ phase: "steady", warmup: 5 }), /--phase steady --warmup 5: the first 20 s after the load are the post-load transient/);
  assert.deepEqual(windowPhase({ phase: "steady", warmup: 20, secs: 10 }), { phase: "steady", warmup: 20, secs: 10 });
  assert.throws(() => windowPhase({ phase: "warm" }), /--phase warm: steady or postload/);
});

test("race-perf: a --display window under 20 s after the load is labelled postload and warned about", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  // the protocol that measured the Spark's "holes" (2026-10-27/28): --warmup 5
  assert.deepEqual(windowPhase({ warmup: 5, secs: 10, display: true, warn }), { phase: "postload", warmup: 5, secs: 10 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /--warmup 5 with --display: the window is in the post-load transient/);
  // no warning without --display, nor with --phase postload (on purpose), nor at 20 s
  windowPhase({ warmup: 5, warn });
  windowPhase({ phase: "postload", display: true, warn });
  windowPhase({ warmup: 20, display: true, warn });
  assert.equal(warnings.length, 1);
});

test("race-perf: the summary records the phase next to the warmup", async () => {
  const src = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(src, /baselineQuery: sides\.baseline\?\.query \?\? null, phase: o\.phase, warmupSec: o\.warmup, secs: o\.secs,/);
  assert.match(src, /phase: \{ type: "string" \}/);
});

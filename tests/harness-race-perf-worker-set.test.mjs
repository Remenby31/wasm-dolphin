// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { workerSetsOf } from "../harness/probes/race-perf.mjs";

test("race-perf --worker-set: validationSet* requests with JSON payloads, one side each, sent before the windows", async () => {
  assert.deepEqual(workerSetsOf(undefined, "worker-set"), []);
  assert.deepEqual(workerSetsOf('validationSetWgpuPerturbation={"readbackNoMap":true}', "worker-set"),
    [{ name: "validationSetWgpuPerturbation", payload: { readbackNoMap: true } }]);
  assert.deepEqual(workerSetsOf('validationSetA={"x":1}; validationSetB', "worker-set").map((w) => [w.name, w.payload]),
    [["validationSetA", { x: 1 }], ["validationSetB", {}]]);
  assert.throws(() => workerSetsOf('validationReadTimeline={}', "worker-set"), /expected a validationSet\* worker request/);
  assert.throws(() => workerSetsOf('validationSetA={x}', "baseline-worker-set"), /--baseline-worker-set validationSetA: the payload is not JSON/);
  const src = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(src, /sides\.candidate = \{ \.\.\.resolveSide\("candidate", values\.candidate\), chromeArgs, workerSets \};/);
  assert.match(src, /query: baselineQuery, chromeArgs: baselineChromeArgs, workerSets: baselineWorkerSets \};/);
  // sent once the page is open, before measure() and its windows
  const side = src.slice(src.indexOf("async function measureSide("));
  assert.ok(side.indexOf("side.workerSets") < side.indexOf("record.cold = await timed(measure(session, o)"));
});

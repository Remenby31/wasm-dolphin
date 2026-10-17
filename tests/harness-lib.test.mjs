// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { expandMatrix, resolveQuery, summarizeMatrix, summarizeRun } from "../harness/lib/matrix.mjs";
import { decodePng, encodePng } from "../harness/lib/png.mjs";
import { describe, median, percentile, stdev } from "../harness/lib/stats.mjs";
import { validateSteps } from "../harness/lib/steps.mjs";
import { parsePsForProfile } from "../harness/lib/system.mjs";

test("stats: median, sample stdev and nearest-rank percentile ignore non-numbers", () => {
  assert.equal(median([3, 1, null, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(stdev([2, 4, 4, 4, 5, 5, 7, 9]).toFixed(3), "2.138");
  assert.equal(stdev([5]), 0);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.deepEqual(describe([]), { n: 0, median: null, mean: null, stdev: null, min: null, max: null });
});

test("matrix: presets resolve to URLs with metrics=1 and per-config overrides", () => {
  const q = new URLSearchParams(resolveQuery({ id: "x", preset: "rec", set: { jitwarmup: 120 } }));
  assert.equal(q.get("metrics"), "1");
  assert.equal(q.get("jitwarmup"), "120");
  assert.equal(q.get("video"), "software");
  assert.throws(() => resolveQuery({ id: "x", preset: "nope" }), /unknown preset/);
});

test("matrix: runs are interleaved across cells and local-only games never run in CI", () => {
  const spec = {
    runs: 2,
    games: [{ id: "a", iso: "${HB}/a.iso" }, { id: "rom", iso: "/r.iso", localOnly: true }],
    configs: [{ id: "rec", preset: "rec" }]
  };
  const plan = expandMatrix(spec, { env: { HB: "/hb" } });
  assert.deepEqual(plan.map((p) => p.label), ["a__rec__r1", "rom__rec__r1", "a__rec__r2", "rom__rec__r2"]);
  assert.equal(plan[0].game.iso, "/hb/a.iso");
  assert.throws(() => expandMatrix(spec, { env: { HB: "/hb", CI: "true" } }), /local-only/);
  assert.throws(() => expandMatrix(spec, { env: {} }), /HB is not set/);
});

// One run sampled twice at a constant speed, 60 presents/s, 150 % CPU.
const run = (speed) => ({ game: "g", config: "c", summary: summarizeRun([{ speed, pres: 60, frame: 0 }, { speed, pres: 60, frame: 60 }], [{ total: 150, rendererMax: 100, gpu: 20 }]) });

test("matrix: per-run means then median ± stdev across runs", () => {
  assert.equal(run(100).summary.frameAdvance, 60);
  const [cell] = summarizeMatrix([run(90), run(100), run(110)]);
  assert.equal(cell.runs, 3);
  assert.equal(cell.metrics.speed.median, 100);
  assert.equal(cell.metrics.speed.stdev, 10);
  assert.equal(cell.metrics.cpuTotal.median, 150);
});

test("matrix: zero presents while the core runs is flagged", () => {
  const frozen = { game: "g", config: "wgpu", summary: summarizeRun([{ pres: 0, frame: 10 }, { pres: 0, frame: 70 }]) };
  const [cell] = summarizeMatrix([frozen, run(100)]);
  assert.equal(cell.failedRuns, 1);
  assert.deepEqual(cell.flags, ["zero-presents"]);
});

test("png: encode/decode round trip", () => {
  const data = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 255);
  const back = decodePng(encodePng({ width: 3, height: 2, data }));
  assert.equal(back.width, 3);
  assert.deepEqual([...back.data], [...data]);
});

test("system: Chrome CPU is summed for the harness profile only", () => {
  const ps = [
    " 120.5 /Applications/Google Chrome.app/... --type=renderer --user-data-dir=/tmp/gc-harness-profile-A",
    "  30.0 /Applications/Google Chrome.app/... --type=gpu-process --user-data-dir=/tmp/gc-harness-profile-A",
    "  10.0 /Applications/Google Chrome.app/... --user-data-dir=/tmp/gc-harness-profile-A",
    " 400.0 /Applications/Google Chrome.app/... --type=renderer --user-data-dir=/tmp/other-agent"
  ].join("\n");
  assert.deepEqual(parsePsForProfile(ps, "/tmp/gc-harness-profile-A"), { total: 161, rendererMax: 121, gpu: 30, processes: 3 });
});

test("steps: each step has exactly one action", () => {
  assert.doesNotThrow(() => validateSteps([{ wait: 1 }, { tap: "Enter", repeat: 2 }, { pad: 1, state: {} }]));
  assert.throws(() => validateSteps([{ wait: 1, tap: "x" }]), /exactly one/);
});

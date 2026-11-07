// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { expandMatrix, resolveQuery, summarizeMatrix, summarizeRun } from "../harness/lib/matrix.mjs";
import { decodePng, encodePng } from "../harness/lib/png.mjs";
import { describe, median, percentile, stdev } from "../harness/lib/stats.mjs";
import { validateSteps } from "../harness/lib/steps.mjs";
import { cpuFromProcessInfo, parsePsForProfile } from "../harness/lib/system.mjs";

test("stats: median, sample stdev and nearest-rank percentile ignore non-numbers", () => {
  assert.equal(median([3, 1, null, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(stdev([2, 4, 4, 4, 5, 5, 7, 9]).toFixed(3), "2.138");
  assert.equal(stdev([5]), 0);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.deepEqual(describe([]), { n: 0, median: null, mean: null, stdev: null, iqr: null, min: null, max: null });
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

test("matrix: a game's own set applies to every config, over the config's", () => {
  const spec = {
    runs: 1,
    games: [{ id: "peek", iso: "/p.iso", set: { efbaccess: "1", cpu: "single" } }, { id: "plain", iso: "/q.iso" }],
    configs: [{ id: "sw", preset: "sw-interp", set: { cpu: "dual" } }]
  };
  const [peek, plain] = expandMatrix(spec, { env: {} });
  const q = new URLSearchParams(peek.query);
  assert.equal(q.get("efbaccess"), "1");
  assert.equal(q.get("cpu"), "single");
  assert.equal(new URLSearchParams(plain.query).get("efbaccess"), null);
  assert.equal(new URLSearchParams(plain.query).get("cpu"), "dual");
});

// One run sampled twice at a constant speed (no VI timeline: the app's
// sampled gameSpeed is used and labelled as such), 150 % CPU.
const run = (speed) => ({ game: "g", config: "c", summary: summarizeRun({ samples: [{ t: 0, speed, frame: 0 }, { t: 1000, speed, frame: 60 }], cpu: [{ total: 150, rendererMax: 100, gpu: 20 }] }) });

test("matrix: per-run medians then median ± stdev across runs", () => {
  assert.equal(run(100).summary.frameAdvance, 60);
  assert.equal(run(100).summary.speedSource, "sampled gameSpeed");
  const [cell] = summarizeMatrix([run(90), run(100), run(110)]);
  assert.equal(cell.runs, 3);
  assert.equal(cell.metrics.speed.median, 100);
  assert.equal(cell.metrics.speed.stdev, 10);
  assert.equal(cell.metrics.cpuTotal.median, 150);
  // Without a VI timeline the core-freeze check cannot be judged.
  assert.equal(cell.checks.coreFreeze.status, "unjudged");
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

test("cpuFromProcessInfo: Windows CPU from two CDP process snapshots (100 = one core)", () => {
  const before = [{ type: "browser", id: 1, cpuTime: 1 }, { type: "renderer", id: 2, cpuTime: 10 }, { type: "GPU", id: 3, cpuTime: 2 }];
  const after = [{ type: "browser", id: 1, cpuTime: 1.1 }, { type: "renderer", id: 2, cpuTime: 11.5 }, { type: "GPU", id: 3, cpuTime: 2.3 }, { type: "renderer", id: 4, cpuTime: 0.2 }];
  assert.deepEqual(cpuFromProcessInfo(before, after, 1000), { total: 210, rendererMax: 150, gpu: 30, processes: 4 });
  assert.equal(cpuFromProcessInfo(null, after, 1000), null);
  assert.equal(cpuFromProcessInfo(before, after, 0), null);
});

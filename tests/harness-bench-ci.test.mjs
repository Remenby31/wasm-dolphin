// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { armPmus } from "../harness/lib/perf-counters.mjs";
import { isHomebrew } from "../harness/probes/race-perf.mjs";
import { benchAA, benchMarkdown } from "../harness/remote/bench-aa.mjs";

const workflow = readFileSync(new URL("../.github/workflows/bench.yml", import.meta.url), "utf8");

test("CI bench: manual or bench/** pushes only, never a disc, read-only token, both architectures", () => {
  const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
  assert.match(on, /workflow_dispatch:/);
  assert.match(on, /push:\n\s+branches: \["bench\/\*\*"\]/);
  assert.doesNotMatch(on, /pull_request|branches: \[main\]/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write|actions: write|secrets\./);
  assert.match(workflow, /runner: \[ubuntu-24\.04, ubuntu-24\.04-arm\]/);
  // Our homebrew fixture only: no ISO, no savestate, nothing from roms/.
  assert.match(workflow, /--iso harness\/homebrew\/fixtures\/cpufuzz\.dol/);
  assert.doesNotMatch(workflow, /--state|\.sav\b|roms\/|\.iso\b/);
  assert.match(workflow, /--pin-cpu-thread 0/);
  assert.match(workflow, /lscpu/);
});

test("race-perf: only our homebrews (out/ or the committed fixtures) count as homebrew", () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  assert.equal(isHomebrew(path.join(root, "harness/homebrew/fixtures/cpufuzz.dol")), true);
  assert.equal(isHomebrew(path.join(root, "harness/homebrew/out/padtest.iso")), true);
  assert.equal(isHomebrew(path.join(root, "harness/homebrew/fixtures-evil/x.iso")), false);
  assert.equal(isHomebrew(path.join(root, "..", "roms", "disc.iso")), false);
});

test("perf counters: arm PMUs read from sysfs, the Spark's when none is listed", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pmus-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const d of ["armv8_pmuv3_0", "breakpoint", "software"]) mkdirSync(path.join(dir, d));
  assert.deepEqual(armPmus(dir), ["armv8_pmuv3_0"]);
  assert.deepEqual(armPmus(path.join(dir, "missing")), ["armv8_pmuv3_0", "armv8_pmuv3_1"]);
});

test("CI bench A/A: warm-up pair and mispinned pairs set aside; σ per run and per pair, drift, pairs for 2 %", () => {
  const pin = (thread = "DedicatedWorker", busyPct = 99) => ({ thread, busyPct, cpu: 0 });
  const run = (n, a, b, p = pin()) => ({ run: n, baseline: { cold: { speed: a, pinned: pin() } }, candidate: { cold: { speed: b, pinned: p } } });
  const b = benchAA([run(1, 300, 250), run(2, 300, 303), run(3, 300, 297), run(4, 306, 306), run(5, 294, 294), run(6, 300, 300), run(7, 300, 300),
    run(8, 300, 200, pin("ThreadPoolForeg", 60)), run(9, 300, 220, pin("DedicatedWorker", 40))], { cpuModel: "AMD EPYC 7763 64-Core Processor", runner: "ubuntu-24.04", arch: "x86_64", pmu: "none" });
  assert.deepEqual(b.setAside.map((x) => x.run), [1, 8, 9]);
  assert.equal(b.setAside[0].why, "warm-up pair");
  assert.match(b.setAside[1].why, /ThreadPoolForeg 60 %/);
  assert.equal(b.pairs, 6);
  assert.equal(b.meanSpeed, 300);
  assert.equal(b.pairMeanPct, 0);
  assert.deepEqual(b.perPairPct, [1, -1, 0, 0, 0, 0]);
  assert.equal(b.runSigmaPct, 1.28); // σ of the 12 kept speeds over their mean
  assert.equal(b.pairSigmaPct, 0.63);
  assert.equal(b.pairsFor2Pct, 4); // ceil(8 · 1.28² / 2²)
  assert.deepEqual(b.pinnedThreads, ["DedicatedWorker", "ThreadPoolForeg"]);
  assert.match(benchMarkdown(b), /AMD EPYC 7763[\s\S]*Set aside: run 1 \(warm-up pair\)/);
  assert.equal(benchAA([{ run: 1, baseline: { error: "x" } }]).pairs, 0);
});

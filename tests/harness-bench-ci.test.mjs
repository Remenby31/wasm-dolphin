// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync } from "node:child_process";

import { armPmus } from "../harness/lib/perf-counters.mjs";
import { isHomebrew } from "../harness/probes/race-perf.mjs";
import { benchAA, benchMarkdown } from "../harness/remote/bench-aa.mjs";
import { benchReport, reportMarkdown } from "../harness/remote/bench-report.mjs";

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
  // Our homebrews only: no ISO, no savestate, nothing from roms/.
  assert.match(workflow, /footprint\) dol=harness\/homebrew\/out\/footprint\.dol ;;/);
  assert.match(workflow, /cpufuzz\) dol=harness\/homebrew\/fixtures\/cpufuzz\.dol ;;/);
  assert.match(workflow, /--iso "\$dol"/);
  assert.match(workflow, /node footprint\/gen\.mjs > out\/footprint_gen\.S/);
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

test("footprint: deterministic static PowerPC, calls only forward, jump tables, cold paths, paired singles", () => {
  const gen = (args = []) => execFileSync(process.execPath, [new URL("../harness/homebrew/footprint/gen.mjs", import.meta.url).pathname, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  const asm = gen(["--functions", "64"]);
  assert.equal(gen(["--functions", "64"]), asm);
  assert.notEqual(gen(["--functions", "64", "--seed", "0x1234"]), asm);
  const fns = [...asm.matchAll(/^fp_f(\d+):$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(fns, Array.from({ length: 64 }, (_, i) => i));
  // Calls go to later functions only (no recursion): direct and table entries.
  let current = -1, back = 0;
  for (const line of asm.split("\n")) {
    const f = /^fp_f(\d+):$/.exec(line);
    if (f) current = Number(f[1]);
    const call = /^\tbl fp_f(\d+)$/.exec(line);
    if (call && Number(call[1]) <= current) back += 1;
  }
  assert.equal(back, 0);
  assert.match(asm, /\tbctr$/m);          // jump tables
  assert.match(asm, /\tbctrl$/m);         // calls through tables
  assert.match(asm, /rlwinm\. 0,29,0,20,31\n\tbne /); // cold paths, 1 in 4096
  assert.match(asm, /\t\.long 0xe[0-3]/); // psq_l (opcode 56)
  assert.match(asm, /\tfmadd|\tfmsub|\tfnmadd/);
  assert.match(asm, /\.globl fp_run/);
  assert.match(asm, /fp_function_count:\n\t\.long 64/);
  // The default: ~1000 functions, several hundred KB of code.
  const full = gen();
  const words = full.split("\n").filter((l) => /^\t(?!\.(align|globl|section|text))[a-z.]/.test(l) && !l.includes("fp_f") || /^\t\.long 0x/.test(l)).length;
  assert.ok(words * 4 > 400 * 1024, `${words * 4} bytes`);
});

test("CI bench: a pair whose sides ran on two CPU models is set aside; the report pools pairs per model", () => {
  const pin = { thread: "DedicatedWorker", busyPct: 99, cpu: 0 };
  const run = (n, a, b, ma = "EPYC 7763", mb = ma) => ({ run: n, baseline: { cold: { speed: a, pinned: pin, cpuModel: ma } }, candidate: { cold: { speed: b, pinned: pin, cpuModel: mb } } });
  const one = benchAA([run(1, 300, 300), run(2, 300, 303), run(3, 300, 297), run(4, 300, 330, "EPYC 7763", "EPYC 9V74")], { runner: "ubuntu-24.04", job: 1 });
  assert.deepEqual(one.setAside.map((x) => x.why), ["warm-up pair", "CPU model changed: EPYC 7763 / EPYC 9V74"]);
  assert.deepEqual(one.perPair.map((p) => [p.run, p.model, p.ratioPct]), [[2, "EPYC 7763", 1], [3, "EPYC 7763", -1]]);
  const bench = (model, sigma, ratios, job) => ({ arch: "x86_64", runSigmaPct: sigma, machine: { runner: "ubuntu-24.04", job }, perPair: ratios.map((r, i) => ({ run: i + 2, model, ratioPct: r })) });
  const r = benchReport([bench("EPYC 7763", 1.5, [1, -1, 0.5], 1), bench("EPYC 7763", 2.5, [-0.5, 0], 2), bench("Xeon 6973P-C", 3.5, [5, -5], 3)]);
  const epyc = r.models.find((m) => m.model === "EPYC 7763"), xeon = r.models.find((m) => m.model === "Xeon 6973P-C");
  assert.equal(epyc.pairs, 5);
  assert.deepEqual(epyc.jobs, ["ubuntu-24.04#1", "ubuntu-24.04#2"]);
  assert.equal(epyc.medianRunSigmaPct, 2);
  assert.equal(epyc.inDecisionSet, true);
  assert.equal(xeon.inDecisionSet, false); // σ per run ≥ 3 %: recorded, not counted
  assert.match(reportMarkdown(r), /\| Xeon 6973P-C \|.*\| no \(σ per run ≥ 3 %\) \|/);
});

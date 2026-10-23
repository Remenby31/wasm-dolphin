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
  assert.match(workflow, /footprint-64\|footprint-128\|footprint-256\|footprint-512\) dol="harness\/homebrew\/out\/\$WORKLOAD\.dol" ;;/);
  assert.match(workflow, /cpufuzz\) dol=harness\/homebrew\/fixtures\/cpufuzz\.dol ;;/);
  assert.match(workflow, /--iso "\$dol"/);
  assert.match(workflow, /node footprint\/gen\.mjs > out\/footprint_gen\.S/);
  // An A/B serves each ref's committed core, refused unless it is the build of that ref's sources.
  assert.match(workflow, /node tools\/core-artifacts\.mjs status --checkout "\$d" --require-current \|\| \{ echo "\$ref: its committed core is not the build of its sources"; exit 1; \}/);
  assert.doesNotMatch(workflow, /cd "\$d" && node tools/); // never the ref's own tool
  assert.match(workflow, /sides=\(--baseline "\$BASELINE" --candidate "\$CANDIDATE"\)/);
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

test("CI bench: warm-up block, mispinned pairs and order imbalance set aside; σ per arm; median ln(B/A) with a CI and a verdict", () => {
  const pin = (thread = "DedicatedWorker", busyPct = 99) => ({ thread, busyPct, cpu: 0 });
  const run = (n, a, b, p = pin()) => ({ run: n, baseline: { cold: { speed: a, pinned: pin() } }, candidate: { cold: { speed: b, pinned: p } } });
  // An A/A: runs 1-2 warm-up, run 9 mispinned, so run 10 (BA) or 8 goes for the balance.
  const aa = benchAA([run(1, 300, 250), run(2, 280, 300), run(3, 300, 303), run(4, 300, 297), run(5, 306, 306), run(6, 294, 294), run(7, 300, 300), run(8, 300, 300),
    run(9, 300, 200, pin("ThreadPoolForeg", 60)), run(10, 300, 301)], { cpuModel: "AMD EPYC 7763 64-Core Processor", runner: "ubuntu-24.04", arch: "x86_64", pmu: "none" });
  assert.deepEqual(aa.setAside.map((x) => [x.run, x.why.split(" ")[0]]), [[1, "warm-up"], [2, "warm-up"], [9, "pinned"], [10, "order"]]);
  assert.equal(aa.pairs, 6);
  assert.deepEqual(aa.perPair.map((p) => p.order), ["AB", "BA", "AB", "BA", "AB", "BA"]);
  assert.equal(aa.change.verdict, "no change detected");
  assert.ok(aa.change.ci95Pct[0] <= 0 && aa.change.ci95Pct[1] >= 0);
  assert.match(benchMarkdown(aa), /AMD EPYC 7763[\s\S]*Set aside: run 1 \(warm-up block/);
  // A real +6 % with 0.5 % noise: the effect is not noise (σ per arm), and the verdict says so.
  const noise = [0.5, -0.4, 0.2, -0.3, 0.1, -0.2, 0.4, -0.5, 0.3, -0.1];
  const ab = benchAA(noise.map((e, i) => run(i + 1, 100 * (1 + e / 100), 106 * (1 - e / 100))));
  assert.ok(ab.runSigmaPct < 1, `σ per run ${ab.runSigmaPct}`);
  assert.equal(ab.change.verdict, "candidate faster");
  assert.ok(Math.abs(ab.change.medianPct - 100 * Math.log(1.06)) < 1.5);
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

test("CI bench: a pair whose sides ran on two CPU models is set aside; the report pools ln(B/A) per workload and model", () => {
  const pin = { thread: "DedicatedWorker", busyPct: 99, cpu: 0 };
  const run = (n, a, b, ma = "EPYC 7763", mb = ma) => ({ run: n, baseline: { cold: { speed: a, pinned: pin, cpuModel: ma } }, candidate: { cold: { speed: b, pinned: pin, cpuModel: mb } } });
  const one = benchAA([run(1, 300, 300), run(2, 300, 300), run(3, 300, 303), run(4, 300, 297), run(5, 300, 330, "EPYC 7763", "EPYC 9V74"), run(6, 300, 300)], { runner: "ubuntu-24.04", job: 1 });
  assert.ok(one.setAside.some((x) => x.why === "CPU model changed: EPYC 7763 / EPYC 9V74"));
  assert.ok(one.perPair.every((p) => p.model === "EPYC 7763"));
  const bench = (model, sigma, lrs, job, workload = "footprint-256") => ({ arch: "x86_64", runSigmaPct: sigma, machine: { runner: "ubuntu-24.04", job, workload }, perPair: lrs.map((r, i) => ({ run: i + 3, model, lrPct: r })) });
  const r = benchReport([bench("EPYC 7763", 1.5, [1, -1, 0.5], 1), bench("EPYC 7763", 2.5, [-0.5, 0], 2), bench("Xeon 6973P-C", 3.5, [5, -5], 3), bench("EPYC 7763", 9, [20, -20], 4, "footprint-64")]);
  const epyc = r.models.find((m) => m.model === "EPYC 7763" && m.workload === "footprint-256"), xeon = r.models.find((m) => m.model === "Xeon 6973P-C");
  assert.equal(r.models.find((m) => m.workload === "footprint-64").change.pairs, 2); // another workload, its own row
  assert.equal(epyc.change.pairs, 5);
  assert.equal(epyc.change.verdict, "no change detected");
  assert.deepEqual(epyc.jobs, ["ubuntu-24.04#1", "ubuntu-24.04#2"]);
  assert.equal(epyc.medianRunSigmaPct, 2);
  assert.equal(epyc.inDecisionSet, true);
  assert.equal(xeon.inDecisionSet, false); // σ per run ≥ 3 %: recorded, not counted
  assert.match(reportMarkdown(r), /\| footprint-256 \| Xeon 6973P-C \|.*\| no \(σ per run ≥ 3 %\) \|/);
});

test("race-perf --run-timeout: a measure that never ends fails its run instead of holding the lock", async () => {
  const { withRunTimeout } = await import("../harness/probes/race-perf.mjs");
  const never = new Promise(() => {});
  await assert.rejects(withRunTimeout(never, 30, "cold window"), (e) => e.runTimeout === true && /cold window timed out after 0\.03 s/.test(e.message));
  assert.equal(await withRunTimeout(Promise.resolve(7), 1000, "w"), 7);
  assert.equal(withRunTimeout(never, 0, "w"), never); // 0: no limit
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 60));
  await assert.rejects(withRunTimeout(late, 20, "w"), /timed out/); // the late rejection is swallowed
  await new Promise((r) => setTimeout(r, 80));
});

test("CI bench: with region stats, a pair where a side installed no region is set aside; regions per arm reported", () => {
  const pin = { thread: "DedicatedWorker", busyPct: 99, cpu: 0 };
  const side = (speed, installed, share) => ({ speed, pinned: pin, p4: { regionCycleShare: share }, p4Raw: { diagnostics: { regionsInstalled: installed } } });
  const run = (n, a, b, ib = 140) => ({ run: n, baseline: { cold: side(a, 140, 0.8) }, candidate: { cold: side(b, ib, 0.82) } });
  const b = benchAA([run(1, 20, 20), run(2, 20, 20), run(3, 20, 21), run(4, 20, 21), run(5, 20, 25, 0), run(6, 20, 21), run(7, 20, 21), run(8, 20, 21)]);
  assert.ok(b.setAside.some((x) => x.run === 5 && /no region installed \(140 \/ 0\)/.test(x.why)));
  assert.deepEqual(b.regions, { baseline: { installed: 140, cycleShare: 0.8 }, candidate: { installed: 140, cycleShare: 0.82 } });
  assert.match(benchMarkdown(b), /Regions \(median per arm\): A 140 installed, 0\.8 of guest cycles; B 140 installed, 0\.82/);
  // Without region stats (no aot): no region line, nothing set aside for it.
  const plain = benchAA([run(1, 20, 20), run(2, 20, 20), run(3, 20, 20), run(4, 20, 20)].map((r) => { for (const s of ["baseline", "candidate"]) { delete r[s].cold.p4; delete r[s].cold.p4Raw; } return r; }));
  assert.equal(plain.regions, null);
});

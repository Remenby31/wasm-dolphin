// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The PC kit (research/pc-windows-kit.md) without a PC: the generated bench
// kernels against their JS reference, the bench's reading, the Windows
// display mode, the remote PowerShell encoding, the preflight checklist, the
// calibration search on a model CPU, the job flow against a simulated PC,
// and salon-pc.ps1 itself under pwsh with powercfg mocked (skipped without
// pwsh). Nothing here is timed. --engine HEAD: CI's checkout has neither
// origin/main nor ../salon/engine.lock.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserChannel, chromeLaunchOptions } from "../harness/lib/browser.mjs";
import { chromeInfo } from "../harness/lib/probe-out.mjs";
import { parseWin32Battery } from "../harness/lib/system.mjs";
import { buildKernel, reference, SHAPES } from "../harness/lib/wasm-kernel.mjs";
import { benchScore, classifyJit, summarizeCalls, summarizeRuns } from "../harness/probes/pc-bench.mjs";
import {
  assertSendable, benchHold, calibrationTarget, stepWindows, versionOutliers, encodePs, gb6Of, j1bTable, KIT_SCHEME, kitCommand, knobIneffective, nextProbe, parseKitJson, preflight, restoreDiff, samplerVerdict
} from "../harness/lib/pc-kit.mjs";
import { calibrate } from "../harness/remote/pc-win/pc-calibrate.mjs";
import { benchFindings, benchSteps, clampOf, jobReport, jobSpec, parcoursSteps, runJob, simulatedPc } from "../harness/remote/pc-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = () => {};

test("pc-kit: the generated kernels compute what their JS reference computes", () => {
  assert.deepEqual(Object.keys(SHAPES), ["core", "front", "alu"]);
  for (const [name, shape] of Object.entries(SHAPES)) {
    const run = new WebAssembly.Instance(new WebAssembly.Module(buildKernel(shape)), {}).exports.run;
    for (const n of [0, 1, 777]) assert.equal(run(n) >>> 0, reference(shape, n), `${name} run(${n})`);
  }
  assert.ok(buildKernel(SHAPES.front).length > 512 * 1024, "front: code larger than any L1i and most L2");
  assert.deepEqual(buildKernel(SHAPES.core), buildKernel(SHAPES.core), "deterministic");
});

test("pc-bench: cold/hot, ratio, spread, score and the JIT verdicts", () => {
  const ns = [10, 9, 8, ...Array(7).fill(5), ...Array(10).fill(4)];
  const s = summarizeCalls(ns);
  assert.equal(s.coldNs, 9);
  assert.equal(s.hotNs, 4);
  assert.equal(s.ratio, 0.444);
  assert.equal(s.mdps, 250);
  assert.equal(summarizeCalls([1, 2]).hotNs, null, "too few calls: no figure");
  assert.equal(benchScore({ core: { mdps: 100 }, front: { mdps: 25 }, alu: { mdps: 1 } }), 50, "alu is not in the score");
  assert.equal(benchScore({ core: { mdps: 100 }, front: { mdps: null } }), null);
  assert.equal(summarizeCalls([...Array(13).fill(4)], [9, 8, 10]).coldNs, 9, "cold from the fresh modules' first calls");
  const k = (hotNs) => ({ kernels: { alu: { hotNs } } });
  // the CI windows-2025 readings: 5.33 ns as is, 62 ns without the optimizer
  const refs = { reference: k(5.33), liftoff: k(62) };
  assert.equal(classifyJit(k(5.33), refs).verdict, "jit");
  assert.equal(classifyJit(k(62), refs).verdict, "liftoff-only", "Liftoff alone is ~12x: not an interpreter");
  assert.equal(classifyJit(k(400), refs).verdict, "interpreter");
  assert.equal(classifyJit(k(6), { reference: k(5.33), liftoff: k(6.5) }).verdict, "unknown", "references too close to tell");
  assert.equal(classifyJit(k(6), {}).verdict, "unknown");
  const f = benchFindings({ "bench-pre-chrome": k(5.33), "bench-pre-chrome-liftoff": k(62), "bench-pre-msedge": k(300) }, null);
  assert.deepEqual(f.map((x) => [x.name, x.jit.verdict]), [["bench-pre-chrome", "jit"], ["bench-pre-msedge", "interpreter"]]);
  assert.equal(benchFindings({ "bench-chrome": k(5.33), "bench-chrome-liftoff": k(6) }, null)[0].jit.verdict, "liftoff-only?");
  assert.deepEqual(benchSteps("bench-pre", ["chrome", "msedge"], "C:\\j").map((x) => [x.name, x.env.HARNESS_CHROME_ARGS ?? ""]),
    [["bench-pre-chrome", ""], ["bench-pre-msedge", ""], ["bench-pre-chrome-liftoff", "--js-flags=--disable-optimizing-compilers"]]);
  assert.deepEqual(summarizeRuns([{ score: 10 }, { score: 12 }, { score: 11 }]), { runs: 3, score: 11, scores: [10, 12, 11], spreadPct: 18.2, kernels: {} });
});

test("pc-kit: the windows display is Windows only, shown full screen; Edge by channel", () => {
  const w = chromeLaunchOptions("windows", { platform: "win32", env: {} });
  assert.equal(w.headless, false);
  assert.equal(w.viewport, null);
  assert.ok(w.args.includes("--start-fullscreen"));
  for (const p of ["darwin", "linux"]) assert.throws(() => chromeLaunchOptions("windows", { platform: p, env: {} }), /Windows only/);
  assert.equal(browserChannel({}), "chrome");
  assert.equal(browserChannel({ HARNESS_BROWSER_CHANNEL: "msedge" }), "msedge");
  assert.throws(() => browserChannel({ HARNESS_BROWSER_CHANNEL: "firefox" }), /one of chrome, msedge/);
  assert.deepEqual(chromeInfo({}), { path: "chrome stable", args: "" }, "unchanged for every existing probe");
  assert.deepEqual(chromeInfo({ HARNESS_BROWSER_CHANNEL: "msedge", HARNESS_DISPLAY: "windows" }), { path: "chrome stable", args: "", channel: "msedge", display: "windows" });
});

test("pc-kit: Windows power source from Win32_Battery", () => {
  assert.deepEqual(parseWin32Battery(""), { source: "ac", percent: null, battery: false });
  assert.deepEqual(parseWin32Battery("[]"), { source: "ac", percent: null, battery: false });
  assert.deepEqual(parseWin32Battery('{"BatteryStatus":1,"EstimatedChargeRemaining":64}'), { source: "battery", percent: 64, battery: true });
  assert.deepEqual(parseWin32Battery('[{"BatteryStatus":2,"EstimatedChargeRemaining":100}]'), { source: "ac", percent: 100, battery: true });
  assert.equal(parseWin32Battery("not json"), null);
});

test("pc-kit: remote commands are encoded PowerShell, results read back", () => {
  const c = kitCommand("clamp", { Job: "j1", MaxMhz: 4300.7, Path: "C:\\it's here" });
  const b64 = /-EncodedCommand (\S+)$/.exec(c)[1];
  assert.match(b64, /^[A-Za-z0-9+/=]+$/, "nothing for cmd.exe or ssh to reinterpret");
  assert.equal(Buffer.from(b64, "base64").toString("utf16le"), "& 'C:\\salon-kit\\salon-pc.ps1' -Action 'clamp' -Job 'j1' -MaxMhz 4300 -Path 'C:\\it''s here'");
  assert.equal(Buffer.from(encodePs("é"), "base64").toString("utf16le"), "é");
  assert.throws(() => kitCommand("check", { "Bad;Name": 1 }), /bad parameter/);
  assert.deepEqual(parseKitJson('noise\r\nSALONKIT-JSON {"a":1}\r\nSALONKIT-JSON {"a":2}\r\n'), { a: 2 });
  assert.equal(parseKitJson("nothing"), null);
});

test("pc-kit: no disc image is ever sent, homebrews are", () => {
  for (const f of ["/x/game.iso", "/x/g.RVZ", "/x/g.gcm", "/x/boot.dol"]) assert.throws(() => assertSendable(f), /never copies one/);
  assert.doesNotThrow(() => assertSendable("/r/harness/homebrew/out/gxscene.iso", { homebrewDirs: ["/r/harness/homebrew/out"] }));
  assert.throws(() => assertSendable("/r/harness/homebrew/outside/x.iso", { homebrewDirs: ["/r/harness/homebrew/out"] }));
  assert.doesNotThrow(() => assertSendable("/x/route1-1p-v2.json"));
});

test("pc-kit: host CPU lookup and the calibration target", () => {
  assert.equal(gb6Of("13th Gen Intel(R) Core(TM) i9-13900K").gb6, 2983);
  assert.equal(gb6Of("AMD Ryzen 9 7950X3D 16-Core Processor").name, "AMD Ryzen 9 7950X3D");
  assert.equal(gb6Of("AMD Ryzen 9 7950X 16-Core Processor").name, "AMD Ryzen 9 7950X");
  assert.equal(gb6Of("12th Gen Intel(R) Core(TM) i5-12400F").name, "Intel Core i5-12400F");
  assert.equal(gb6Of("Some Future CPU"), null);
  const t = calibrationTarget({ unclampedScore: 100, hostGb6: 2983, referenceGb6: 2204 });
  assert.equal(t.ratio, 0.739);
  assert.equal(t.target, 73.885);
  assert.equal(t.needed, true);
  assert.equal(calibrationTarget({ unclampedScore: 100, hostGb6: 2198, referenceGb6: 2204 }).needed, false, "a Zen 3 host needs no clamp");
});

// A model CPU: score proportional to the effective clock, the firmware
// capping at turbo; `honours` false = the MHz cap is ignored.
function modelCpu({ turbo = 5800, perMhz = 0.02, honoursMhz = true, honoursState = true, base = 3000 } = {}) {
  let clock = turbo;
  return {
    clamp: ({ maxMhz = 0, statePct = 0, boostMode = -1 }) => {
      clock = turbo;
      if (maxMhz && honoursMhz) clock = Math.min(turbo, maxMhz);
      if (statePct && honoursState) clock = (boostMode === 0 ? base : turbo) * statePct / 100; // % of the maximum
    },
    bench: async () => Math.round(clock * perMhz * 1000) / 1000
  };
}

test("pc-kit: the calibration search reaches the target on a model CPU", async () => {
  const cpu = modelCpu();
  const r = await calibrate({ ...cpu, hostGb6: 2983, referenceGb6: 2204, turboMhz: 5800 });
  assert.ok(r.chosen.maxMhz > 4000 && r.chosen.maxMhz < 4500, `chose ${r.chosen.maxMhz}`);
  assert.ok(r.errPct <= 2, `within 2 % (${r.errPct})`);
  // a wrong first guess (turbo unknown) converges too
  const r2 = await calibrate({ ...modelCpu(), hostGb6: 2983, referenceGb6: 2204 });
  assert.ok(r2.errPct <= 2);
  assert.ok(r2.knobs[0].points.length <= 8);
});

test("pc-kit: an ignored MHz cap falls back to the processor state; neither: no clamp claimed", async () => {
  const r = await calibrate({ ...modelCpu({ honoursMhz: false }), hostGb6: 2983, referenceGb6: 2204, turboMhz: 5800 });
  assert.equal(r.knobs[0].ineffective, true);
  assert.equal(r.chosen.boostMode, undefined, "boost left as it is");
  assert.ok(r.chosen.statePct >= 70 && r.chosen.statePct <= 78, `chose ${r.chosen.statePct} %`);
  assert.ok(r.errPct <= 2.5, `state knob within tolerance (${r.errPct})`);
  const none = await calibrate({ ...modelCpu({ honoursMhz: false, honoursState: false }), hostGb6: 2983, referenceGb6: 2204, turboMhz: 5800 });
  assert.equal(none.chosen, null);
  assert.match(none.why, /neither knob/);
  const zen3 = await calibrate({ ...modelCpu({ turbo: 4900 }), hostGb6: 2205, referenceGb6: 2204 });
  assert.deepEqual(zen3.chosen, { maxMhz: 0 });
});

test("pc-kit: nextProbe and knobIneffective, pure", () => {
  const n = nextProbe([{ x: 4000, score: 80 }, { x: 4600, score: 92 }], 85, { lo: 800, hi: 7000 });
  assert.equal(n.done, false);
  assert.ok(n.next > 4000 && n.next < 4600 && n.next % 50 === 0);
  assert.equal(nextProbe([{ x: 4000, score: 84.5 }], 85, { lo: 800, hi: 7000 }).done, true);
  assert.equal(nextProbe([{ x: 800, score: 100 }], 50, { lo: 800, hi: 7000 }).why, "at the knob's bound");
  assert.equal(knobIneffective([{ x: 5800, score: 100 }, { x: 4300, score: 99 }]), true);
  assert.equal(knobIneffective([{ x: 5800, score: 100 }, { x: 4300, score: 75 }]), false);
});

const goodCheck = () => structuredClone(simulatedPc({ log: quiet }).ssh(kitCommand("check")).out.replace("SALONKIT-JSON ", "")).trim();

test("pc-kit: the preflight blocks on each Windows trap it can see", () => {
  const base = JSON.parse(goodCheck());
  assert.equal(preflight(base).blocked.length, 0, "the simulated PC is clean");
  const blocked = (mut, opts) => { const c = structuredClone(base); mut(c); return preflight(c, opts).blocked.map((b) => b.id); };
  assert.deepEqual(blocked((c) => { c.power.battery = [{ BatteryStatus: 1, EstimatedChargeRemaining: 60 }]; }), ["mains"]);
  assert.deepEqual(blocked((c) => { c.session.lockScreenUp = true; }), ["unlocked-session"]);
  assert.deepEqual(blocked((c) => { c.session.sessions = ["baptiste|console|1|Déco|none|x"]; }), ["unlocked-session"]);
  assert.ok(blocked((c) => { c.session.sessions = ["baptiste|console|1|Actif|none|x"]; }).length === 0, "a French Windows says Actif");
  assert.deepEqual(blocked((c) => { c.browsers.edge = null; }), ["browser-msedge"]);
  assert.deepEqual(blocked((c) => { c.browsers.edge = null; }, { browsers: ["chrome"] }), [], "Edge not asked");
  assert.deepEqual(blocked((c) => { c.power.kitSchemeActive = true; }), ["kit-scheme-not-left"]);
  assert.deepEqual(blocked((c) => { c.policies.chromeMachine = { DefaultJavaScriptOptimizerSetting: 2 }; }), ["chrome-jit-policy"]);
  assert.deepEqual(blocked((c) => { c.classAffinity = { error: "only 4 cores of the fastest class (asked 6)" }; }), ["class-affinity"]);
  const warns = (mut) => { const c = structuredClone(base); mut(c); return preflight(c).warnings.map((b) => b.id); };
  assert.deepEqual(warns((c) => { c.gpus[0].refreshHz = 144; }), ["refresh-60"]);
  assert.deepEqual(warns((c) => { c.policies.edgeUser = { EnhanceSecurityMode: 2 }; }), ["edge-esm-policy"]);
  assert.deepEqual(warns((c) => { c.classAffinity.threads = 6; }), ["smt"]);
  const bench = (st, verdict = "jit", b = "chrome") => preflight(base, { bench: { [b]: { jit: { verdict }, perRun: [{ state: st }] } } }).blocked.map((x) => x.id);
  const ok = { visibility: "visible", focus: true, rafMs: { p50: 16.7 } };
  assert.deepEqual(bench(ok), []);
  assert.deepEqual(bench({ ...ok, visibility: "hidden", focus: false }), ["page-visible-chrome"]);
  assert.deepEqual(bench({ ...ok, rafMs: { p50: 33.3 } }), ["raf-chrome"], "energy saver at 30 Hz");
  assert.deepEqual(bench(ok, "liftoff-only"), ["jit-chrome"], "optimizer off");
  assert.deepEqual(bench(ok, "interpreter", "msedge"), [], "Edge's interpreter is a result, not a block");
  assert.deepEqual(preflight({ ...base, iso: { exists: false } }, { needIso: "C:\\d\\g.iso" }).blocked.map((b) => b.id), ["iso-on-pc"]);
});

test("pc-kit: sampler contamination and the J1b table", () => {
  const rows = Array.from({ length: 20 }, () => ({ otherPct: 5, scheme: KIT_SCHEME, browserAffinity: "0xfff", locked: false }));
  assert.equal(samplerVerdict(rows, { affinity: "0xfff", scheme: KIT_SCHEME }).contaminated, false);
  assert.match(samplerVerdict([...rows, ...Array(3).fill({ otherPct: 300 })], {}).reasons.join(), /p95/);
  assert.match(samplerVerdict([...rows.slice(1), { ...rows[0], locked: true }], {}).reasons.join(), /lock screen/);
  assert.match(samplerVerdict([...rows.slice(1), { ...rows[0], browserAffinity: "0xffffffff" }], { affinity: "0xfff" }).reasons.join(), /outside the class affinity/);
  assert.match(samplerVerdict([], {}).reasons.join(), /no sampler row/);
  const run = (n, speedP5, smoothP5, ok = true) => ({ side: "candidate", run: n, completion: { completed: ok }, phases: Object.fromEntries(["cinematic", "menu", "game"].map((p) => [p, { metrics: { speedP5, smoothP5, smoothReliable: true } }])) });
  const t = j1bTable([{ label: "1p / chrome", summary: { runs: [run(1, 99, 96), run(2, 98.5, 95.5), run(3, 97, 94), run(4, 50, 10, false)] } }]);
  assert.equal(t.length, 3);
  assert.deepEqual(t.map((r) => [r.validRuns, r.speedP5, r.smoothP5, r.verdict]), Array(3).fill([3, 98.5, 95.5, "pass"]), "the incomplete run is left out");
  const few = j1bTable([{ label: "2p / msedge", summary: { runs: [run(1, 99, 99), run(2, 99, 99)] } }]);
  assert.equal(few[0].verdict, "too few valid runs");
  const fail = j1bTable([{ label: "2p / msedge", summary: { runs: [run(1, 90, 99), run(2, 91, 99), run(3, 92, 99)] } }]);
  assert.equal(fail[0].verdict, "fail");
});

test("pc-kit: restore diff", () => {
  const before = { activeScheme: "a", schemes: ["a", "b"], processor: { X: { ac: 0 } }, tasks: [] };
  assert.deepEqual(restoreDiff(before, structuredClone(before), "j"), []);
  const d = restoreDiff(before, { activeScheme: KIT_SCHEME, schemes: ["a", "b", KIT_SCHEME], processor: { X: { ac: 1 } }, tasks: ["j"] }, "j");
  assert.equal(d.length, 5);
});

test("pc-run: steps interleave runs, browsers and scenes; clamps are explicit", () => {
  const s = parcoursSteps({ jobDir: "C:\\k\\jobs\\j", iso: "C:\\d\\g.iso", films: { "1p": "C:\\k\\films\\a.json", "2p": "C:\\k\\films\\b.json" }, browsers: ["chrome", "msedge"], runs: 2, query: "q=1", engineDir: "C:\\k\\trees\\e" });
  assert.deepEqual(s.map((x) => x.name), ["parcours-1p-chrome-1", "parcours-2p-chrome-1", "parcours-1p-msedge-1", "parcours-2p-msedge-1", "parcours-1p-chrome-2", "parcours-2p-chrome-2", "parcours-1p-msedge-2", "parcours-2p-msedge-2"]);
  assert.ok(s.every((x) => x.args.includes("--no-lock") && x.args.includes("--runs") && x.args[x.args.indexOf("--runs") + 1] === "1"));
  assert.equal(s[2].env.HARNESS_BROWSER_CHANNEL, "msedge");
  const spec = jobSpec({ harnessDir: "C:\\k\\trees\\h", steps: s, affinity: "0xfff" });
  assert.equal(spec.env.HARNESS_DISPLAY, "windows");
  assert.equal(spec.restoreAtEnd, true);
  assert.ok(spec.steps.every((x) => typeof x.continueOnError === "boolean" && x.env), "every field present (salon-pc.ps1 runs under StrictMode)");
  assert.throws(() => clampOf({}), /say which clamp/);
  assert.equal(clampOf({ "no-clamp": true }), null);
  assert.deepEqual(clampOf({ "clamp-mhz": "4300" }), { maxMhz: 4300 });
});

test("pc-run: a job against a simulated PC restores the machine, even when it fails", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-test-"));
  try {
    const pc = simulatedPc({ log: quiet });
    const before = structuredClone(pc.state);
    const rec = await runJob(pc, { job: "t1", steps: [{ name: "x", args: ["a.mjs"] }], affinity: "0xfff", clamp: { maxMhz: 4300 }, outDir: dir, harnessDir: "C:\\k", poll: 0, log: quiet });
    assert.deepEqual(rec.restore.diff, []);
    assert.equal(pc.state.active, before.active);
    assert.deepEqual(pc.state.schemes, before.schemes);
    assert.deepEqual(pc.state.tasks, []);
    const spec = JSON.parse(readFileSync(path.join(dir, "t1", "spec.json"), "utf8"));
    assert.equal(spec.affinity, "0xfff");
    // the task cannot start: the clamp is undone all the same
    const broken = simulatedPc({ log: quiet });
    const ssh = broken.ssh.bind(broken);
    broken.ssh = (c) => (/-Action 'start'/.test(Buffer.from(/-EncodedCommand (\S+)/.exec(c)?.[1] ?? "", "base64").toString("utf16le")) ? (() => { throw new Error("start refused"); })() : ssh(c));
    await assert.rejects(runJob(broken, { job: "t2", steps: [], affinity: null, clamp: { maxMhz: 4000 }, outDir: dir, harnessDir: "C:\\k", poll: 0, log: quiet }), /start refused/);
    assert.equal(broken.state.active, before.active);
    assert.ok(!broken.state.schemes.includes(KIT_SCHEME));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pc-run: the whole flow in --dry-run (no connection)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-dry-"));
  try {
    const film = path.join(dir, "f.json");
    writeFileSync(film, "{}");
    const r = spawnSync(process.execPath, ["harness/remote/pc-run.mjs", "run", "--host", "pc", "--dry-run", "--out", path.join(dir, "out"), "--iso", "C:\\d\\g.iso", "--film", `1p=${film}`, "--clamp-mhz", "4300", "--runs", "1", "--job", "dry", "--engine", "HEAD"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CLAUDE_JOB_DIR: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /-Action 'clamp' -Job 'dry' -MaxMhz 4300/);
    assert.match(r.stderr, /-Action 'restore' -Job 'dry'/);
    assert.match(r.stderr, /machine restored/);
    assert.doesNotMatch(r.stderr, /scp \S+\.iso/i, "no disc sent");
    const bad = spawnSync(process.execPath, ["harness/remote/pc-run.mjs", "run", "--host", "pc", "--dry-run", "--out", path.join(dir, "out"), "--iso", "/Users/x/g.iso", "--film", film, "--no-clamp"], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /a Windows path on the PC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// salon-pc.ps1 under pwsh, powercfg and the task cmdlets mocked: the
// snapshot / clamp / restore round trip and the scheme it creates.
const PWSH = process.env.PWSH || "pwsh";
const hasPwsh = spawnSync(PWSH, ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).status === 0;
test("pc-kit: salon-pc.ps1 snapshot, clamp, restore with powercfg mocked", { skip: hasPwsh ? false : "no pwsh" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-ps-"));
  try {
    const harness = `
$ErrorActionPreference = 'Stop'
$global:pc = @{ active = '381b4222-f694-41f0-9685-ff5bb260df2e'; schemes = [System.Collections.ArrayList]@('381b4222-f694-41f0-9685-ff5bb260df2e', '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'); v = @{}; log = [System.Collections.ArrayList]@() }
$global:defaults = @{ 'bc5038f7-23e0-4960-96da-33abaf5935ec' = 100; 'be337238-0d82-4146-a960-4f3749d470c7' = 2; '75b0ae3f-bce0-45a7-8c89-c9611c25e100' = 0 }
function global:powercfg {
  $a = @($args); [void]$global:pc.log.Add(($a -join ' ')); $global:LASTEXITCODE = 0
  switch ($a[0]) {
    '/getactivescheme' { "Power Scheme GUID: $($global:pc.active)  (Mock)" }
    '/list' { 'Existing Power Schemes'; foreach ($s in $global:pc.schemes) { "Power Scheme GUID: $s  (Mock)" } }
    '/duplicatescheme' { [void]$global:pc.schemes.Add($a[2]); foreach ($k in @($global:pc.v.Keys)) { if ($k.StartsWith($a[1])) { $global:pc.v[$k.Replace($a[1], $a[2])] = $global:pc.v[$k].Clone() } } }
    '/changename' { }
    '/setactive' { $global:pc.active = $a[1] }
    '/delete' { $global:pc.schemes.Remove($a[1]) }
    { $_ -in '/qh', '/query' } {
      if ($a[3] -notmatch '^(bc5038f7|be337238|75b0ae3f)' -or $a[3] -match 'e101$|5ed$') { $global:LASTEXITCODE = 1; return }
      $k = "$($a[1])|$($a[3])"; $d = $global:defaults[$a[3]]; $cur = $global:pc.v[$k]; if (-not $cur) { $cur = @{ ac = $d; dc = $d } }
      "    Power Setting GUID: $($a[3])"; '      Minimum Possible Setting: 0x00000000'; '      Maximum Possible Setting: 0x00000064'
      ('    Current AC Power Setting Index: 0x{0:x8}' -f $cur.ac); ('    Current DC Power Setting Index: 0x{0:x8}' -f $cur.dc)
    }
    { $_ -in '/setacvalueindex', '/setdcvalueindex' } {
      if ($a[3] -match 'e101$|5ed$') { $global:LASTEXITCODE = 1; return }
      $k = "$($a[1])|$($a[3])"; if (-not $global:pc.v[$k]) { $d = $global:defaults[$a[3]]; $global:pc.v[$k] = @{ ac = $d; dc = $d } }
      if ($a[0] -eq '/setacvalueindex') { $global:pc.v[$k].ac = [int]$a[4] } else { $global:pc.v[$k].dc = [int]$a[4] }
    }
  }
}
function global:Get-ScheduledTask { @() }
function global:Unregister-ScheduledTask { }
$s = '${path.join(ROOT, "harness", "remote", "pc-win", "salon-pc.ps1")}'
$k = '${dir}'
& $s -Action snapshot -Job t1 -KitDir $k
& $s -Action clamp -Job t1 -MaxMhz 4300 -KitDir $k
& $s -Action snapshot -Job t1 -KitDir $k
& $s -Action restore -Job t1 -KitDir $k
try { & $s -Action clamp -Job 't1;rm' -MaxMhz 4300 -KitDir $k } catch { "SALONKIT-JSON " + (@{ refused = "$_" } | ConvertTo-Json -Compress) }
try { & $s -Action clamp -Job t9 -MaxMhz 4300 -KitDir $k } catch { "SALONKIT-JSON " + (@{ refused = "$_" } | ConvertTo-Json -Compress) }
foreach ($j in @("t3", "t4")) { New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $k "jobs") $j) | Out-Null }
Set-Content -LiteralPath (Join-Path (Join-Path (Join-Path $k "jobs") "t3") "exit") -Value ""
Set-Content -LiteralPath (Join-Path (Join-Path (Join-Path $k "jobs") "t4") "exit") -Value "0"
& $s -Action status -Job t3 -KitDir $k
& $s -Action status -Job t4 -KitDir $k
"SALONKIT-JSON " + (@{ final = $global:pc.active; schemes = @($global:pc.schemes) } | ConvertTo-Json -Compress)
`;
    const f = path.join(dir, "h.ps1");
    writeFileSync(f, harness);
    const r = spawnSync(PWSH, ["-NoProfile", "-File", f], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("SALONKIT-JSON ")).map((l) => JSON.parse(l.slice(14)));
    const [snap, clamp, snap2, restore, badJob, noSnap, st3, st4, final] = out;
    assert.deepEqual([st3.state, st3.exit], ["done", -1], "an empty exit file is done, exit unknown (-1), not a crash");
    assert.deepEqual([st4.state, st4.exit], ["done", 0]);
    assert.equal(snap.state.activeScheme, "381b4222-f694-41f0-9685-ff5bb260df2e");
    assert.equal(snap.state.processor.PROCFREQMAX.ac, 0);
    assert.equal(snap.state.processor.PROCFREQMAX1, null, "a setting this CPU lacks is null, not an error");
    assert.equal(clamp.scheme, KIT_SCHEME);
    assert.equal(clamp.processor.PROCFREQMAX.ac, 4300);
    assert.equal(clamp.processor.PROCFREQMAX.dc, 4300);
    assert.equal(clamp.applied.PROCFREQMAX1, false);
    assert.equal(snap2.existing, true, "a second snapshot never replaces the first");
    assert.equal(snap2.state.activeScheme, "381b4222-f694-41f0-9685-ff5bb260df2e");
    assert.deepEqual(restoreDiff(restore.before, restore.after, "t1"), []);
    assert.match(badJob.refused, /-Job/);
    assert.match(noSnap.refused, /no snapshot/);
    assert.equal(final.final, "381b4222-f694-41f0-9685-ff5bb260df2e");
    assert.deepEqual(final.schemes, ["381b4222-f694-41f0-9685-ff5bb260df2e", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pc-run: the job report applies the protocol's exclusions run by run", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-report-"));
  try {
    const at = (s) => new Date(Date.UTC(2026, 10, 20, 20, 0, s)).toISOString().replace("Z", "0000+00:00");
    const steps = ["bench-pre-chrome", "bench-pre-chrome-liftoff", "parcours-1p-chrome-1", "parcours-1p-chrome-2", "parcours-1p-chrome-3", "parcours-1p-chrome-4", "parcours-1p-chrome-5", "bench-post-chrome"];
    const log = ["\uFEFF[" + at(0) + "] job j, affinity 0xfff, session 1"];
    steps.forEach((n, i) => { log.push(`[${at(i * 100 + 1)}] step ${n}: node x`, `[${at(i * 100 + 90)}] step ${n}: exit 0`); });
    writeFileSync(path.join(dir, "log"), log.join("\r\n"));
    // run 2 (step 4: 300-390 s) is contaminated (a busy process during its window)
    const rows = Array.from({ length: 170 }, (_, k) => ({ t: at(k * 5), otherPct: k * 5 > 305 && k * 5 < 385 ? 400 : 4, scheme: KIT_SCHEME, browserAffinity: "0xfff", locked: false }));
    writeFileSync(path.join(dir, "sampler.jsonl"), rows.map((r) => JSON.stringify(r)).join("\r\n"));
    writeFileSync(path.join(dir, "kit-record.json"), JSON.stringify({ clamp: { maxMhz: 4300, target: 50 }, affinity: "0xfff", exit: 0, restore: { diff: [] } }));
    const st = { visibility: "visible", focus: true, rafMs: { p50: 16.7 } };
    writeFileSync(path.join(dir, "bench-pre-chrome.json"), JSON.stringify({ score: 50.5, kernels: { alu: { hotNs: 2 } }, perRun: [{ state: st }] }));
    writeFileSync(path.join(dir, "bench-pre-chrome-liftoff.json"), JSON.stringify({ score: 30, kernels: { alu: { hotNs: 25 } }, perRun: [{ state: st }] }));
    writeFileSync(path.join(dir, "bench-post-chrome.json"), JSON.stringify({ score: 46, kernels: { alu: { hotNs: 2.2 } }, perRun: [{ state: { ...st, visibility: "hidden" } }] }));
    const run = (v) => ({ side: "candidate", run: 1, browserVersion: v, completion: { completed: true }, phases: Object.fromEntries(["cinematic", "menu", "game"].map((p) => [p, { metrics: { speedP5: 99, smoothP5: 96, smoothReliable: true } }])) });
    [1, 2, 3, 4, 5].forEach((i) => { mkdirSync(path.join(dir, `parcours-1p-chrome-${i}`)); writeFileSync(path.join(dir, `parcours-1p-chrome-${i}`, "summary.json"), JSON.stringify({ runs: [run(i === 5 ? "158.0.1.2" : "157.0.8103.39")] })); });
    const md = jobReport(dir);
    assert.match(md, /parcours-1p-chrome-2: other processes/);
    assert.match(md, /parcours-1p-chrome-5: browser 158\.0\.1\.2, not the cell's version/);
    assert.match(md, /\| 1p \/ chrome \| game \| 3\/3 \| 99 \| 96 \|/);
    assert.match(md, /bench-post-chrome: score 46, -8 % from the target 50 \(OUTSIDE ±3 %\)/);
    assert.match(md, /Series invalid \(protocol §5\): bench-post-chrome -8 % from the target; bench-post-chrome: page hidden/);
    assert.match(md, /bench-pre-chrome: score 50\.5, 1 % from the target 50; JIT jit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pc-kit: step windows, bench hold, version outliers", () => {
  const w = stepWindows("[2026-11-20T20:00:01.1234567+01:00] step a: node x\r\n[2026-11-20T20:01:01.0000000+01:00] step a: exit 3\r\n[2026-11-20T20:02:00+01:00] step b: node y");
  assert.equal(w.a.exit, 3);
  assert.equal(w.a.to - w.a.from, 59877);
  assert.equal(w.b.to, null);
  assert.deepEqual(benchHold(51, 50), { ok: true, offPct: 2 });
  assert.deepEqual(benchHold(48, 50), { ok: false, offPct: -4 });
  assert.deepEqual(benchHold(null, 50), { ok: false, offPct: null });
  assert.deepEqual(versionOutliers([{ browserVersion: "a" }, { browserVersion: "a" }, { browserVersion: "b" }]), [{ browserVersion: "b" }]);
});

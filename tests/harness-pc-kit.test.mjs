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
  ADMIN, ADMIN_PATTERNS, assertAdmin, origFromGetActive, sshdShellOk, assertSendable, benchHold, calibrationTarget, setKitDir, stepWindows, versionOutliers, encodePs, gb6Of, j1bTable, KIT_SCHEME, kitCommand, knobIneffective, nextProbe, parseKitJson, preflight, restoreDiff, samplerVerdict
} from "../harness/lib/pc-kit.mjs";
import { calibrate } from "../harness/remote/pc-win/pc-calibrate.mjs";
import { admin, adminTransport, assertFitsTask, benchFindings, benchSteps, calibrateFromMac, clampOf, jobReport, jobSpec, parcoursSteps, runJob, simulatedPc } from "../harness/remote/pc-run.mjs";

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
  setKitDir("C:\\Users\\salonkit\\salon-kit");
  const c = kitCommand("status", { Job: "j1", Cores: 6.7, Path: "C:\\it's here" });
  assert.match(c, /^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe -NoProfile /, "PowerShell by its absolute path");
  const b64 = /-EncodedCommand (\S+)$/.exec(c)[1];
  assert.match(b64, /^[A-Za-z0-9+/=]+$/, "nothing for cmd.exe or ssh to reinterpret");
  assert.equal(Buffer.from(b64, "base64").toString("utf16le"), "& 'C:\\Users\\salonkit\\salon-kit\\salon-pc.ps1' -Action 'status' -Job 'j1' -Cores 6 -Path 'C:\\it''s here'");
  assert.equal(Buffer.from(encodePs("é"), "base64").toString("utf16le"), "é");
  assert.throws(() => kitCommand("check", { "Bad;Name": 1 }), /bad parameter/);
  const g = Buffer.from(/-EncodedCommand (\S+)$/.exec(kitCommand("cleanup", { Job: "j" }, { sha256: "ab".repeat(32) }))[1], "base64").toString("utf16le");
  assert.match(g, /^\$f = 'C:\\Users\\salonkit\\salon-kit\\salon-pc\.ps1'; if \(\(Get-FileHash -LiteralPath \$f -Algorithm SHA256\)\.Hash -ne 'ABAB/, "the PC's script is the one sent");
  assert.throws(() => kitCommand("check", {}, { sha256: "x" }), /bad sha256/);
  assert.throws(() => setKitDir("C:\\Users\\x\\other"), /expected/);
  assert.throws(() => setKitDir("C:\\Users\\a&b\\salon-kit"), /expected/);
  assert.deepEqual(parseKitJson('noise\r\nSALONKIT-JSON {"a":1}\r\nSALONKIT-JSON {"a":2}\r\n'), { a: 2 });
  assert.equal(parseKitJson("nothing"), null);
});

test("pc-kit: the administrator's commands are a closed list of fixed lines", () => {
  const o = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";
  const all = [ADMIN.getActive(), ADMIN.duplicate(o), ADMIN.rename(), ADMIN.setIndex("ac", "PROCFREQMAX", 4300), ADMIN.setIndex("dc", "PERFBOOSTMODE", 0),
    ADMIN.activateKit(), ADMIN.activate(o), ADMIN.deleteKit(), ADMIN.bootTask(o), ADMIN.queryBootTask(), ADMIN.deleteBootTask()];
  for (const l of all) {
    assert.equal(assertAdmin(l), l);
    assert.match(l, /^C:\\Windows\\System32\\(powercfg|schtasks)\.exe /, "absolute path, one of two executables");
    assert.doesNotMatch(l.replace(/\/tr ".*"$/, ""), /[&|<>^%"']/, "no shell metacharacter outside the boot task's /tr");
  }
  const tr = /\/tr "(.*)"$/.exec(ADMIN.bootTask(o))[1];
  assert.ok(tr.length <= 240, `schtasks /tr ${tr.length} <= 240 (schtasks truncates silently: a 260-character one lost its last command on CI)`);
  assert.match(tr, /\/setactive 8c5e7fda\S+ & C:\\Windows\\System32\\schtasks\.exe \/delete \/tn SalonKitRestore \/f$/, "the scheme back, then the task deletes itself");
  assert.match(tr, /^C:\\Windows\\System32\\cmd\.exe \/d \/c /, "the boot task's cmd without AutoRun");
  assert.match(ADMIN.bootTask(o), / \/sc onstart \/ru SYSTEM /, "at startup, as SYSTEM: no user file, no user profile");
  // refused: anything not of the list, whatever the reason
  for (const bad of [
    "powercfg /setactive " + o,                                         // not by absolute path
    ADMIN.activate(o) + " & calc",                                       // a second command
    "C:\\Windows\\System32\\powercfg.exe /delete " + o,                  // delete a user's scheme
    "C:\\Windows\\System32\\powercfg.exe /setactive 8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C x",
    "C:\\Windows\\System32\\cmd.exe /c whoami",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -c x",
    ADMIN.bootTask(o).replace("/sc onstart", "/sc onlogon")
  ]) assert.throws(() => assertAdmin(bad), /refused/, bad);
  for (const bad of ["x & calc", "8c5e7fda", "../../x"]) assert.throws(() => ADMIN.activate(bad), /not a GUID/);
  assert.throws(() => ADMIN.setIndex("ac", "SOMETHING", 1), /unknown setting/);
  assert.throws(() => ADMIN.setIndex("ac", "PROCFREQMAX", -1), /not an integer/);
  assert.equal(ADMIN_PATTERNS.length, 9, "nine line shapes; adding one is a review");
  assert.throws(() => ADMIN.bootTask(KIT_SCHEME), /cannot be the kit's/, "the way back is never the kit's own scheme");
  assert.throws(() => ADMIN.activate(KIT_SCHEME), /cannot be the kit's/);
  assert.equal(origFromGetActive(`Power Scheme GUID: 8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C  (High performance)`), o);
  assert.throws(() => origFromGetActive(`Power Scheme GUID: ${KIT_SCHEME}  (SalonKitClamp)`), /active already/);
  assert.throws(() => origFromGetActive("nothing"), /no scheme GUID/);
  const cmd = "C:\\Windows\\System32\\cmd.exe";
  assert.equal(sshdShellOk({ defaultShell: cmd, defaultShellCommandOption: "/d /c" }), true);
  assert.equal(sshdShellOk({ defaultShell: cmd, defaultShellCommandOption: "/D /C " }), true);
  for (const bad of ["/c /d", "/c", "/d /c /k", "/d  /c", "/s /d /c", ""]) assert.equal(sshdShellOk({ defaultShell: cmd, defaultShellCommandOption: bad }), false, `option "${bad}"`);
  assert.equal(sshdShellOk({ defaultShell: "cmd.exe", defaultShellCommandOption: "/d /c" }), false, "the shell by absolute path");
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
  assert.deepEqual(blocked((c) => { c.session.elevated = true; }), ["kit-not-elevated"], "the kit's account must be a standard one");
  assert.deepEqual(blocked((c) => { c.sshd.defaultShellCommandOption = "/c"; }), ["sshd-shell"], "cmd without /d runs HKCU AutoRun before an admin command");
  assert.deepEqual(blocked((c) => { c.sshd = {}; }), ["sshd-shell"]);
  assert.deepEqual(blocked((c) => { c.policies.chromeMachine = { DefaultJavaScriptOptimizerSetting: 2 }; }), ["chrome-jit-policy"]);
  assert.deepEqual(blocked((c) => { c.classAffinity = { error: "only 4 cores of the fastest class (asked 6)" }; }), ["class-affinity"]);
  const warns = (mut) => { const c = structuredClone(base); mut(c); return preflight(c).warnings.map((b) => b.id); };
  assert.deepEqual(warns((c) => { c.display[0].refreshHz = 144; }), ["refresh-60"]);
  assert.deepEqual(warns((c) => { c.gpus[0].refreshHz = 144; }), ["refresh-60"], "a rate from the adapter counts too");
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

// Never ok by default: what the kit's account could not read (a probe in
// probeErrors, a null reading, battery flag 255, a refresh rate unknown,
// an adapter not present) blocks a blocking item and warns otherwise.
test("pc-kit: the preflight never reads a failed or unknown probe as ok", () => {
  const base = JSON.parse(goodCheck());
  const pf = (mut) => { const c = structuredClone(base); mut(c); const p = preflight(c); return { blocked: p.blocked.map((b) => b.id), warnings: p.warnings.map((b) => b.id) }; };
  // each probe failing alone, as salon-pc.ps1 reports it (value null + probeErrors)
  const fail = (probe, set) => pf((c) => { set(c); c.probeErrors = { [probe]: "Access is denied" }; });
  assert.deepEqual(fail("battery", (c) => { c.power.battery = null; }).blocked, ["mains"], "battery unreadable: blocked");
  assert.deepEqual(fail("power", (c) => { c.power.activeScheme = null; }).blocked, ["kit-scheme-not-left"]);
  assert.deepEqual(fail("schemes", (c) => { c.power.schemes = null; }).blocked, ["kit-scheme-not-left"]);
  assert.deepEqual(fail("policies", (c) => { c.policies = null; }).blocked, ["chrome-jit-policy"]);
  assert.deepEqual(fail("sessions", (c) => { c.session.sessions = null; }).blocked, ["unlocked-session"]);
  assert.deepEqual(fail("chrome", (c) => { c.browsers.chrome = null; }).blocked, ["browser-chrome"]);
  assert.deepEqual(fail("disk", (c) => { c.disk.freeGiB = null; }).blocked, ["disk"]);
  assert.ok(fail("cpuBusy", (c) => { c.cpuBusy = null; }).warnings.includes("idle"), "load unreadable: warned");
  assert.ok(pf((c) => { c.cpuBusy.partial = true; }).warnings.includes("idle"), "load read for the kit's own processes only: warned");
  assert.ok(fail("os", (c) => { c.os = null; }).warnings.includes("windows-11"));
  assert.ok(fail("memory", (c) => { c.memory = null; }).warnings.includes("memory"), "an info item unreadable warns");
  assert.ok(fail("gpus", (c) => { c.gpus = null; }).warnings.includes("gpu-dgpu"));
  assert.ok(fail("cpu", (c) => { c.cpu = null; }).warnings.includes("gb6-known"));
  // a probe failing with a value still there (sub-probe error) is not ok either
  assert.ok(pf((c) => { c.probeErrors = { "gpus.present": "SetupDiGetClassDevs failed" }; }).warnings.includes("gpu-dgpu"));
  // battery: unknown status, never "on mains"
  assert.deepEqual(pf((c) => { c.power.battery = [{ BatteryStatus: null, EstimatedChargeRemaining: 80 }]; }).blocked, ["mains"], "AC line 255: unknown, blocked");
  assert.deepEqual(pf((c) => { delete c.power.battery; }).blocked, ["mains"], "no battery reading at all: blocked");
  // refresh rate unknown: warned, never ok
  assert.deepEqual(pf((c) => { c.display = null; c.probeErrors = { display: "Requested registry access is not allowed." }; }).warnings, ["refresh-60"]);
  assert.deepEqual(pf((c) => { delete c.display; c.gpus[0].refreshHz = null; }).warnings, ["refresh-60"]);
  // a driver left for an adapter that is not there is no dGPU
  assert.ok(pf((c) => { c.gpus[0].present = false; }).warnings.includes("gpu-dgpu"));
  assert.ok(pf((c) => { c.gpus[0].present = null; }).warnings.includes("gpu-dgpu"), "presence unknown: not counted");
  assert.ok(!pf((c) => { c.gpus[0].present = null; c.nvidia = [{ name: "NVIDIA GeForce RTX 4080" }]; }).warnings.includes("gpu-dgpu"), "nvidia-smi answering is presence");
  // everything degraded at once: nothing it depends on reads as ok
  const all = pf((c) => {
    c.power.battery = null; c.power.activeScheme = null; c.power.schemes = null; c.policies = null; c.session.sessions = null; c.disk.freeGiB = null;
    c.cpuBusy = null; c.os = null; c.memory = null; c.gpus = null; c.display = null; c.cpu = null; c.coreMap = null; c.classAffinity = { error: "x" };
    c.probeErrors = Object.fromEntries(["battery", "power", "schemes", "policies", "sessions", "disk", "cpuBusy", "os", "memory", "gpus", "display", "cpu", "coreMap"].map((k) => [k, "Access is denied"]));
  });
  for (const id of ["mains", "kit-scheme-not-left", "chrome-jit-policy", "unlocked-session", "disk", "class-affinity"]) assert.ok(all.blocked.includes(id), `${id} blocked`);
  for (const id of ["idle", "windows-11", "memory", "gpu-dgpu", "igpu-present", "refresh-60", "gb6-known", "smt"]) assert.ok(all.warnings.includes(id), `${id} warned`);
});

test("pc-kit: restore diff", () => {
  const before = { activeScheme: "a", schemes: ["a", "b"], processor: { X: { ac: 0 } }, tasks: [], kitProcesses: [] };
  assert.deepEqual(restoreDiff(before, { power: structuredClone(before), tasks: [], bootTask: false, jobProcesses: [], kitProcesses: [] }, "j"), []);
  // a process list the PC could not read is never "nothing left"
  assert.deepEqual(restoreDiff(before, { power: structuredClone(before), tasks: [], bootTask: false, jobProcesses: null, kitProcesses: null }, "j").map((x) => x.split(" (")[0]), ["job processes unknown", "kit processes unknown"]);
  assert.match(restoreDiff({ ...before, kitProcesses: null }, { power: structuredClone(before), tasks: [], bootTask: false, jobProcesses: [], kitProcesses: [] }, "j").join(), /kit processes unknown \(not read at the snapshot\)/);
  const d = restoreDiff(before, { power: { activeScheme: KIT_SCHEME, schemes: ["a", "b", KIT_SCHEME], processor: { X: { ac: 1 } } }, tasks: ["j"], bootTask: true, jobProcesses: [{ name: "msedge.exe", pid: 9 }], kitProcesses: [{ name: "node.exe", pid: 8 }], jobTmp: true }, "j");
  assert.equal(d.length, 9);
  assert.match(d.join(), /SalonKit.j still registered.*boot task.*msedge\.exe 9.*node\.exe 8.*TEMP/);
});

test("pc-run: steps interleave runs, browsers and scenes; clamps are explicit", () => {
  const s = parcoursSteps({ jobDir: "C:\\k\\jobs\\j", iso: "C:\\d\\g.iso", films: { "1p": "C:\\k\\films\\a.json", "2p": "C:\\k\\films\\b.json" }, browsers: ["chrome", "msedge"], runs: 2, query: "q=1", engineDir: "C:\\k\\trees\\e" });
  assert.deepEqual(s.map((x) => x.name), ["parcours-1p-chrome-1", "parcours-2p-chrome-1", "parcours-1p-msedge-1", "parcours-2p-msedge-1", "parcours-2p-msedge-2", "parcours-1p-msedge-2", "parcours-2p-chrome-2", "parcours-1p-chrome-2"], "the order flips round by round");
  assert.ok(s.every((x) => x.args.includes("--no-lock") && x.args.includes("--runs") && x.args[x.args.indexOf("--runs") + 1] === "1"));
  assert.equal(s[2].env.HARNESS_BROWSER_CHANNEL, "msedge");
  assert.ok(s.every((x) => x.args[x.args.indexOf("--port") + 1] === "8301"), "one origin for the game and the bench");
  assert.ok(benchSteps("b", ["msedge"], "C:\\j", "C:\\e").every((x) => x.args.includes("--port") && x.args.includes("C:\\e")), "the bench on the game's origin, its tree");
  assert.ok(assertFitsTask(s) < 8 * 3600);
  assert.throws(() => assertFitsTask(parcoursSteps({ jobDir: "j", iso: "i", films: { a: "a", b: "b" }, browsers: ["chrome", "msedge"], runs: 6, query: "q", engineDir: "e" })), /split the series/);
  const spec = jobSpec({ harnessDir: "C:\\k\\trees\\h", steps: s, affinity: "0xfff" });
  assert.equal(spec.env.HARNESS_DISPLAY, "windows");
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
    const rec = await runJob(pc, { a: adminTransport(pc, pc), job: "t1", steps: [{ name: "x", args: ["a.mjs"] }], affinity: "0xfff", clamp: { maxMhz: 4300 }, outDir: dir, harnessDir: "C:\\k", poll: 0, log: quiet });
    assert.deepEqual(rec.restore.diff, []);
    assert.equal(pc.state.active, before.active);
    assert.deepEqual(pc.state.schemes, before.schemes);
    assert.deepEqual(pc.state.tasks, []);
    assert.equal(pc.state.bootTask, false);
    const adm = pc.calls.filter((x) => x.kind === "admin").map((x) => x.command);
    assert.ok(adm.indexOf(ADMIN.getActive()) < adm.findIndex((l) => /\/create /.test(l)), "the way back read by the admin before the boot task");
    assert.equal(JSON.parse(readFileSync(path.join(dir, "t1", "orig.json"), "utf8")).adminOrig, before.active, "kept on the Mac");
    assert.ok(pc.calls.filter((x) => x.kind === "ssh").every((x) => !/powercfg \/(set|dup|delete)|Register-ScheduledTask.*Highest/i.test(x.script)), "the standard account never writes power settings");
    const spec = JSON.parse(readFileSync(path.join(dir, "t1", "spec.json"), "utf8"));
    assert.equal(spec.affinity, "0xfff");
    // the task cannot start: the clamp is undone all the same
    const broken = simulatedPc({ log: quiet });
    const ssh = broken.ssh.bind(broken);
    broken.ssh = (c) => (/-Action 'start'/.test(Buffer.from(/-EncodedCommand (\S+)/.exec(c)?.[1] ?? "", "base64").toString("utf16le")) ? (() => { throw new Error("start refused"); })() : ssh(c));
    await assert.rejects(runJob(broken, { a: adminTransport(broken, broken), job: "t2", steps: [], affinity: null, clamp: { maxMhz: 4000 }, outDir: dir, harnessDir: "C:\\k", poll: 0, log: quiet }), /start refused/);
    assert.equal(broken.state.active, before.active);
    assert.ok(!broken.state.schemes.includes(KIT_SCHEME));
    assert.equal(broken.state.bootTask, false, "the boot task removed too");
    assert.ok(broken.state.admin.every((l) => assertAdmin(l)), "every admin line of the list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pc-run: a dead task, or polls failing in a row, end the job and restore it", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-dead-"));
  try {
    const script = (c) => Buffer.from(/-EncodedCommand (\S+)/.exec(c)?.[1] ?? "", "base64").toString("utf16le");
    const dead = simulatedPc({ log: quiet });
    const ssh = dead.ssh.bind(dead);
    dead.ssh = (c) => (/-Action 'status'/.test(script(c)) ? { status: 0, out: 'SALONKIT-JSON {"state":"dead","exit":null,"logTail":[]}', err: "" } : ssh(c));
    await assert.rejects(runJob(dead, { a: adminTransport(dead, dead), job: "d1", steps: [{ name: "x", args: [] }], affinity: null, clamp: { maxMhz: 4000 }, outDir: dir, harnessDir: "C:\\k", poll: 0, log: quiet }), /stopped without an exit/);
    assert.ok(!dead.state.schemes.includes(KIT_SCHEME), "restored");
    const flaky = simulatedPc({ log: quiet });
    const ssh2 = flaky.ssh.bind(flaky);
    let n = 0;
    flaky.ssh = (c) => (/-Action 'status'/.test(script(c)) && ++n < 4 ? (() => { throw new Error("ssh: timeout"); })() : ssh2(c));
    const rec = await runJob(flaky, { job: "f1", steps: [{ name: "x", args: [] }], affinity: null, clamp: null, outDir: dir, harnessDir: "C:\\k", poll: 0, log: quiet });
    assert.equal(rec.exit, 0, "3 failed polls in a row are a blip, not the end");
    const down = simulatedPc({ log: quiet });
    const ssh3 = down.ssh.bind(down);
    down.ssh = (c) => (/-Action 'status'/.test(script(c)) ? (() => { throw new Error("ssh: timeout"); })() : ssh3(c));
    await assert.rejects(runJob(down, { job: "g1", steps: [{ name: "x", args: [] }], affinity: null, clamp: null, outDir: dir, harnessDir: "C:\\k", poll: 0, log: quiet }), /no status for 10 polls/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pc-run: no admin line leaves the Mac until the standard account has read OpenSSH's shell as cmd /d /c", () => {
  const pc = simulatedPc({ log: quiet });
  pc.state.sshd = { defaultShell: "C:\\Windows\\System32\\cmd.exe", defaultShellCommandOption: "/c /d" };
  const a = adminTransport(pc, pc);
  assert.throws(() => admin(a, ADMIN.getActive()), /not cmd\.exe \/d \/c/);
  assert.equal(pc.calls.filter((x) => x.kind === "admin").length, 0, "nothing sent");
  pc.state.sshd = undefined;
  const ok = adminTransport(pc, pc);
  assert.equal(admin(ok, ADMIN.getActive()).status, 0);
  assert.equal(pc.calls.filter((x) => x.kind === "ssh" && /-Action 'sshd'/.test(x.script)).length, 2, "read before the first line of each admin session");
  admin(ok, ADMIN.getActive());
  assert.equal(pc.calls.filter((x) => x.kind === "ssh" && /-Action 'sshd'/.test(x.script)).length, 2, "once per session");
});

test("pc-run: the calibration runs from the Mac (clamp by the admin list), each probe a bench job, and restores", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-cal-"));
  try {
    const pc = simulatedPc({ log: quiet });
    const before = structuredClone(pc.state);
    const f = await calibrateFromMac(pc, { a: adminTransport(pc, pc), job: "cal1", browser: "chrome", engineDir: "C:\\salon-kit\\trees\\e", hostGb6: 2983, turboMhz: 5800, affinity: "0xfff", outDir: dir, harnessDir: "C:\\k", poll: 0, log: quiet });
    const c = JSON.parse(readFileSync(f, "utf8"));
    assert.ok(c.chosen.maxMhz > 4100 && c.chosen.maxMhz < 4450, `chose ${c.chosen.maxMhz}`);
    assert.ok(c.errPct <= 2);
    const scripts = pc.calls.filter((x) => x.kind === "ssh").map((x) => x.script);
    const adminLines = pc.calls.filter((x) => x.kind === "admin").map((x) => x.command);
    assert.ok(adminLines.filter((x) => /\/setactive 5a10c0de/.test(x)).length >= 2, "the clamp goes through the admin list");
    assert.ok(adminLines.every((x) => assertAdmin(x)));
    assert.ok(scripts.some((x) => /-Action 'start' -Job 'cal1-b1'/.test(x)) && scripts.some((x) => /-Action 'cleanup' -Job 'cal1-b1'/.test(x)), "each probe a job of its own, cleaned up");
    assert.ok(scripts.filter((x) => /-Action/.test(x)).every((x) => /Get-FileHash/.test(x)), "every kit call checks the script's hash");
    assert.equal(pc.state.active, before.active);
    assert.deepEqual(pc.state.tasks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pc-run: the whole flow in --dry-run (no connection)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-dry-"));
  try {
    const film = path.join(dir, "f.json");
    writeFileSync(film, "{}");
    const r = spawnSync(process.execPath, ["harness/remote/pc-run.mjs", "run", "--host", "salonkit@pc", "--admin-host", "admin@pc", "--dry-run", "--out", path.join(dir, "out"), "--iso", "C:\\d\\g.iso", "--film", `1p=${film}`, "--clamp-mhz", "4300", "--runs", "1", "--job", "dry", "--engine", "HEAD"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CLAUDE_JOB_DIR: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /admin: C:\\Windows\\System32\\powercfg\.exe \/setacvalueindex 5a10c0de\S+ \S+ 75b0ae3f-bce0-45a7-8c89-c9611c25e100 4300/);
    assert.match(r.stderr, /admin: C:\\Windows\\System32\\schtasks\.exe \/delete \/tn SalonKitRestore \/f/);
    assert.match(r.stderr, /machine restored/);
    assert.doesNotMatch(r.stderr, /scp \S+\.iso/i, "no disc sent");
    const bad = spawnSync(process.execPath, ["harness/remote/pc-run.mjs", "run", "--host", "salonkit@pc", "--admin-host", "admin@pc", "--dry-run", "--out", path.join(dir, "out"), "--iso", "/Users/x/g.iso", "--film", film, "--no-clamp"], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /a Windows path on the PC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// salon-pc.ps1 under pwsh: the standard account's side. powercfg mocked,
// the task scheduler's COM API (New-Object -ComObject Schedule.Service)
// faked, and every CIM/WMI-backed cmdlet (Get-CimInstance, the
// ScheduledTasks and Defender modules, Get-Counter) failing as WMI does for
// the kit's ssh logon on a real PC (0x80041003, 2026-11-12): the script
// must never call them. It reads the power state and never writes it.
const PWSH = process.env.PWSH || "pwsh";
const hasPwsh = spawnSync(PWSH, ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).status === 0;
const SALON_PC = path.join(ROOT, "harness", "remote", "pc-win", "salon-pc.ps1");
const CIM_CMDLETS = ["Get-CimInstance", "Get-CimClass", "Invoke-CimMethod", "New-CimSession", "Get-WmiObject", "Invoke-WmiMethod", "Get-ScheduledTask", "Get-ScheduledTaskInfo", "Register-ScheduledTask", "Unregister-ScheduledTask", "Start-ScheduledTask", "Stop-ScheduledTask", "New-ScheduledTaskAction", "New-ScheduledTaskPrincipal", "New-ScheduledTaskSettingsSet", "Get-MpComputerStatus", "Get-MpPreference", "Get-Counter", "Get-PnpDevice", "Get-PnpDeviceProperty", "Get-HotFix"];
const PS_MOCKS = `
$ErrorActionPreference = 'Stop'
$global:pc = @{ active = '381b4222-f694-41f0-9685-ff5bb260df2e'; schemes = [System.Collections.ArrayList]@('381b4222-f694-41f0-9685-ff5bb260df2e', '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'); log = [System.Collections.ArrayList]@() }
function global:powercfg {
  $a = @($args); [void]$global:pc.log.Add(($a -join ' ')); $global:LASTEXITCODE = 0
  switch ($a[0]) {
    '/getactivescheme' { "Power Scheme GUID: $($global:pc.active)  (Mock)" }
    '/list' { 'Existing Power Schemes'; foreach ($s in $global:pc.schemes) { "Power Scheme GUID: $s  (Mock)" } }
    { $_ -in '/qh', '/query' } {
      if ($a[3] -notmatch '^(bc5038f7|be337238|75b0ae3f)' -or $a[3] -match 'e101$|5ed$') { $global:LASTEXITCODE = 1; return }
      "    Power Setting GUID: $($a[3])"; '      Minimum Possible Setting: 0x00000000'; '      Maximum Possible Setting: 0x00000064'
      '    Current AC Power Setting Index: 0x00000064'; '    Current DC Power Setting Index: 0x00000064'
    }
    default { $global:LASTEXITCODE = 1 }
  }
}
$global:cim = [System.Collections.ArrayList]@()
foreach ($n in @(${CIM_CMDLETS.map((c) => `'${c}'`).join(", ")})) {
  Set-Item -Path "function:global:$n" -Value { [void]$global:cim.Add($MyInvocation.MyCommand.Name); throw "Access denied (0x80041003): WMI refuses this logon Remote Enable" }
}
$global:tasks = [System.Collections.ArrayList]@()
$global:taskLog = [System.Collections.ArrayList]@()
function global:FakeTask([string]$n) {
  $t = [pscustomobject]@{ Name = $n; State = 3; LastRunTime = [datetime]'1899-12-30'; LastTaskResult = 0 }
  $t | Add-Member -MemberType ScriptMethod -Name Stop -Value { param($f) [void]$global:taskLog.Add("stop $($this.Name)") }
  $t
}
function global:FakeFolder {
  $f = [pscustomobject]@{ Path = '\\SalonKit' }
  $f | Add-Member -MemberType ScriptMethod -Name GetTasks -Value { param($flags) foreach ($n in $global:tasks) { FakeTask $n } }
  $f | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($n) if ($global:tasks -notcontains $n) { throw "The system cannot find the file specified. (0x80070002)" }; FakeTask $n }
  $f | Add-Member -MemberType ScriptMethod -Name DeleteTask -Value { param($n, $fl) [void]$global:taskLog.Add("delete $n"); [void]$global:tasks.Remove($n) }
  $f
}
function global:New-Object {
  param([string]$ComObject)
  if ($ComObject -ne 'Schedule.Service') { throw "New-Object $($ComObject) not mocked" }
  $svc = [pscustomobject]@{}
  $svc | Add-Member -MemberType ScriptMethod -Name Connect -Value { }
  $svc | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($p) if ($p -ne '\\SalonKit') { throw "folder $p not mocked" }; FakeFolder }
  $svc
}
$s = '${SALON_PC}'
`;
test("pc-kit: salon-pc.ps1 (standard account) snapshot, power, cleanup, status with powercfg mocked", { skip: hasPwsh ? false : "no pwsh" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-ps-"));
  try {
    const harness = PS_MOCKS + `$k = '${dir}'
& $s -Action snapshot -Job t1 -KitDir $k
& $s -Action power -KitDir $k
& $s -Action snapshot -Job t1 -KitDir $k
try { & $s -Action snapshot -Job 't1;rm' -KitDir $k } catch { "SALONKIT-JSON " + (@{ refused = "$_" } | ConvertTo-Json -Compress) }
try { & $s -Action clamp -Job t1 -KitDir $k } catch { "SALONKIT-JSON " + (@{ refused = "$_" } | ConvertTo-Json -Compress) }
# a link planted in a job's TEMP: cleanup removes the link, never its target
$sentinel = Join-Path $k "sentinel"; New-Item -ItemType Directory -Force -Path $sentinel | Out-Null; Set-Content -LiteralPath (Join-Path $sentinel "keep.txt") -Value "keep"
$t5 = Join-Path (Join-Path (Join-Path $k "jobs") "t5") "tmp"; New-Item -ItemType Directory -Force -Path $t5 | Out-Null
Set-Content -LiteralPath (Join-Path $t5 "a.txt") -Value "x"
New-Item -ItemType SymbolicLink -Path (Join-Path $t5 "evil") -Target $sentinel | Out-Null
& $s -Action cleanup -Job t5 -KitDir $k
"SALONKIT-JSON " + (@{ sentinelKept = (Test-Path -LiteralPath (Join-Path $sentinel "keep.txt")); tmpGone = -not (Test-Path -LiteralPath $t5) } | ConvertTo-Json -Compress)
foreach ($j in @("t3", "t4")) { New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $k "jobs") $j) | Out-Null }
Set-Content -LiteralPath (Join-Path (Join-Path (Join-Path $k "jobs") "t3") "exit") -Value ""
Set-Content -LiteralPath (Join-Path (Join-Path (Join-Path $k "jobs") "t4") "exit") -Value "0"
& $s -Action status -Job t3 -KitDir $k
& $s -Action status -Job t4 -KitDir $k
"SALONKIT-JSON " + (@{ writes = @($global:pc.log | Where-Object { $_ -notmatch '^/(getactivescheme|list|qh|query)' }) } | ConvertTo-Json -Compress)
`;
    const f = path.join(dir, "h.ps1");
    writeFileSync(f, harness);
    const r = spawnSync(PWSH, ["-NoProfile", "-File", f], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("SALONKIT-JSON ")).map((l) => JSON.parse(l.slice(14)));
    const [snap, power, snap2, badJob, noClamp, cleanup5, link, st3, st4, writes] = out;
    assert.equal(snap.state.activeScheme, "381b4222-f694-41f0-9685-ff5bb260df2e");
    assert.equal(snap.state.processor.PROCFREQMAX.ac, 100);
    assert.equal(snap.state.processor.PROCFREQMAX1, null, "a setting this CPU lacks is null, not an error");
    assert.equal(power.power.activeScheme, "381b4222-f694-41f0-9685-ff5bb260df2e");
    assert.equal(power.power.kitScheme, null);
    assert.equal(snap2.existing, true, "a second snapshot never replaces the first");
    assert.match(badJob.refused, /-Job/);
    assert.match(noClamp.refused, /clamp|ValidateSet|does not belong/i, "the script has no clamp action: the admin list does it");
    assert.equal(cleanup5.action, "cleanup");
    assert.deepEqual(link, { sentinelKept: true, tmpGone: true }, "a link in the job's TEMP is removed, its target untouched");
    assert.deepEqual([st3.state, st3.exit], ["done", -1], "an empty exit file is done, exit unknown (-1), not a crash");
    assert.deepEqual([st4.state, st4.exit], ["done", 0]);
    assert.deepEqual(writes.writes, [], "the standard account's script never writes a power setting");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The first real PC refused the kit's ssh account every CIM/WMI call
// (Get-CimInstance Win32_OperatingSystem: PermissionDenied 0x80041003, an
// ssh logon is a network one and WMI root\cimv2 grants it no "Remote
// Enable"): check died at its first line. Every action the ssh account runs
// now reads the registry, kernel32/ntdll, [Environment], quser,
// Get-Process, nvidia-smi and the task scheduler's COM API instead.
test("pc-kit: salon-pc.ps1 never calls a CIM/WMI cmdlet (its code, not its comments)", () => {
  const code = readFileSync(SALON_PC, "utf8").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#\s.*$/, "")).join("\n");
  const found = [...new Set([...code.matchAll(/\b(?:Get-Cim\w*|\w+-Cim\w+|Get-WmiObject|\w+-WmiMethod|\w+-ScheduledTask\w*|Get-Mp\w+|Get-Counter|Get-PnpDevice\w*|Get-HotFix|Win32_\w+|root\\cimv2|System\.Management\b(?!\.Automation))\b|\[wmi(?:class|searcher)?\]/gi)].map((m) => m[0]))];
  assert.deepEqual(found, [], "CIM/WMI is refused to the kit's ssh logon on a real PC: registry, native calls, COM task scheduler only");
});

test("pc-kit: salon-pc.ps1 check (and snapshot, power, status, cleanup) with every CIM/WMI cmdlet failing 0x80041003", { skip: hasPwsh ? false : "no pwsh" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pc-kit-nocim-"));
  try {
    const harness = PS_MOCKS + `$k = '${dir}'
$env:SALONKIT_TEST_ELEVATED = '0'
[void]$global:tasks.Add('old1')
& $s -Action check -KitDir $k
& $s -Action snapshot -Job c1 -KitDir $k
& $s -Action power -KitDir $k
& $s -Action status -Job old1 -KitDir $k
& $s -Action cleanup -Job old1 -KitDir $k
"SALONKIT-JSON " + (@{ cim = @($global:cim); taskLog = @($global:taskLog); tasks = @($global:tasks) } | ConvertTo-Json -Compress)
`;
    const f = path.join(dir, "h.ps1");
    writeFileSync(f, harness);
    const r = spawnSync(PWSH, ["-NoProfile", "-File", f], { encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("SALONKIT-JSON ")).map((l) => JSON.parse(l.slice(14)));
    const [check, snap, power, status, cleanup, log] = out;
    assert.deepEqual(log.cim, [], "no CIM/WMI cmdlet was called");
    assert.equal(check.action, "check", "check completes without CIM");
    assert.doesNotMatch(JSON.stringify(check), /80041003/, "no probe went through WMI");
    assert.equal(check.session.elevated, false);
    assert.equal(check.power.activeScheme, "381b4222-f694-41f0-9685-ff5bb260df2e");
    assert.deepEqual(check.kit.tasks, ["old1"], "the kit's tasks read through the task scheduler's COM API");
    assert.equal(typeof check.cpuBusy?.otherPctOfOneCore, "number", "the CPU load is read (Get-Process at worst, marked partial)");
    assert.equal(typeof check.probeErrors, "object", "what could not be read is said, item by item");
    for (const k of ["gpus", "coreMap"]) assert.ok(check[k] === null || Array.isArray(check[k]), `${k}: a list or null, never [null]`);
    assert.ok(check.power.battery === null || Array.isArray(check.power.battery));
    assert.equal(snap.action, "snapshot");
    assert.deepEqual(snap.state.tasks, ["old1"]);
    assert.equal(power.power.activeScheme, "381b4222-f694-41f0-9685-ff5bb260df2e");
    assert.equal(status.state, "queued", "a registered task never run, read through COM");
    assert.equal(cleanup.action, "cleanup");
    assert.deepEqual(cleanup.tasks, []);
    assert.deepEqual(log.taskLog, ["stop old1", "delete old1"], "cleanup stops then unregisters the job's task through COM");
    assert.deepEqual(log.tasks, []);
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

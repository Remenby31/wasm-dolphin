// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// One test per finding of the 4th adversarial review.

import assert from "node:assert/strict";
import test from "node:test";

import { padFindings } from "../harness/cli.mjs";
import { crashSignature, runChecks } from "../harness/lib/correctness.mjs";
import { correctnessGate, crossCommitGate, findingsGate } from "../harness/lib/gate.mjs";
import { confirmationItems, expandMatrix } from "../harness/lib/matrix.mjs";
import { summarizeRun } from "../harness/lib/metrics.mjs";
import { renderVsBaseline } from "../harness/lib/render-check.mjs";
import { mergeTimeline } from "../harness/lib/timeline.mjs";

const chunk = (t0, n, { vi = true, why = null } = {}) => ({
  presents: { t: Array.from({ length: n }, (_, i) => t0 + i * 16.7), frame: [], vi: [], lost: 0 },
  vi: vi ? { t: Array.from({ length: n }, (_, i) => t0 + i * 16.7), ticks: Array.from({ length: n }, (_, i) => i * 8.1e6), sinceBoot: [], sinceLoad: [], lost: 0, supported: true } : { supported: false, why },
  now: t0 + n * 16.7
});
const run = (timeline, extra = {}) => ({ summary: summarizeRun({ samples: [{ t: 0, frame: 0 }, { t: 1, frame: 60 }], timeline, ticksPerSecond: 486e6, windowEnd: timeline.presents.at(-1)?.t }), errors: [], ...extra });

test("a failed last read makes the timeline incomplete: core freeze is unjudged, not pass", () => {
  const tl = mergeTimeline([chunk(1e12, 300), { error: "validationReadTimeline: no answer within 30000 ms" }]);
  assert.equal(tl.complete, false);
  assert.equal(runChecks(run(tl)).coreFreeze.status, "unjudged");
  assert.equal(runChecks(run(mergeTimeline([chunk(1e12, 300)]))).coreFreeze.status, "pass");
});

test("presentations and VI outputs on different clocks: unusable, not silently wrong", () => {
  const c = chunk(1e12, 300);
  c.vi.t = c.vi.t.map((t) => t - 1.7e12); // a performance.now() clock vs timeOrigin + now
  const tl = mergeTimeline([c]);
  assert.equal(tl.complete, false);
  assert.ok(tl.clockMismatch > 60000);
});

test("OGL has no VI hook: unjudged with its reason, never frozen", () => {
  const tl = mergeTimeline([chunk(1e12, 300, { vi: false, why: "OGL does not report VI outputs" })]);
  const c = runChecks(run(tl)).coreFreeze;
  assert.equal(c.status, "unjudged");
  assert.match(c.detail, /OGL/);
});

test("errors from boot and warmup count: nothing is reset", () => {
  const monitor = { errors: { error: 0, unhandledrejection: 0, consoleError: 1, last: [{ kind: "console.error", t: 50 }] } };
  const s = summarizeRun({ samples: [{ t: 9000, frame: 0 }, { t: 20000, frame: 600 }], monitor });
  assert.equal(runChecks({ summary: s, errors: [] }).errors.status, "fail");
});

test("a pads crash is a crash finding, and a new crash is never 'known'", () => {
  const crashed = padFindings({ error: "four-pads: worker died before the capture", fatal: [{ type: "pageerror", text: "ErrorEvent" }, { type: "pageerror", text: "CompileError: WebAssembly.Module(): Compiling function #19 failed" }] });
  assert.equal(crashed[0].kind, "crash");
  assert.equal(findingsGate("pads", [{ kind: "unjudged", error: "core has no harness capture hook" }], crashed).ok, false);
  // Same failure on both sides is known; a different crash is a regression.
  assert.equal(crashSignature("found 3 @+905"), crashSignature("found 5 @+1474"));
  const cell = (detail) => [{ game: "g", config: "c", checks: { crash: { status: "fail", detail }, errors: { status: "pass" }, coreFreeze: { status: "pass" }, render: { status: "pass" }, audio: { status: "pass" } } }];
  assert.equal(correctnessGate(cell(crashSignature("CompileError: A 3")), cell(crashSignature("CompileError: A 9"))).ok, true);
  assert.equal(correctnessGate(cell(crashSignature("CompileError: A")), cell(crashSignature("RuntimeError: B"))).ok, false);
});

test("confirmation runs include the reference config of the same game", () => {
  const spec = { runs: 3, games: [{ id: "g", iso: "/g.iso" }], configs: [{ id: "sw", preset: "sw-interp" }, { id: "jit", preset: "sw-fast-jit" }] };
  const extra = confirmationItems(expandMatrix(spec, { env: {} }), [{ game: "g", config: "jit" }], { rounds: 2, reference: "sw" });
  assert.deepEqual(extra.map((e) => e.label).sort(), ["g__jit__r4", "g__jit__r5", "g__sw__r4", "g__sw__r5"]);
});

// Review round 4: geometry gone in the software raster under interpreter and
// JIT alike passed, since both configs of the candidate agreed.
test("cross-commit: the candidate must render what the baseline rendered at the same VI output", () => {
  const W = 8, H = 8;
  const img = (v) => ({ width: W, height: H, data: new Uint8Array(W * H * 4).fill(v) });
  const frames = { base: img(100), same: img(100), broken: img(30) };
  const rec = (file, extra = {}) => ({ game: "g", config: "sw", run: 1, capture: { file, index: 300, fromLoad: false }, ...extra });
  const load = (f) => frames[f];
  const verdict = (cand, opts = {}) => crossCommitGate(renderVsBaseline([rec("base")], [cand], { loadFrame: load, ...opts }));
  assert.equal(verdict(rec("same")).ok, true);
  assert.equal(verdict(rec("broken")).ok, false);
  assert.equal(verdict(rec("broken"), { accept: ["g/sw"] }).ok, true); // an intended change, said explicitly
  assert.equal(verdict(rec(null, { capture: { error: "VI output 300 never reached" } })).inconclusive, true);
  assert.equal(crossCommitGate(renderVsBaseline([rec(null, { capture: { error: "no hook" } })], [rec(null, { capture: { error: "no hook" } })], { loadFrame: load })).rows[0].status, "not-covered");
});

test("silent output fails when the game must make sound", () => {
  const s = (peak) => ({ summary: { audioPeak: peak }, errors: [], audioRequired: true });
  assert.equal(runChecks(s(0)).audio.status, "fail");
  assert.equal(runChecks(s(0.4)).audio.status, "pass");
  assert.equal(runChecks({ summary: {}, errors: [], audioRequired: true }).audio.status, "unjudged");
  assert.equal(runChecks({ summary: {}, errors: [] }).audio.status, "pass");
});

// From the wgpu workstream: in dual core, software and wgpu reach VI N at
// different emulated moments. Cross-renderer render checks need cpu=single.
test("cross-renderer render check: unjudged in dual core, judged single-threaded", async () => {
  const { renderChecks } = await import("../harness/lib/render-check.mjs");
  const W = 64, H = 48;
  const img = () => ({ width: W, height: H, data: new Uint8Array(W * H * 4).map((_, i) => ((i >> 2) % 7) * 30) });
  const frames = { a: img(), b: img() };
  const recs = (cpu) => [
    { game: "g", config: "sw", run: 1, label: "a", url: `http://x/?video=software&cpu=${cpu}`, capture: { file: "a", index: 300 } },
    { game: "g", config: "wgpu", run: 1, label: "b", url: `http://x/?video=wgpu&cpu=${cpu}`, capture: { file: "b", index: 300 } }
  ];
  const dual = renderChecks(recs("dual"), "sw", (f) => frames[f]);
  assert.equal(dual[1].render.status, "unjudged");
  const single = renderChecks(recs("single"), "sw", (f) => frames[f]);
  assert.equal(single[1].render.status, "pass");
});

// Final review: confirmation runs with speed: null counted as confirmations
// and produced a "confirmed" FAIL. Unmeasured replays are INCONCLUSIF.
test("final review: unmeasured confirmation runs confirm nothing", async () => {
  const { perfReport, runsByCell, decide, correctnessGate } = await import("../harness/lib/gate.mjs");
  const at = (run, speed) => ({ game: "g", config: "c", run, summary: { speed, vis: 30, frameP95: 17 } });
  const base = [1, 2, 3, 4, 5].map((r) => at(r, 100));
  const cand = [at(1, 70), at(2, 70), at(3, 70), at(4, null), at(5, null)];
  const speed = perfReport(runsByCell(base), runsByCell(cand), { initialRuns: 3 }).find((r) => r.metric === "speed");
  assert.equal(speed.confirmations, 0);
  assert.equal(speed.regressed, false);
  assert.equal(speed.inconclusive, true);
  const ok = { crash: { status: "pass" }, errors: { status: "pass" }, coreFreeze: { status: "pass" }, render: { status: "pass" }, audio: { status: "pass" } };
  const correctness = correctnessGate([{ game: "g", config: "c", checks: ok }], [{ game: "g", config: "c", checks: ok }]);
  assert.deepEqual(decide({ correctness, perf: [speed] }), { ok: false, reason: "inconclusive" });
});

// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { analyzeDifferential, mapPcToProgram } from "../harness/lib/fuzz.mjs";
import { paintRows } from "../harness/lib/markers.mjs";
import { captureSupported } from "../harness/lib/matrix.mjs";

const symbols = { cpufuzz_code_pool: "0x8003b860", words_per_program: 128, programs: 384 };
const W = 640, H = 480;
const picture = (rows) => {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set([20, 30, 90, 255], i);
  return paintRows({ width: W, height: H, data }, rows);
};
const run = (rows, extra = {}) => ({
  capture: { index: 1700, ticks: 13770000000, ...picture(rows) },
  info: { jitc: 50, jitr: 9000, pc: 0x80003000 },
  fatal: [],
  ...extra
});
const ROWS = [0x6d541552, 0x6d541552, 0, 0xffffffff];

test("a crashing PC maps back to the generated program and word", () => {
  assert.deepEqual(mapPcToProgram(0x8005a098, symbols), { program: 244, word: 14, group: "int" });
  assert.equal(mapPcToProgram(0x80003000, symbols), null);
});

test("identical captures at the same VI output, JIT exercised: pass", () => {
  assert.deepEqual(analyzeDifferential({ interp: run(ROWS), jit: run(ROWS), symbols }), { ok: true, findings: [] });
});

test("a JIT crash is reported with the program it was compiling", () => {
  const jit = run(ROWS, { capture: { error: "VI output 1700 never reached within 90000 ms" }, info: { jitc: 49, pc: 0x8005a098 }, fatal: [{ type: "pageerror", text: "ErrorEvent" }, { type: "pageerror", text: "CompileError: WebAssembly.Module(): Compiling function #19 failed\n at x" }] });
  const r = analyzeDifferential({ interp: run(ROWS), jit, symbols });
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].kind, "jit-crash");
  assert.equal(r.findings[0].program, 244);
  assert.match(r.findings[0].error, /^CompileError/);
});

test("one differing pixel is a divergence; readable rows say which", () => {
  const jit = run([0x12345678, 0x6d541552, (0b1100 << 24) | 13, 226]);
  const r = analyzeDifferential({ interp: run(ROWS), jit, symbols });
  assert.deepEqual(r.findings.map((f) => f.kind), ["divergence", "jit-self-mismatch"]);
  assert.deepEqual(r.findings[0].rows, [0, 2, 3]);
  assert.equal(r.findings[1].firstProgram, 226);
  const onePixel = run(ROWS);
  onePixel.capture.data[0] ^= 1;
  assert.equal(analyzeDifferential({ interp: run(ROWS), jit: onePixel }).findings[0].kind, "divergence");
});

test("no JIT block compiled AND run fails the fuzz", () => {
  for (const info of [{ jitc: 0, jitr: 0 }, { jitc: 12, jitr: 0 }]) {
    const r = analyzeDifferential({ interp: run(ROWS), jit: run(ROWS, { info }) });
    assert.equal(r.ok, false);
    assert.equal(r.findings[0].kind, "jit-not-exercised");
  }
});

// Review round 3: a marker-shaped corner, red ordinary pixels or a black
// screen used to pass or fail by heuristic. Now: exact capture or nothing.
test("round 3: black captures, missing captures and different frames all fail", () => {
  const black = { capture: { index: 1700, ticks: 1, width: W, height: H, data: new Uint8Array(W * H * 4) }, info: { jitc: 5, jitr: 5 }, fatal: [] };
  assert.deepEqual(analyzeDifferential({ interp: black, jit: black }).findings.map((f) => f.kind), ["interp-blank-capture", "jit-blank-capture"]);
  const missing = run(ROWS, { capture: { error: "VI output 1700 has already passed" } });
  assert.equal(analyzeDifferential({ interp: missing, jit: run(ROWS) }).findings[0].kind, "interp-no-capture");
  const later = run(ROWS);
  later.capture.index += 1;
  assert.equal(analyzeDifferential({ interp: run(ROWS), jit: later }).findings[0].kind, "capture-frame-mismatch");
});

test("round 3 (updated for #7): OGL has no exact capture; wgpu is checked by source", () => {
  assert.equal(captureSupported("video=software&wasmjit=1").ok, true);
  assert.equal(captureSupported("video=ogl").ok, false);
});

// Review round 4: ticks include the VI event's lateness, so two captures of
// the same output can carry different ticks. The output index is the identity.
test("round 4: same VI output with different ticks is the same frame", () => {
  const late = run(ROWS);
  late.capture.ticks += 37;
  assert.deepEqual(analyzeDifferential({ interp: run(ROWS), jit: late }), { ok: true, findings: [] });
});

// wgpu exact capture (PR #7): accepted only with its own source; across
// renderers the comparison runs single-threaded so VI N is the same frame.
test("capture sources and cross-renderer queries", async () => {
  const { captureSourceOk, forCrossRenderer } = await import("../harness/lib/matrix.mjs");
  assert.equal(captureSourceOk("video=wgpu", "wgpu-present"), true);
  assert.equal(captureSourceOk("video=wgpu", "guest-xfb"), false);
  assert.equal(captureSourceOk("video=software", "guest-xfb"), true);
  assert.equal(captureSupported("video=ogl").ok, false);
  assert.equal(new URLSearchParams(forCrossRenderer("video=wgpu&cpu=dual")).get("cpu"), "single");
});

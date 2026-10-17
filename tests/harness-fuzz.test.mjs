// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { analyzeDifferential, mapPcToProgram } from "../harness/lib/fuzz.mjs";

const symbols = { cpufuzz_code_pool: "0x8003b860", words_per_program: 128, programs: 384 };
const done = (rows, extra = {}) => ({ outcome: "done", info: { jitc: 50, jitr: 9000, pc: 0x80003000 }, markers: { status: "pass", rows, confident: true }, fatal: [], ...extra });

test("a crashing PC maps back to the generated program and word", () => {
  // The crash the first harness run found: program 244, word 14.
  assert.deepEqual(mapPcToProgram(0x8005a098, symbols), { program: 244, word: 14, group: "int" });
  assert.equal(mapPcToProgram(0x80003000, symbols), null);
});

test("JIT crash with a clean interpreter run is a jit-crash finding", () => {
  const jit = { outcome: "fatal", info: { jitc: 49, pc: 0x8005a098 }, fatal: [{ type: "pageerror", text: "ErrorEvent" }, { type: "pageerror", text: "CompileError: WebAssembly.Module(): Compiling function #19 failed\n at x" }] };
  const r = analyzeDifferential({ interp: done([1, 1, 0, 0xffffffff]), jit, symbols });
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].kind, "jit-crash");
  assert.equal(r.findings[0].program, 244);
  assert.match(r.findings[0].error, /^CompileError/);
});

test("different final hashes are a divergence; the JIT self-check is reported", () => {
  const jit = done([2, 1, (0b1100 << 24) | 13, 226], { markers: { status: "fail", rows: [2, 1, (0b1100 << 24) | 13, 226], confident: true } });
  const kinds = analyzeDifferential({ interp: done([1, 1, 0, 0xffffffff]), jit }).findings.map((f) => [f.kind, f.firstProgram ?? null]);
  assert.deepEqual(kinds, [["jit-self-mismatch", 226], ["divergence", null]]);
});

test("same results with the JIT exercised pass", () => {
  assert.deepEqual(analyzeDifferential({ interp: done([1, 1, 0, 0]), jit: done([1, 1, 0, 0]) }), { ok: true, findings: [] });
});

// Review 2026-10-17: a JIT that compiled nothing, or compiled but never ran,
// used to pass.
test("no JIT block compiled AND run fails the fuzz", () => {
  for (const info of [{ jitc: 0, jitr: 0 }, { jitc: 12, jitr: 0 }]) {
    const r = analyzeDifferential({ interp: done([1, 1, 0, 0]), jit: done([1, 1, 0, 0], { info }) });
    assert.equal(r.ok, false);
    assert.equal(r.findings[0].kind, "jit-not-exercised");
  }
});

// Review: only rows[0] was compared; a JIT adding A on port 4 passed.
test("every marker row is compared", () => {
  const port4 = (0x80800000 | 0x100) >>> 0;
  const r = analyzeDifferential({ interp: done([0x80800000, 0x80000000, 0x80000000, 0x80000000]), jit: done([0x80800000, 0x80000000, 0x80000000, port4]) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.findings.map((f) => [f.kind, f.rows]), [["divergence", [3]]]);
});

// Review round 2: with the no-marker fallback reachable, two black captures
// compared equal and passed.
test("round 2: black captures never pass the frame comparison", () => {
  const W = 64, H = 48;
  const black = { width: W, height: H, data: new Uint8Array(W * H * 4) };
  const run = { outcome: "done", info: { jitc: 50, jitr: 9000 }, markers: { status: null, rows: [0, 0, 0, 0], confident: false }, frame: black, fatal: [] };
  const r = analyzeDifferential({ interp: run, jit: run });
  assert.equal(r.ok, false);
  assert.deepEqual(r.findings.map((f) => f.kind), ["interp-blank-frame", "jit-blank-frame"]);
});

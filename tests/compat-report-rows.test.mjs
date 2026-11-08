// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// The report rows of compat/homebrew/hwtests-report.cpp decode back, and a
// frame whose checksum row does not match is unreadable.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeReport, paintReport, REPORT_ROWS } from "../compat/lib/report-rows.mjs";
import { markdown } from "../compat/browser.mjs";

const rows = () => {
  const r = new Array(REPORT_ROWS).fill(0);
  Object.assign(r, { 0: 0x48575431, 1: 1 | (7 << 8), 2: 6, 3: 1200, 4: 1190, 5: 2, 6: (3 << 24) | 241, 7: 0xdeadbeef, 8: (3 << 24) | 245, 9: 0x01020304 });
  return r;
};

test("report rows: counts and failures round-trip through a frame", () => {
  const rep = decodeReport(paintReport(rows()));
  assert.deepEqual(rep, { done: true, tests: 7, testsPassed: 6, subtests: 1200, subtestsPassed: 1190,
    failures: [{ test: 3, line: 241, msgHash: "deadbeef" }, { test: 3, line: 245, msgHash: "01020304" }] });
  const md = markdown([{ program: "gxtest_tev", config: "jit", status: "done", seconds: 12, report: rep }]);
  assert.match(md, /\| gxtest_tev \| jit \| done \| 6\/7 \| 1190\/1200 \| 3:241 3:245 \| 12 \|/);
});

test("report rows: a wrong checksum or magic is unreadable, never guessed", () => {
  const frame = paintReport(rows());
  // Row 2, last bit (a 0): paint the whole cell white.
  for (let y = 16 + 2 * 16; y < 16 + 2 * 16 + 12; y++) for (let x = 32 + 31 * 18; x < 32 + 31 * 18 + 14; x++) {
    const k = (y * frame.width + x) * 4;
    frame.data[k] = frame.data[k + 1] = frame.data[k + 2] = 235;
  }
  assert.equal(decodeReport(frame), null);
  const bad = rows(); bad[0] = 0;
  assert.equal(decodeReport(paintReport(bad)), null);
  assert.equal(decodeReport({ width: 100, height: 100, data: new Uint8Array(40000) }), null);
});

// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// An explicit candidate permits red/green validation before worker promotion.
const worker = await readFile(
  process.env.WGPU_VIEWPORT_TEST_WORKER || new URL("../src/upstream-discio-worker.js", import.meta.url),
  "utf8"
);
const start = worker.indexOf("case WGPU_CMD_OP_SET_VIEWPORT:");
const end = worker.indexOf("case WGPU_CMD_OP_CLEAR_RECT:", start);
assert.ok(start >= 0 && end > start, "worker SET_VIEWPORT execution seam exists");
const viewportCase = worker.slice(start, end);

function harness({ havePass = true, passW = 640, passH = 528 } = {}) {
  const calls = [];
  const depthNotes = [];
  const rectNotes = [];
  const context = vm.createContext({
    WGPU_CMD_OP_SET_VIEWPORT: 17,
    pass: havePass ? { setViewport: (...args) => calls.push(args) } : null,
    passW, passH, passFbId: 7, recWord: 0,
    f32: new Float32Array(8),
    self: { _wgPassRevZ: false },
    vpRescaled: false,
    lastAppliedViewport: null,
    drawState: {},
    vpDiagNoteViewport: (...args) => depthNotes.push(args),
    vpDiagNoteRect: (...args) => rectNotes.push(args),
    frameCapActive: () => false,
    DIAG_EFB_TO_CANVAS: false,
    console: { log() {} },
  });
  const execute = vm.runInContext(`(() => { switch (17) { ${viewportCase} } })`, context);
  return {
    calls, depthNotes, rectNotes, context,
    run(viewport) {
      context.f32.set(viewport, 1);
      execute();
      return calls.at(-1);
    },
    assertApplied(expected) {
      assert.deepEqual(calls.at(-1), expected, "GPU receives the viewport transform");
      assert.deepEqual(Array.from(context.lastAppliedViewport), expected, "later restores preserve the applied viewport");
      assert.deepEqual(Array.from(context.drawState.viewport), expected, "draw diagnostics retain the applied viewport");
      assert.equal(context.vpRescaled, false, "attachment clipping must not rescale the viewport");
    },
  };
}

test("oversized positive viewport preserves screen-space geometry beyond the attachment", () => {
  const h = harness();
  const viewport = h.run([336, 300, 608, 456, 0, 1]);
  // The NDC point (-0.5, +0.5) belongs at (488,414). Clamping the
  // transform to the attachment moves it to (412,357), shrinking geometry.
  const [x, y, width, height] = viewport;
  assert.deepEqual([x + width / 4, y + height / 4], [488, 414]);
  h.assertApplied([336, 300, 608, 456, 0, 1]);
  assert.deepEqual(h.rectNotes, [[336, 300, 608, 456, 336, 300, 608, 456, 640, 528]]);
});

for (const [name, viewport] of [
  ["negative horizontal origin", [-1, 0, 608, 456, 0, 1]],
  ["negative vertical origin", [0, -12, 608, 456, 0, 1]],
  ["zero width", [8, 12, 0, 100, 0, 1]],
  ["zero height", [8, 12, 100, 0, 0, 1]],
  ["zero area", [0, 0, 0, 0, 0, 1]],
  ["fractional coordinates and dimensions", [336.25, 300.75, 608.5, 456.25, 0, 1]],
]) {
  test(`SET_VIEWPORT preserves ${name}`, () => {
    const h = harness();
    h.run(viewport);
    h.assertApplied(viewport);
  });
}

for (const [name, near, far, expectedNear, expectedFar, reverseZ] of [
  ["ordinary depth", 0.25, 0.75, 0.25, 0.75, false],
  ["reversed depth", 0.75, 0.25, 0.25, 0.75, true],
  ["out-of-range depth", -0.5, 1.5, 0, 1, false],
  ["out-of-range reversed depth", 1.5, -0.5, 0, 1, true],
  ["reversed depth that clamps to zero span", 2, 1.5, 1, 1, true],
]) {
  test(`SET_VIEWPORT retains ${name} handling`, () => {
    const h = harness();
    h.run([8, 12, 400, 300, near, far]);
    h.assertApplied([8, 12, 400, 300, expectedNear, expectedFar]);
    assert.deepEqual(h.depthNotes, [[near, far]], "diagnostics retain raw depth endpoints");
    assert.equal(h.context.self._wgPassRevZ, reverseZ, "reverse-Z uses raw endpoints before clamping/swap");
  });
}

test("successive viewport commands replace cached geometry and clear a previous reverse-Z flag", () => {
  const h = harness();
  h.run([8, 12, 400, 300, 0.75, 0.25]);
  assert.equal(h.context.self._wgPassRevZ, true);
  h.run([336, 300, 608, 456, 0.25, 0.75]);
  h.assertApplied([336, 300, 608, 456, 0.25, 0.75]);
  assert.equal(h.context.self._wgPassRevZ, false);
  assert.equal(h.calls.length, 2);
});

test("viewport commands outside an active pass leave GPU and cached state untouched", () => {
  const h = harness({ havePass: false });
  h.run([336, 300, 608, 456, 0.75, 0.25]);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.depthNotes, []);
  assert.deepEqual(h.rectNotes, []);
  assert.equal(h.context.lastAppliedViewport, null);
  assert.equal(h.context.drawState.viewport, undefined);
  assert.equal(h.context.self._wgPassRevZ, false);
});

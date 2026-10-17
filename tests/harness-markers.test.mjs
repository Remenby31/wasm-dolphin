// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decodeMarkers, decodePadRow } from "../harness/lib/markers.mjs";

// Paint the marker protocol exactly as harness/homebrew/common/marker.h does
// (same rects, same YUV), converted to RGB like a video backend would.
const header = readFileSync(new URL("../harness/homebrew/common/marker.h", import.meta.url), "utf8");
const statusYuv = [...header.matchAll(/\{\s*(\d+),\s*(\d+),\s*(\d+)\}/g)].map((m) => m.slice(1, 4).map(Number));

function yuvToRgb([y, cb, cr]) {
  const c = 1.164 * (y - 16);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(c + 1.596 * (cr - 128)), clamp(c - 0.392 * (cb - 128) - 0.813 * (cr - 128)), clamp(c + 2.017 * (cb - 128))];
}

function paint(status, rows, scale = 1) {
  const w = 640 * scale, h = 480 * scale;
  const data = new Uint8Array(w * h * 4);
  const fill = (x0, y0, rw, rh, rgb) => {
    for (let y = y0 * scale; y < (y0 + rh) * scale; y += 1) for (let x = x0 * scale; x < (x0 + rw) * scale; x += 1) data.set([...rgb, 255], (y * w + x) * 4);
  };
  fill(576, 16, 48, 32, yuvToRgb(statusYuv[status]));
  rows.forEach((value, r) => {
    for (let i = 0; i < 32; i += 1) fill(32 + i * 18, 384 + r * 20, 14, 14, yuvToRgb([(value >>> (31 - i)) & 1 ? 235 : 16, 128, 128]));
  });
  return { width: w, height: h, data };
}

test("the decoder and marker.h agree on the four status colours", () => {
  assert.equal(statusYuv.length, 4);
  for (const [i, name] of ["idle", "running", "pass", "fail"].entries()) {
    assert.equal(decodeMarkers(paint(i, [0, 0, 0, 0])).status, name);
  }
});

test("rows decode bit-exact at native and doubled resolution", () => {
  const rows = [0xdeadbeef, 0x80000001, 0, 0xffffffff];
  for (const scale of [1, 2]) {
    const m = decodeMarkers(paint(2, rows, scale));
    assert.deepEqual(m.rows, rows);
    assert.equal(m.confident, true);
  }
});

test("padtest rows decode to GameCube controls", () => {
  // valid | connected | START | A | stick right | C-stick left
  const v = (1 << 31) | (1 << 23) | 0x1000 | 0x100 | (1 << 13) | (1 << 18);
  assert.deepEqual(decodePadRow(v >>> 0), { connected: true, pressed: ["A", "START", "STICK_RIGHT", "C_STICK_LEFT"] });
  assert.equal(decodePadRow(0), null);
});

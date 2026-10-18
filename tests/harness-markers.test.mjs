// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { decodePadRow, decodeRows, paintRows } from "../harness/lib/markers.mjs";

const W = 640, H = 480;
const blank = () => ({ width: W, height: H, data: new Uint8Array(W * H * 4).fill(255).map((v, i) => (i % 4 === 3 ? 255 : 0)) });

test("rows with a matching checksum row decode exactly", () => {
  const rows = [0xdeadbeef, 0x80000001, 0, 0xffffffff];
  assert.deepEqual(decodeRows(paintRows(blank(), rows)), { ok: true, rows });
});

// Review round 3: a green or yellow game corner and black bands read as
// "confident" markers. Now only the checksum decides.
test("pictures that are not marker rows are unreadable, never guessed", () => {
  const black = blank();
  assert.equal(decodeRows(black).ok, false); // all zeros: the checksum of four zeros is not zero
  const noise = blank();
  for (let i = 0; i < noise.data.length; i += 4) noise.data.fill((i * 7919) % 251, i, i + 3);
  assert.equal(decodeRows(noise).ok, false);
  const tampered = paintRows(blank(), [1, 2, 3, 4]);
  // flip one data cell of row 0 (bit 31)
  for (let y = 384; y < 396; y += 1) for (let x = 32; x < 46; x += 1) tampered.data.set([255, 255, 255, 255], (y * W + x) * 4);
  assert.equal(decodeRows(tampered).ok, false);
});

test("padtest rows decode to GameCube controls", () => {
  const v = (1 << 31) | (1 << 23) | 0x1000 | 0x100 | (1 << 13) | (1 << 18);
  assert.deepEqual(decodePadRow(v >>> 0), { connected: true, pressed: ["A", "START", "STICK_RIGHT", "C_STICK_LEFT"] });
  assert.equal(decodePadRow(0), null);
});

test("marker.h and the decoder agree on the layout", async () => {
  const { readFileSync } = await import("node:fs");
  const header = readFileSync(new URL("../harness/homebrew/common/marker.h", import.meta.url), "utf8");
  assert.match(header, /#define MK_ROWS 4/);
  assert.match(header, /384 \+ row \* 16, 14, 12/);
  assert.match(header, /32 \+ i \* 18/);
});

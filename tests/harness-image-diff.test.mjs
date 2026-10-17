// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { compareFrames } from "../harness/lib/image-diff.mjs";

const W = 640, H = 480;

// A synthetic "game frame": checkerboard world (detail everywhere) under a
// flat HUD bar. Options remove the world or squeeze it, as wgpu did on Apple.
function scene({ world = true, squeeze = 0, hud = true } = {}) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const i = (y * W + x) * 4;
    let rgb = [0, 0, 0];
    const sx = Math.round((x - squeeze) * (W / (W - 2 * squeeze)));
    if (world && x >= squeeze && x < W - squeeze) rgb = ((sx >> 4) + (y >> 4)) & 1 ? [220, 220, 220] : [40, 90, 40];
    if (hud && y > 410 && y < 450 && x > 40 && x < 300) rgb = [255, 128, 0];
    data.set([...rgb, 255], i);
  }
  return { width: W, height: H, data };
}

test("identical frames match", () => {
  const r = compareFrames(scene(), scene());
  assert.equal(r.verdict, "match");
  assert.equal(r.ssim, 1);
  assert.equal(r.lostDetail, 0);
});

test("HUD drawn but 3D world missing is flagged missing-detail", () => {
  const r = compareFrames(scene(), scene({ world: false }));
  assert.equal(r.verdict, "missing-detail");
  assert.ok(r.lostDetail > 0.8, `lostDetail ${r.lostDetail}`);
});

test("a black frame is blank", () => {
  assert.equal(compareFrames(scene(), scene({ world: false, hud: false })).verdict, "blank");
});

test("a horizontally shrunk picture is a geometry mismatch with its extent", () => {
  const r = compareFrames(scene(), scene({ squeeze: 28 }));
  assert.equal(r.verdict, "geometry-mismatch");
  assert.ok(Math.abs(r.extent.candidate.x[0] - 28 / W) < 0.01);
});

test("resolution differences alone do not fail the comparison", () => {
  const small = scene();
  const big = { width: W * 2, height: H * 2, data: new Uint8Array(W * H * 16) };
  for (let y = 0; y < H * 2; y += 1) for (let x = 0; x < W * 2; x += 1) {
    big.data.set(small.data.subarray(((y >> 1) * W + (x >> 1)) * 4, ((y >> 1) * W + (x >> 1)) * 4 + 4), (y * W * 2 + x) * 4);
  }
  assert.equal(compareFrames(small, big).verdict, "match");
});

// Review 2026-10-17: smooth content squeezed between two 20 px margins scored
// SSIM 0.927 and came out "match".
test("a squeezed picture is a geometry mismatch even when SSIM is high", () => {
  const bands = (margin) => {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y += 1) for (let x = margin; x < W - margin; x += 1) {
      const v = 60 + ((y >> 5) & 1) * 120;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
    return { width: W, height: H, data };
  };
  const r = compareFrames(bands(0), bands(20));
  assert.ok(r.ssim >= 0.9, `ssim ${r.ssim}`);
  assert.equal(r.verdict, "geometry-mismatch");
});

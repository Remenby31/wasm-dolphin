// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createWgpuExactCapture, packReadbackRows, WGPU_CAPTURE_SOURCE } from "../src/wgpu-exact-capture.js";

const tag = (boot, load = boot, ticks = boot * 1000) => ({ boot, load, ticks });
const image = (label) => ({ width: 1, height: 1, pixels: new Uint8Array([label, 0, 0, 255]) });

function reads() {
  const calls = [];
  let n = 0;
  return { calls, readback: (kind) => { calls.push(kind); return image(++n); } };
}

test("the PRESENT that follows the tagged VI output is the capture", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  c.onViTag(tag(9), r.readback); c.onPresent(r.readback);
  const capture = c.arm(10);
  c.onViTag(tag(10, 4, 10_000), r.readback);
  assert.deepEqual(r.calls, [], "nothing read before the present");
  c.onPresent(r.readback);
  const got = await capture;
  assert.deepEqual(r.calls, ["present"]);
  assert.equal(got.index, 10);
  assert.equal(got.ticks, 10_000);
  assert.equal(got.source, WGPU_CAPTURE_SOURCE);
  assert.equal(got.pixels[0], 1);
});

test("a duplicate XFB output is the last presented picture", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  const capture = c.arm(12);
  c.onViTag(tag(11), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(12), r.readback); // no PRESENT: duplicate
  assert.deepEqual(r.calls, []);
  c.onViTag(tag(13), r.readback);
  const got = await capture;
  assert.deepEqual(r.calls, ["last"]);
  assert.equal(got.index, 12);
});

test("a skipped output is rejected, never answered with a neighbour", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  const capture = c.arm(20);
  c.onViTag(tag(19), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(21), r.readback); c.onPresent(r.readback);
  await assert.rejects(capture, /VI output 20 was skipped/);
  assert.deepEqual(r.calls, []);
});

test("an output the stream already showed is rejected at arm time", () => {
  const c = createWgpuExactCapture();
  const r = reads();
  c.onViTag(tag(30), r.readback); c.onPresent(r.readback);
  assert.throws(() => c.arm(30), /already passed/);
  assert.throws(() => c.arm(29), /already passed/);
  c.onViTag(tag(31), r.readback);
  // Tagged but not yet presented: still capturable.
  const pending = c.arm(31);
  c.onPresent(r.readback);
  return pending;
});

test("since-load indices restart on a savestate load instead of skipping", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  c.onViTag(tag(100, 2), r.readback); c.onPresent(r.readback);
  const capture = c.arm(3, true);
  c.onViTag(tag(101, 1), r.readback); c.onPresent(r.readback); // a load happened: 2 -> 1
  c.onViTag(tag(102, 2), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(103, 3, 7), r.readback); c.onPresent(r.readback);
  const got = await capture;
  assert.equal(got.index, 3);
  assert.equal(got.fromLoad, true);
  assert.equal(got.ticks, 7);
});

test("a failed readback rejects the request and frees it", async () => {
  const c = createWgpuExactCapture();
  const capture = c.arm(5);
  c.onViTag(tag(5), () => image(0));
  c.onPresent(() => { throw new Error("no presented WebGPU texture to read back"); });
  await assert.rejects(capture, /no presented WebGPU texture/);
  assert.equal(c.pending, false);
  c.cancel("unused");
});

test("readback rows drop the 256-byte padding and swap BGRA", () => {
  const bytes = new Uint8Array(256 * 2);
  bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  bytes.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
  assert.deepEqual([...packReadbackRows(bytes, 2, 2, 256, false)],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual([...packReadbackRows(bytes, 2, 1, 256, true)], [3, 2, 1, 4, 7, 6, 5, 8]);
});

test("the worker routes video=wgpu captures to the tagged presents", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /if \(harnessVideoBackend === "WebGPU"\) return captureAtViOutputWgpu\(/);
  assert.match(worker, /const WGPU_CMD_OP_VI_TAG = 26;/);
  assert.match(worker, /case WGPU_CMD_OP_VI_TAG:\n\s*\/\/[^\n]*\n\s*wgpuExactCapture\.onViTag\(/);
  assert.match(worker, /recordPresentedFrame\(api\?\.getFrame\?\.\(\) \?\? 0\);\n\s*wgpuExactCapture\.onPresent\(readbackWgpuPresentSource\);/);
  // Read back only what is readable, and only while the harness is on.
  assert.match(worker, /\(\(harnessEnabled \|\| DIAG_TEX_READBACK/);
  const patch = await readFile(new URL(
    "../patches/dolphin-wasm/snapshot/0069-webgpu-tag-presents-with-vi-output.patch", import.meta.url), "utf8");
  assert.match(patch, /\+  ViTag = 26,/);
  assert.match(patch, /\+        DolphinWeb_WebGpuTagViOutput\(vi_since_boot, vi_since_load, ticks\);/);
});

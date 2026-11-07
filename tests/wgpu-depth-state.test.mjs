// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { gxClearDepthToStored, gxDepthState } from "../src/wgpu-depth-state.js";

const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");

test("a GX draw with the Z compare off never writes depth", () => {
  // A racing game draws its sky first with test=0, update=1. GX
  // ignores the update; WebGPU's "always" compare would still write.
  assert.deepEqual(gxDepthState(0, 1, "less-equal"),
    { depthWriteEnabled: false, depthCompare: "always" });
  assert.deepEqual(gxDepthState(1, 1, "less-equal"),
    { depthWriteEnabled: true, depthCompare: "less-equal" });
  assert.deepEqual(gxDepthState(1, 0, "greater"),
    { depthWriteEnabled: false, depthCompare: "greater" });
  assert.deepEqual(gxDepthState(1, 1, undefined),
    { depthWriteEnabled: true, depthCompare: "always" });
});

test("a scissored clear stores the GX clear depth as 1 - z", () => {
  const far = 0xffffff / 16777216;
  assert.ok(gxClearDepthToStored(far) < 1e-7);
  assert.equal(gxClearDepthToStored(0), 1);
  assert.equal(gxClearDepthToStored(0.25), 0.75);
  assert.equal(gxClearDepthToStored(2), 0);
});

test("the replay builds both pipeline depth states and the clear depth through the helpers", () => {
  assert.match(worker, /import \{ gxClearDepthToStored, gxDepthState \} from "\.\/wgpu-depth-state\.js";/);
  assert.equal(worker.match(/gxDepthState\(depthTest, depthWrite, WGPU_COMPARE\[depthCompare\]\)/g)?.length, 2);
  assert.doesNotMatch(worker, /depthWriteEnabled: !!depthWrite/);
  assert.match(worker, /const cdepth = GX_NATIVE_DEPTH \? cdepthRaw : gxClearDepthToStored\(cdepthRaw\);/);
});

test("dual-source blending is requested from the device and advertised to the core", () => {
  // Requested unless the harness masks it (?wgpumask, tests/wgpu-feature-mask).
  assert.match(worker, /const wantFeatures = \[[^\]]*"dual-source-blending"[^\]]*\]\s*\.filter\(\(f\) => !wgpuMaskedFeatures\.has\(f\)\);/);
  assert.match(worker, /const RENDERER_FEATURE_DUAL_SOURCE_BLEND = 1 << 1;/);
  assert.match(worker,
    /renderGpu\?\.device\?\.features\?\.has\?\.\("dual-source-blending"\)\) \{\n\s*rendererFeatureMask = \(rendererFeatureMask \| RENDERER_FEATURE_DUAL_SOURCE_BLEND\)/);
  // The core sends factor codes 10/11 for SRC1 alpha (MapSrcFactor/MapDstFactor).
  const table = worker.match(/const WGPU_BLEND_FACTOR = (\[[\s\S]*?\]);/)[1];
  const factors = JSON.parse(table.replace(/\/\/.*$/gm, ""));
  assert.equal(factors[10], "src1-alpha");
  assert.equal(factors[11], "one-minus-src1-alpha");
});

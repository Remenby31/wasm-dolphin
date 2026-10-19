// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

// Upscaling study flags (docs/upscaling-study.md): the defaults change
// nothing, and the EASU constants are those of ffx_fsr1.h's FsrEasuCon.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { requestedInternalResolution } from "../src/core-host.js";
import { easuConstants, requestedUpscaleStudy } from "../src/wgpu-upscale-study.js";

test("upscale study: ?ir= is 1 to 4, native otherwise", () => {
  assert.equal(requestedInternalResolution(""), 1);
  assert.equal(requestedInternalResolution("?ir=2"), 2);
  assert.equal(requestedInternalResolution("?ir=3"), 3);
  for (const bad of ["?ir=0", "?ir=5", "?ir=x", "?ir=-2"]) assert.equal(requestedInternalResolution(bad), 1, bad);
});

test("upscale study: no filter and no timer unless asked", () => {
  assert.deepEqual(requestedUpscaleStudy(""), { filter: "", factor: 2, sharpness: 0.2, gpuTime: false });
  assert.deepEqual(requestedUpscaleStudy("?upscale=easu&upscalex=3&sharp=0&gputime=1"),
    { filter: "easu", factor: 3, sharpness: 0, gpuTime: true });
  assert.equal(requestedUpscaleStudy("?upscale=lanczos").filter, "");
  assert.equal(requestedUpscaleStudy("?upscale=bilinear&upscalex=4").factor, 2);
  assert.equal(requestedUpscaleStudy("?sharp=9").sharpness, 2);
});

test("upscale study: EASU constants for 640x480 to 1280x960", () => {
  const c = easuConstants(640, 480, 1280, 960);
  const near = (a, b) => Math.abs(a - b) < 1e-7;
  [0.5, 0.5, -0.25, -0.25, 1 / 640, 1 / 480, 1 / 640, -1 / 480, -1 / 640, 2 / 480, 1 / 640, 2 / 480, 0, 4 / 480, 0, 0]
    .forEach((v, i) => assert.ok(near(c[i], v), `con[${i}] = ${c[i]}, expected ${v}`));
});

test("upscale study: the core and patch 0082 read the same setting", () => {
  const core = readFileSync(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  assert.match(core, /Config::SetBase\(Config::GFX_EFB_SCALE, s_video_backend == "WebGPU" \? efb_scale : 1\)/);
  const patch = readFileSync(new URL("../patches/dolphin-wasm/snapshot/0082-webgpu-internal-resolution-backbuffer.patch", import.meta.url), "utf8");
  assert.match(patch, /\+  const int scale = std::clamp\(Config::Get\(Config::GFX_EFB_SCALE\), 1, 4\);/);
  assert.match(patch, /\+  return \{640 \* scale, 480 \* scale, 1\.0f, AbstractTextureFormat::BGRA8\};/);
});

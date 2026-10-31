// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// SOURCE-CONTRACT test over patch 0068 and the Naga bridge. It cannot render;
// the visual evidence (a racing game's race and attract demo against
// the software renderer) is in the PR. It pins the two decisions that make
// that evidence hold, so a later patch cannot quietly undo them:
//
//   1. The WebGPU EFB holds 1 - z, like every Dolphin backend without
//      bSupportsReversedDepthRange. Earlier patches skipped the 1 - z for
//      api_type Vulkan (= WebGPU here) in z-texture/fog depth, EFB depth
//      copies, peeks, pokes and clears. MKDD's z-texture draw then wrote
//      "nearest" over the whole frame and the track failed the depth test.
//   2. Dual-source blending is enabled from the host's device feature, so a
//      draw with GX destination alpha still blends with the TEV alpha.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const dir = new URL("../patches/dolphin-wasm/snapshot/", import.meta.url);
const name = (await readdir(dir)).find((f) => /^0068-.*\.patch$/.test(f));
const patch = name ? await readFile(new URL(name, dir), "utf8") : "";
const naga = await readFile(new URL("../tools/naga-spirv-wgsl/src/lib.rs", import.meta.url), "utf8");

const removed = (re) => patch.split("\n").filter((l) => l.startsWith("-") && re.test(l));
const added = (re) => patch.split("\n").filter((l) => l.startsWith("+") && re.test(l));

test("patch 0068 restores the upstream 1 - z for the WebGPU (Vulkan-typed) backend", () => {
  assert.ok(name, "patch 0068 is in the locked snapshot series");
  // Every gate that exempted api_type Vulkan from the depth inversion goes.
  assert.ok(removed(/api_type [!=]= APIType::Vulkan/).length >= 10);
  assert.deepEqual(added(/api_type [!=]= APIType::Vulkan\)?$/), []);
  for (const file of ["PixelShaderGen.cpp", "UberShaderPixel.cpp", "TextureConversionShader.cpp",
    "TextureConverterShaderGen.cpp", "EFBInterface.cpp", "AbstractGfx.cpp", "FramebufferManager.cpp"]) {
    assert.match(patch, new RegExp(`\\+\\+\\+ b/Source/Core/VideoCommon/${file}`), file);
  }
});

test("patch 0068 takes dual-source blending from renderer feature bit 1", () => {
  assert.match(patch, /\+static constexpr unsigned int DOLPHIN_WEB_RENDERER_FEATURE_DUAL_SOURCE_BLEND = 1u << 1;/);
  assert.match(patch, /-  g_backend_info\.bSupportsDualSourceBlend = false;/);
  assert.match(patch, /\+      \(DolphinWeb_GetRendererFeatureMask\(\) & DOLPHIN_WEB_RENDERER_FEATURE_DUAL_SOURCE_BLEND\) != 0;/);
  // SRC1 factor codes match WGPU_BLEND_FACTOR[10], [11] in the worker.
  assert.match(patch, /\+  case SrcBlendFactor::SrcAlpha: return dual_src \? 10 : 4;/);
  assert.match(patch, /\+  case DstBlendFactor::InvSrcAlpha: return dual_src \? 11 : 5;/);
  // WGSL blend_src outputs must be the only fragment outputs.
  assert.match(patch, /\+  if \(g_backend_info\.api_type == APIType::Vulkan && ps->per_pixel_depth\)/);
});

test("the Naga bridge turns the Index-1 output into @blend_src(1)", () => {
  assert.match(naga, /const DECORATION_INDEX: u32 = 32;/);
  assert.match(naga, /\*blend_src = Some\(1\);/);
  assert.match(naga, /\*blend_src = Some\(0\);/);
  assert.match(naga, /let parked = park_dual_source_output\(words\);/);
});

// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// GX depth state as the WebGPU replay must express it.
//
// The EFB depth buffer holds 1 - z (GX z: 0 = near, 1 = far). VertexShaderGen
// negates the projected z and BPFunctions hands over the 1 - depth viewport
// that backends without reversed depth ranges get; WebGPU cannot reverse the
// viewport range, so this is the only convention available. Hence depth is
// cleared to 0.0 and every ordered compare is mirrored (see resolvePipeline).

// GX only updates the Z buffer when the Z compare is enabled: with
// compare_enable false, update_enable is ignored. Vulkan/D3D/GL encode the
// same rule (no depth write while the depth test is disabled), so Dolphin
// passes test_enable and update_enable through unchanged. WebGPU has no
// "test disabled" state; the closest is compare "always", which still writes
// when depthWriteEnabled is true. Gate the write on the test here.
export function gxDepthState(testEnable, updateEnable, compare) {
  const test = !!testEnable;
  return {
    depthWriteEnabled: test && !!updateEnable,
    depthCompare: test ? (compare || "always") : "always",
  };
}

// A scissored EFB clear carries the game's GX clear depth (z / 2^24). Store
// it in the buffer's convention. Clearing to a constant 0.0 instead is only
// right for the far plane; a game that clears Z to anything nearer would see
// everything behind that plane survive the depth test.
export function gxClearDepthToStored(gxDepth) {
  return Math.min(1, Math.max(0, 1 - gxDepth));
}

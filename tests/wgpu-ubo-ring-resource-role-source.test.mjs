// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

sourceContractTest("producer tags only the WebGPU UBO ring with a stable resource role", async () => {
  const [header, stream, gfx, patch] = await Promise.all([
    source("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h"),
    source("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp"),
    source("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp"),
    source("patches/dolphin-wasm/snapshot/0051-tag-webgpu-ubo-ring-resource.patch"),
  ]);
  assert.match(header, /enum class BufferResourceRole : u32[\s\S]*Unknown = 0,[\s\S]*UboRing = 1/);
  assert.match(
    header,
    /PushCreateBuffer\(u32 size, u32 usage_flags,[\s\S]*BufferResourceRole role = BufferResourceRole::Unknown\)/
  );
  assert.match(stream, /rec\.arg\.u\[3\] = static_cast<u32>\(role\)/);
  assert.match(
    gfx,
    /PushCreateBuffer\(kUboRingSize, kUsageUniform,[\s\S]*BufferResourceRole::UboRing\)/
  );
  // The ring is created lazily, and since utility uploads can precede the first
  // GX draw there is now more than one site that can create it. What matters is
  // not how many sites there are but that every one of them is guarded on the
  // ring not already existing and tags the buffer with the same role -- one
  // ring, created once, whichever path gets there first.
  const uboRingSites = gfx.match(/BufferResourceRole::UboRing/g) ?? [];
  assert.ok(uboRingSites.length >= 1, "the UBO ring must be tagged with its role");
  const guardedCreations = gfx.match(
    /if \(m_ubo_ring == 0\)\s*m_ubo_ring = m_cmd_stream\.PushCreateBuffer\(\s*kUboRingSize, kUsageUniform,\s*BufferResourceRole::UboRing\)/g
  ) ?? [];
  assert.equal(
    guardedCreations.length, uboRingSites.length,
    "every UboRing creation must be guarded by m_ubo_ring == 0"
  );
  assert.match(patch, /u3=BufferResourceRole/);
  assert.match(patch, /BufferResourceRole::UboRing/);
});

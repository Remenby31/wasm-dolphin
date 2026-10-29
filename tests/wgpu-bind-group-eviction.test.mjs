// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// 0201: the core destroys the bind groups it evicts from its bind group 1
// cache. Before, the worker's id map only shrank on a destroy the core never
// sent: every evicted GPUBindGroup stayed alive (~2,000 a second in a race,
// 135,000 after a minute; gigabytes of WebKit malloc under Safari, the
// renderer's slow climb under Chrome).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const PATCH = "../patches/dolphin-wasm/snapshot/0201-webgpu-destroy-evicted-bind-groups.patch";

function checkGfx(gfx, header, { wholeFile = false } = {}) {
  // The evicted id is retired, not destroyed in place (the pass may still bind it).
  assert.match(gfx, /if \(slot->id != 0\)\n\s+m_retired_bind_groups\.push_back\(slot->id\);\n\s+slot->id = id;/);
  // Destroyed only between passes, with the consumer's bind group tag.
  assert.match(gfx, /static constexpr u32 kDestroyTagBindGroup = 3;/);
  assert.match(gfx, /void WebGPUGfx::DestroyRetiredBindGroups\(\)\n\{[\s\S]*?if \(m_pass_open \|\| m_retired_bind_groups\.empty\(\)\)\n\s+return;\n\s+for \(const u32 id : m_retired_bind_groups\)\n\s+m_cmd_stream\.PushDestroy\(kDestroyTagBindGroup, id\);\n\s+m_retired_bind_groups\.clear\(\);/);
  // Right after the pass end (committed or aborted), once the pass is closed.
  assert.match(gfx, /const bool committed = m_cmd_stream\.PushEndPass\(\);\n\s+m_pass_open = false;\n\s+ResetRecordedPassState\(\);\n\s+DestroyRetiredBindGroups\(\);/);
  // An aborted pass (EndPassIfOpen's failed geometry flush included) empties the list too.
  // (the patch's hunks do not carry that function's head: whole file only)
  if (wholeFile) assert.match(gfx, /void WebGPUGfx::AbortRecordedPass\(\)\n\{[\s\S]*?m_pass_open = false;[\s\S]*?DestroyRetiredBindGroups\(\);\n\}/);
  assert.match(header, /std::vector<u32> m_retired_bind_groups;/);
  assert.match(header, /void DestroyRetiredBindGroups\(\);/);
}

test("0201: the patch retires evicted bind groups and destroys them at the pass end", async () => {
  const patch = await read(PATCH);
  const added = (file) => patch.split(/^diff --git /m).find((p) => p.startsWith(`a/Source/Core/VideoBackends/WebGPU/${file}`))
    .split("\n").filter((l) => l.startsWith("+") || l.startsWith(" ")).map((l) => l.slice(1)).join("\n");
  checkGfx(added("WebGPUGfx.cpp"), added("WebGPUGfx.h"));
});

sourceContractTest("0201: the patched vendor tree retires evicted bind groups and destroys them at the pass end", async () => {
  const root = "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/";
  checkGfx(await read(`${root}WebGPUGfx.cpp`), await read(`${root}WebGPUGfx.h`), { wholeFile: true });
});

test("0201: the worker drops a destroyed bind group and reports how many are alive", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /: tag === 3 \? webGpuObjects\.bindGroups : null;/);
  assert.match(worker, /m\.delete\(id\);\n\s+if \(tag === 3\) webGpuObjects\.bindGroupSamplingMasks\.delete\(id\);/);
  assert.match(worker, /bindGroups: webGpuObjects\.bindGroups\.size,/);
});

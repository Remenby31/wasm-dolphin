// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

function applyDistance(current, distance) {
  return distance ? { next: current + distance, break: false } : { next: current, break: true };
}

test("direct and generic callback arms retain identical distance-or-break behavior", () => {
  for (const distance of [0, 8, 32, 64]) {
    const generic = applyDistance(1024, distance);
    const direct = applyDistance(1024, distance);
    assert.deepEqual(direct, generic);
  }
});

sourceContractTest("direct RunWasmBlock dispatch is compile-time gated and default off", async () => {
  const [implementation, configure, buildInfo, patch] = await Promise.all([
    source("vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp"),
    source("tools/configure-upstream-wasm.mjs"),
    source("tools/core-build-info.mjs"),
    source("patches/dolphin-wasm/snapshot/0050-cached-interpreter-direct-wasm-block-dispatch.patch"),
  ]);

  assert.match(
    implementation,
    /#ifndef DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH\r?\n#define DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH 0\r?\n#endif/
  );
  assert.match(
    implementation,
    /#if DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH\r?\n#define DOLPHIN_WEB_DIRECT_WASM_BLOCK_INLINE __attribute__\(\(always_inline\)\)/
  );
  assert.match(
    implementation,
    /#if DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH\r?\n\s*else if \(callback == AnyCallbackCast\(RunWasmBlock\)\)/
  );

  assert.match(configure, /process\.env\.DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH \?\? "0"/);
  assert.match(configure, /\["0", "1"\]\.includes\(directWasmBlockDispatch\)/);
  assert.match(
    configure,
    /-DDOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH=\$\{directWasmBlockDispatch\}/
  );
  assert.match(configure, /directWasmBlockDispatch,/);
  assert.match(buildInfo, /directWasmBlockDispatch: configure\.directWasmBlockDispatch/);
  assert.match(patch, /DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH/);
});

sourceContractTest("direct arm preserves RunWasmBlock semantics and the generic fallback", async () => {
  const implementation = await source(
    "vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp"
  );
  const runWasmBlock = /DOLPHIN_WEB_DIRECT_WASM_BLOCK_INLINE s32 CachedInterpreter::RunWasmBlock\([\s\S]*?\n}\r?\n\r?\nbool CachedInterpreter::TryWriteWasmBlock/.exec(implementation)?.[0] ?? "";

  assert.match(runWasmBlock, /\+\+s_wasm_block_run_count/);
  assert.match(runWasmBlock, /operands\.handle/);
  assert.match(runWasmBlock, /reinterpret_cast<std::uintptr_t>\(&ppc_state\)/);
  assert.match(runWasmBlock, /if \(halted\)\r?\n\s*return 0/);
  assert.match(runWasmBlock, /if \(operands\.end_block\)/);
  assert.match(runWasmBlock, /ppc_state\.pc = ppc_state\.npc/);
  assert.match(runWasmBlock, /ppc_state\.downcount -= operands\.downcount/);
  assert.match(runWasmBlock, /UpdatePerformanceMonitorIfNeeded\(operands\.downcount/);
  assert.match(runWasmBlock, /return sizeof\(AnyCallback\) \+ sizeof\(operands\)/);

  assert.match(
    implementation,
    /else if \(callback == AnyCallbackCast\(RunWasmBlock\)\)\r?\n\s*{\r?\n\s*if \(const auto distance =\r?\n\s*RunWasmBlock\(ppc_state, \*reinterpret_cast<const WasmBlockOperands\*>\(payload\)\)\)\r?\n\s*normal_entry \+= distance;\r?\n\s*else\r?\n\s*break;\r?\n\s*}/
  );
  assert.match(
    implementation,
    /else\r?\n\s*{\r?\n\s*if \(const auto distance = callback\(ppc_state, payload\)\)\r?\n\s*normal_entry \+= distance;\r?\n\s*else\r?\n\s*break;\r?\n\s*}/
  );
  assert.match(
    implementation,
    /Write\(RunWasmBlock,\r?\n\s*\{handle, block_next_pc, eff_downcount, eff_loadstores, eff_fpinst,/
  );
});

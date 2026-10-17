// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

sourceContractTest("fallback block-map diagnostics are compile-time gated and default off", async () => {
  const [header, implementation, configure, buildInfo] = await Promise.all([
    source("vendor/dolphin/Source/Core/Core/PowerPC/JitCommon/JitCache.h"),
    source("vendor/dolphin/Source/Core/Core/PowerPC/JitCommon/JitCache.cpp"),
    source("tools/configure-upstream-wasm.mjs"),
    source("tools/core-build-info.mjs"),
  ]);

  assert.match(
    implementation,
    /#ifndef DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS\r?\n#define DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS 0\r?\n#endif/
  );
  assert.match(implementation, /#if DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS/);
  assert.match(implementation, /#else\r?\n\s*JitBlock\* block =[\s\S]*?MoveBlockIntoFastCache/);
  assert.match(header, /struct JitFallbackDispatchStats/);
  assert.match(header, /GetJitFallbackDispatchStats\(\)/);

  assert.match(
    configure,
    /process\.env\.DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS \?\? "0"/
  );
  assert.match(
    configure,
    /-DDOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS=\$\{fallbackMapDiagnostics\}/
  );
  assert.match(configure, /fallbackMapDiagnostics,/);
  assert.match(buildInfo, /fallbackMapDiagnostics: configure\.fallbackMapDiagnostics/);
});

sourceContractTest("diagnostic counters classify every fallback dispatch and reach JIT metrics", async () => {
  const [cacheSource, cachedInterpreter, patch] = await Promise.all([
    source("vendor/dolphin/Source/Core/Core/PowerPC/JitCommon/JitCache.cpp"),
    source("vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp"),
    source("patches/dolphin-wasm/snapshot/0048-jit-fallback-map-diagnostics.patch"),
  ]);

  for (const field of [
    "hit",
    "empty_miss",
    "collision_miss",
    "slow_found",
    "slow_missing",
  ]) {
    assert.match(cacheSource, new RegExp(`s_fallback_dispatch_${field}`));
    assert.match(patch, new RegExp(field));
  }

  assert.match(cachedInterpreter, /GetJitFallbackDispatchStats\(\)/);
  assert.match(cachedInterpreter, /last_refresh_fallback_dispatch_total/);
  assert.match(cachedInterpreter, /fbmap:off/);
  assert.match(
    cachedInterpreter,
    /fbmap:hit\/empty\/collision\/found\/missing:/
  );
});

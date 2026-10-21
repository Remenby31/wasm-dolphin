// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Under the MMU (a game's INI), our emitted code never runs (0091): its slow
// memory paths take a DSI and go on with 0. The block JIT refuses every block
// when jo.memcheck is set, which the MMU mode sets; the region translator
// refuses too (regions do not stop at a fault). Deferred fault delivery, which
// would let them run there, is not written yet.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const vendor = (path) => readFile(new URL(`../vendor/dolphin/Source/Core/${path}`, import.meta.url), "utf8");

// The body of a function, from its signature to the next top-level brace.
function body(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `${signature} is in the source`);
  const end = source.indexOf("\n}\n", at);
  return source.slice(at, end);
}

sourceContractTest("under the MMU no wasm code runs: the block JIT refuses on jo.memcheck, the region translator on IsMMUMode", async () => {
  const [ci, jitBase] = await Promise.all([vendor("Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp"), vendor("Core/PowerPC/JitCommon/JitBase.cpp")]);
  assert.match(jitBase, /jo\.memcheck\s*=\s*m_system\.IsMMUMode\(\)/, "the MMU mode sets jo.memcheck");
  const tryWrite = body(ci, "bool CachedInterpreter::TryWriteWasmBlock(");
  const reject = tryWrite.indexOf("if (jo.memcheck)");
  assert.ok(reject >= 0, "TryWriteWasmBlock refuses under jo.memcheck");
  assert.match(tryWrite.slice(reject, reject + 200), /return false;/);
  assert.ok(reject < tryWrite.indexOf("BuildWasmCachedInterpreterBlock("), "before any code is built");
  const region = body(ci, "bool BuildRegionFragment(");
  assert.match(region.slice(0, 900), /if \(system\.IsMMUMode\(\)\)\s*return false;/, "the region translator refuses first thing");
});

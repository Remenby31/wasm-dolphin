// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// No atomic operation per block (0096). In wasm with threads every atomic load
// is a sequentially consistent i32.atomic.load, whatever the C++ memory order,
// which the engine can neither drop nor hoist out of the run loop: P4 step 5
// put two per block on the default path (s_regions_enabled), a -1.8 % the
// bisection of #43 found on the Spark. The block loop of Run, ExecuteOneBlock
// and RegionWouldRun read no std::atomic, implicitly or not.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const sourceUrl = new URL("../vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp", import.meta.url);

// From a function's signature (at the start of a line) to its closing brace.
function functionBody(source, signature) {
  const at = source.search(new RegExp(`^${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  assert.ok(at >= 0, `${signature} is in the source`);
  return source.slice(at, source.indexOf("\n}\n", at));
}

// Code only: comments and string literals left out.
const code = (text) => text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');

sourceContractTest("no atomic per block: Run's block loop, ExecuteOneBlock and RegionWouldRun read no std::atomic", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const atomics = [...source.matchAll(/^\s*(?:static\s+|inline\s+)?std::atomic<[^>]+>\s+(\w+)/gm)].map((m) => m[1]);
  assert.ok(atomics.includes("s_regions_enabled"), "the file's std::atomic globals are found");

  const run = functionBody(source, "void CachedInterpreter::Run(");
  const loopStart = run.indexOf("    do\n    {");
  const loopEnd = run.indexOf("} while (m_ppc_state.downcount > 0", loopStart);
  assert.ok(loopStart >= 0 && loopEnd > loopStart, "Run's block loop is found");
  const hot = {
    "Run's block loop": run.slice(loopStart, loopEnd),
    ExecuteOneBlock: functionBody(source, "void CachedInterpreter::ExecuteOneBlock("),
    RegionWouldRun: functionBody(source, "inline bool RegionWouldRun(")
  };
  for (const [name, body] of Object.entries(hot)) {
    const c = code(body);
    assert.doesNotMatch(c, /\.(?:load|store|exchange|compare_exchange_\w+|fetch_\w+)\s*\(|std::atomic|Atomic/, `${name}: an explicit atomic operation`);
    for (const a of atomics) assert.doesNotMatch(c, new RegExp(`\\b${a}\\b`), `${name} reads the std::atomic ${a}`);
  }
});

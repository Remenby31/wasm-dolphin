// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const sourceUrl = new URL(
  "../vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp",
  import.meta.url
);

const HOT_COUNTER_NAME =
  /s_(?:wasm_redispatch|fast_float|fast_integer|fast_system|fast_word_mem|fast_byte|fast_half|fast_multiword|fast_branch)[a-zA-Z0-9_]*/;

sourceContractTest("release WASM builds compile high-volume cached-interpreter counters out", async () => {
  const [source, configure] = await Promise.all([
    readFile(sourceUrl, "utf8"),
    readFile(new URL("../tools/configure-upstream-wasm.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(configure, /-DDOLPHIN_WEB_HOT_COUNTERS=0/);
  assert.match(source, /#ifndef DOLPHIN_WEB_HOT_COUNTERS/);
  assert.match(source, /#if DOLPHIN_WEB_HOT_COUNTERS/);
  assert.match(source, /#define DOLPHIN_WEB_HOT_COUNT\(statement\)/);
  assert.match(source, /hotcounts:/);

  const hotWrites = source.split(/\r?\n/).filter((line) =>
    HOT_COUNTER_NAME.test(line) && /(?:\+\+|\+=)/.test(line)
  );
  assert.ok(hotWrites.length >= 40, `expected broad hot-counter coverage, got ${hotWrites.length}`);
  for (const line of hotWrites) {
    assert.match(
      line,
      /DOLPHIN_WEB_HOT_COUNT\(/,
      `hot counter write must compile out without a runtime branch: ${line.trim()}`
    );
  }
});

sourceContractTest("correctness and JIT engagement counters stay outside the hot-counter gate", async () => {
  const source = await readFile(sourceUrl, "utf8");
  for (const counter of [
    "s_wasm_block_run_count",
    "s_wasm_block_compile_count",
    "s_wasm_block_emit_fail_count",
    "s_wasm_block_compile_fail_count",
    "s_wasm_direct_tier_reject_count",
    "s_wasm_helper_halt_count",
  ]) {
    assert.match(source, new RegExp(`\\+\\+${counter}`));
    assert.doesNotMatch(
      source,
      new RegExp(`DOLPHIN_WEB_HOT_COUNT\\(\\+\\+${counter}`),
      `${counter} is required correctness/JIT evidence`
    );
  }
});

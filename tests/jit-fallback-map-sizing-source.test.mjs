// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = new URL("../", import.meta.url);
const allowedBits = [16, 18, 20];

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

function fallbackIndex(address, bits) {
  const elements = 2 ** bits;
  return Math.floor(address / 4) & (elements - 1);
}

test("fallback map sizes preserve the 16-bit default and reduce measured alias classes", () => {
  const base = 0x80000000;
  const alias16 = base + 4 * 2 ** 16;
  const alias18 = base + 4 * 2 ** 18;

  assert.equal(fallbackIndex(base, 16), fallbackIndex(alias16, 16));
  assert.notEqual(fallbackIndex(base, 18), fallbackIndex(alias16, 18));
  assert.equal(fallbackIndex(base, 18), fallbackIndex(alias18, 18));
  assert.notEqual(fallbackIndex(base, 20), fallbackIndex(alias18, 20));

  for (const bits of allowedBits) {
    const elements = 2 ** bits;
    for (const address of [0, 4, 0x80000000, 0xfffffffc]) {
      const index = fallbackIndex(address, bits);
      assert.ok(index >= 0);
      assert.ok(index < elements);
    }
  }
});

test("invalidating an aliased old block cannot clear the replacement slot", () => {
  const bits = 16;
  const first = { address: 0x80000000 };
  const replacement = { address: first.address + 4 * 2 ** bits };
  const slots = new Array(2 ** bits);
  const index = fallbackIndex(first.address, bits);

  slots[index] = first;
  slots[fallbackIndex(replacement.address, bits)] = replacement;
  if (slots[index] === first)
    slots[index] = undefined;
  assert.equal(slots[index], replacement);

  if (slots[index] === replacement)
    slots[index] = undefined;
  assert.equal(slots[index], undefined);
});

sourceContractTest("fallback map bits are compile-time constrained and recorded in provenance", async () => {
  const [header, implementation, configure, buildInfo, patch] = await Promise.all([
    source("vendor/dolphin/Source/Core/Core/PowerPC/JitCommon/JitCache.h"),
    source("vendor/dolphin/Source/Core/Core/PowerPC/JitCommon/JitCache.cpp"),
    source("tools/configure-upstream-wasm.mjs"),
    source("tools/core-build-info.mjs"),
    source("patches/dolphin-wasm/snapshot/0049-jit-fallback-map-sizing.patch"),
  ]);

  assert.match(
    header,
    /#ifndef DOLPHIN_WEB_FALLBACK_MAP_BITS\r?\n#define DOLPHIN_WEB_FALLBACK_MAP_BITS 16\r?\n#endif/
  );
  assert.match(
    header,
    /static_assert\(DOLPHIN_WEB_FALLBACK_MAP_BITS == 16 \|\|\r?\n\s+DOLPHIN_WEB_FALLBACK_MAP_BITS == 18 \|\|\r?\n\s+DOLPHIN_WEB_FALLBACK_MAP_BITS == 20,/
  );
  assert.match(
    header,
    /FAST_BLOCK_MAP_FALLBACK_ELEMENTS =\r?\n\s+size_t\{1\} << DOLPHIN_WEB_FALLBACK_MAP_BITS/
  );
  assert.match(
    implementation,
    /\(static_cast<size_t>\(address\) >> 2\) & FAST_BLOCK_MAP_FALLBACK_MASK/
  );

  const guardedInvalidations = implementation.match(
    /m_fast_block_map_fallback\[block(?:->|\.)fast_block_map_index\] == (?:block|&block)/g
  );
  assert.equal(guardedInvalidations?.length, 2);

  assert.match(configure, /process\.env\.DOLPHIN_WEB_FALLBACK_MAP_BITS \?\? "16"/);
  assert.match(configure, /\["16", "18", "20"\]\.includes\(fallbackMapBits\)/);
  assert.match(configure, /-DDOLPHIN_WEB_FALLBACK_MAP_BITS=\$\{fallbackMapBits\}/);
  assert.match(configure, /fallbackMapBits,/);
  assert.match(buildInfo, /fallbackMapBits: configure\.fallbackMapBits/);
  assert.match(patch, /DOLPHIN_WEB_FALLBACK_MAP_BITS/);
});

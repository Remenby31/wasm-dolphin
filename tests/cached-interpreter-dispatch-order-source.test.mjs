// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const sourceUrl = new URL(
  "../vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp",
  import.meta.url
);

const CANDIDATE_ORDER = [
  "FastInteger",
  "FastBranch",
  "FastFloat",
  "FastBranchBdnz",
  "Interpret<true>",
  "FastMfmsr",
  "FastMtmsr",
  "FastMfspr",
  "FastMtspr",
  "FastSystemNoop",
];

const LEGACY_ORDER = [
  "Interpret<true>",
  "FastMfmsr",
  "FastMtmsr",
  "FastMfspr",
  "FastMtspr",
  "FastSystemNoop",
  "FastInteger",
  "FastBranch",
  "FastBranchBdnz",
  "FastFloat",
];

function markedBlock(source, marker) {
  const match = new RegExp(
    `// ${marker}_BEGIN\\n([\\s\\S]*?)// ${marker}_END`
  ).exec(source);
  assert.ok(match, `missing ${marker} source block`);
  // The direct WASM arm is default-off and has separate gate/semantics
  // coverage in jit-direct-wasm-block-dispatch-source.test.mjs.
  return match[1].replace(
    /#if DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH\n[\s\S]*?#endif\n/g,
    ""
  );
}

function callbackBranches(source) {
  const pattern = /else if \(callback == AnyCallbackCast\(([^\n]+)\)\)\n\s*\{/g;
  const branches = new Map();
  for (const match of source.matchAll(pattern)) {
    let cursor = match.index + match[0].length;
    let depth = 1;
    while (depth > 0 && cursor < source.length) {
      if (source[cursor] === "{") depth += 1;
      if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    assert.equal(depth, 0, `unterminated callback branch ${match[1]}`);
    branches.set(match[1], source.slice(match.index + match[0].length, cursor - 1).trim());
  }
  return branches;
}

sourceContractTest("release WASM selects the measured callback identity order", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replaceAll("\r\n", "\n");

  assert.match(
    source,
    /#ifndef DOLPHIN_WEB_HOT_DISPATCH_ORDER\n#define DOLPHIN_WEB_HOT_DISPATCH_ORDER 1\n#endif/
  );
  assert.match(source, /#if DOLPHIN_WEB_HOT_DISPATCH_ORDER/);

  const candidate = markedBlock(source, "DOLPHIN_WEB_HOT_DISPATCH_ORDER");
  assert.deepEqual([...callbackBranches(candidate).keys()], CANDIDATE_ORDER);
});

sourceContractTest("candidate and rollback orders preserve identical callback bodies", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replaceAll("\r\n", "\n");
  const candidate = callbackBranches(markedBlock(source, "DOLPHIN_WEB_HOT_DISPATCH_ORDER"));
  const legacy = callbackBranches(markedBlock(source, "DOLPHIN_WEB_LEGACY_DISPATCH_ORDER"));

  assert.deepEqual([...legacy.keys()], LEGACY_ORDER);
  assert.deepEqual([...candidate.keys()].sort(), [...legacy.keys()].sort());
  for (const name of candidate.keys()) {
    assert.equal(candidate.get(name), legacy.get(name), `${name} body changed between orders`);
  }
});

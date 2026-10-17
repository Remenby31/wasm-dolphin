// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const sourceUrl = new URL(
  "../vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp",
  import.meta.url,
);

sourceContractTest("release WASM requests direct FastBranch inlining with a compile-time rollback", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replaceAll("\r\n", "\n");

  assert.match(
    source,
    /#ifdef __EMSCRIPTEN__\n#ifndef DOLPHIN_WEB_INLINE_FAST_BRANCH\n#define DOLPHIN_WEB_INLINE_FAST_BRANCH 1\n#endif/,
  );
  assert.match(
    source,
    /#if DOLPHIN_WEB_INLINE_FAST_BRANCH\n#define DOLPHIN_WEB_FAST_BRANCH_INLINE __attribute__\(\(always_inline\)\)\n#else\n#define DOLPHIN_WEB_FAST_BRANCH_INLINE\n#endif/,
  );
  assert.equal(source.match(/^#define DOLPHIN_WEB_FAST_BRANCH_INLINE$/gm)?.length, 2);
  assert.match(
    source,
    /DOLPHIN_WEB_FAST_BRANCH_INLINE s32 CachedInterpreter::FastBranch\(\s*PowerPC::PowerPCState& ppc_state,\s*const FastInstructionOperands& operands\)/,
  );
  assert.doesNotMatch(
    source,
    /DOLPHIN_WEB_FAST_BRANCH_INLINE s32 CachedInterpreter::FastBranchBdnz\(/,
  );
});

sourceContractTest("FastBranch keeps one address-taken callback and its existing record payload", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replaceAll("\r\n", "\n");

  assert.match(source, /callback == AnyCallbackCast\(FastBranch\)/);
  assert.match(
    source,
    /FastBranch\(ppc_state, \*reinterpret_cast<const FastInstructionOperands\*>\(payload\)\)/,
  );
  assert.match(
    source,
    /Write\(FastBranch, \{power_pc, op\.address, op\.inst\}\)/,
  );
  assert.match(
    source,
    /return sizeof\(AnyCallback\) \+ sizeof\(operands\);\n}\n\ns32 CachedInterpreter::FastBranchBdnz/,
  );
});

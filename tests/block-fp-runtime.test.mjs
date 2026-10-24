// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0159: a block is compiled for the MSR of its first run, but runs later
// under any MSR. The OS switches FPU contexts lazily: it clears MSR.FP and
// waits for the FP-unavailable exception. So a block the CPU thread compiled
// with the FPU on must still raise that exception when it runs with the FPU
// off, as the interpreter does (vector 0x800). The oracle compiles every
// block as if MSR.FP were set (DolphinWeb_JitOracleCompileWithFpForTest) and
// runs it with MSR.FP clear. This covers every instruction class of the
// catalog that uses the FPU, first in the block and after an integer op.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { CATALOG, PRODUCTION_DISABLE_MASK, describeDifference, generate, hex, loadOracleCore, makeRng, randomState } from "./helpers/jit-oracle.mjs";

const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const builtUrl = new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url);
const built = existsSync(builtUrl) ? JSON.parse(readFileSync(builtUrl, "utf8")) : null;
const coreHas0159 = built?.source?.patchSeriesSha256 === lock.patchSeriesSha256 &&
  lock.patches.some((p) => p.path.includes("/0159-"));
const core = coreHas0159 ? await loadOracleCore() : null;
const skip = !coreHas0159 ? "core built from a patch series without 0159 (CI builds this branch's core)" :
  !core?.has("DolphinWeb_JitOracleCompileWithFpForTest") ? "core without the compile-with-FP export" : false;

const BLR = 0x4e800020;
const ADDI_R31 = 0x3bff0001; // addi r31, r31, 1
const FLOAT_X = new Set([535, 567, 599, 631, 663, 695, 727, 759, 983]); // lfsx … stfiwx
const usesFpu = (w) => {
  const op = w >>> 26;
  return (op >= 48 && op <= 61) || op === 4 || op === 59 || op === 63 || (op === 31 && FLOAT_X.has((w >>> 1) & 1023));
};

test("a block compiled with MSR.FP set raises FP unavailable when it runs with MSR.FP clear, like the interpreter", { skip }, () => {
  const fpClasses = new Set();
  let compared = 0, compiled = 0, control = 0;
  const codes = new Map(), ops = new Map();
  const set = (on) => core.compileWithFp(on);
  try {
    set(true);
    const r = makeRng(0x159);
    for (const [name] of CATALOG) {
      for (let k = 0; k < 24; k++) {
        const w = generate(name, r);
        if (!usesFpu(w)) break;
        fpClasses.add(name);
        for (const program of [[w, ADDI_R31, BLR], [ADDI_R31, w, BLR]]) {
          const state = randomState(r);
          state[37] = 0x00000032; // MSR: IR, DR, RI; FP clear
          const res = core.run(Uint32Array.from(program), state, PRODUCTION_DISABLE_MASK);
          assert.ok(res.code === 0 || res.code === 2, `${name} ${program.map(hex).join(" ")}: ${res.code === 1 ? describeDifference(res.interp, res.jit).slice(0, 6).join("; ") : res.message}`);
          assert.equal(res.interp[47] >>> 0, 0x800, `${name}: the interpreter raised FP unavailable`);
          compared++;
          codes.set(res.code, (codes.get(res.code) ?? 0) + 1);
          ops.set(`${res.compiledBlocks}/${res.compiledOps}`, (ops.get(`${res.compiledBlocks}/${res.compiledOps}`) ?? 0) + 1);
          if (res.compiledOps >= 2) compiled++;
          // Control: the same program with the FPU on compiles the FP op.
          state[37] = 0x00002032;
          set(false);
          if (core.run(Uint32Array.from(program), state, PRODUCTION_DISABLE_MASK).compiledOps >= 2) control++;
          set(true);
        }
      }
    }
  } finally {
    set(false);
  }
  assert.ok(fpClasses.size >= 40, `${fpClasses.size} FP instruction classes`);
  assert.ok(compiled >= compared / 2, `${compiled} of ${compared} programs ran a compiled block holding the FP op (FPU on: ${control}); codes ${JSON.stringify([...codes])} blocks/ops ${JSON.stringify([...ops].slice(0, 8))}`);
});

// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The wasm features the JIT relies on are probed at load: without tail calls
// regions stay off (instead of every region module failing to compile), and
// aotStatus says why; the optimizer counts the modules the engine refuses
// (regionsRefused), so a silent loss shows up. With fused mode off, no
// emitted region holds a relaxed SIMD opcode, which an engine without relaxed
// SIMD (Safari) would refuse.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { probeRelaxedMadd } from "../src/relaxed-madd-probe.js";
import { PROBE_MODULES_FOR_TEST, probeWasmFeatures } from "../src/wasm-feature-probe.js";
import { loadAotCore, runOracleProgramsAsRegions } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK } from "./helpers/jit-oracle.mjs";
import { relaxedOpcodeSites } from "./helpers/relaxed-opcodes.mjs";

test("the feature probe: this engine has SIMD and tail calls; a missing feature or a throwing validate reads as absent", () => {
  assert.deepEqual(probeWasmFeatures(), { simd: true, tailCall: true });
  for (const bytes of Object.values(PROBE_MODULES_FOR_TEST)) assert.ok(new WebAssembly.Module(bytes), "each probe module compiles here");
  const engine = (missing) => ({ validate: (b) => b !== PROBE_MODULES_FOR_TEST[missing] });
  assert.deepEqual(probeWasmFeatures(engine("tailCall")), { simd: true, tailCall: false });
  assert.deepEqual(probeWasmFeatures(engine("simd")), { simd: false, tailCall: true });
  assert.deepEqual(probeWasmFeatures({ validate: () => { throw new Error("no"); } }), { simd: false, tailCall: false });
});

test("without tail calls ?aot=1 is turned off before anything compiles, with a status line and aotStatus.regionsOff", async () => {
  const source = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const probe = source.indexOf("wasmFeatures = probeWasmFeatures();");
  const enabled = source.indexOf("aotFirstLaunchEnabled = aotFirstLaunch === true;");
  assert.ok(probe > 0 && enabled > probe, "probed before aot is read");
  assert.match(source.slice(probe, enabled), /if \(aotFirstLaunch === true && !wasmFeatures\.tailCall\) \{\n\s+aotFirstLaunch = false;/);
  assert.match(source, /postStatus\(`aot: regions off: \$\{aotRegionsOffReason\}`\);/);
  assert.match(source, /wasmFeatures: \{ \.\.\.wasmFeatures, relaxedMadd \}, \.\.\.\(aotRegionsOffReason \? \{ regionsOff: aotRegionsOffReason \} : \{\}\)/);
});

test("the optimizer counts the modules the engine refuses to compile or link (status().regionsRefused)", async () => {
  const source = await readFile(new URL("../src/aot-optimizer.js", import.meta.url), "utf8");
  assert.match(source, /failure = `engine-reject: \$\{reason\}`;\n\s+this\.engineRejects\+\+;/);
  assert.match(source, /return \{ state, fraction: p\.fraction, regionsRefused: this\.engineRejects \};/);
  assert.match(source, /this\.engineRejects = 0;/);
});

const core = existsSync(new URL("../cores/dolphin/dolphin-core-upstream.wasm", import.meta.url)) ? await loadAotCore() : null;
const regionSkip = !core?.has("DolphinWeb_AotTestLoadState") ? "core without the region test exports" :
  !core.has("DolphinWeb_SetFusedMadd") ? "core before patch 0129" : false;

test("with fused mode off no region holds a relaxed SIMD opcode; with it on, they do (the scan's positive control)", { skip: regionSkip }, () => {
  const fma = ["fmadd", "fmadds", "fnmsubs", "ps_madd", "ps_msub", "ps_nmadd", "ps_madds0", "ps_add", "ps_mul", "fadds"];
  const previous = core.module._DolphinWeb_SetFusedMadd(0);
  const count = (fused) => {
    core.module._DolphinWeb_SetFusedMadd(fused ? 1 : 0);
    let sites = 0, fragments = 0;
    const realTranslate = core.translate.bind(core);
    core.translate = (...args) => {
      const fragment = realTranslate(...args);
      if (fragment) { fragments += 1; sites += relaxedOpcodeSites(fragment.code).length; }
      return fragment;
    };
    try {
      const tally = runOracleProgramsAsRegions(core, { seed: fused ? 0x5a : 0x5b, count: 300, length: 16, mask: PRODUCTION_DISABLE_MASK, names: fma });
      assert.deepEqual(tally.mismatches.slice(0, 2), [], "regions still agree with the interpreter");
    } finally {
      core.translate = realTranslate;
    }
    return { sites, fragments };
  };
  try {
    const plain = count(false);
    assert.ok(plain.fragments >= 100, `${plain.fragments} fragments`);
    assert.equal(plain.sites, 0, "no relaxed opcode with fused mode off");
    // Fused-mode regions run exactly only where this engine fuses relaxed_madd.
    if (probeRelaxedMadd() === "fused") {
      const fused = count(true);
      assert.ok(fused.sites > 0, "the scan finds relaxed_madd when fused mode is on");
    }
  } finally {
    core.module._DolphinWeb_SetFusedMadd(previous);
  }
});

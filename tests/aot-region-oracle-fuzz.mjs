// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Region-mode oracle fuzz (P4): the oracle's random programs, each translated
// as one fragment, assembled as a region and run by the core against its
// interpreter, with a full and a small cycle budget per program.
//
//   node tests/aot-region-oracle-fuzz.mjs --programs 20000 --length 48 [--seed S] [--mask hex]
//
// Exit 0 when nothing diverged.
import { loadAotCore, runOracleProgramsAsRegions } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK } from "./helpers/jit-oracle.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const programs = Number(opt("programs", "2000"));
const length = Number(opt("length", "24"));
const seed = Number(opt("seed", "1"));
const mask = Number(opt("mask", String(PRODUCTION_DISABLE_MASK))) >>> 0;
const core = await loadAotCore();
if (!core?.has("DolphinWeb_AotTestLoadState")) {
  console.error("this core has no region test exports (patch 0075)");
  process.exit(2);
}
const t0 = performance.now();
const tally = runOracleProgramsAsRegions(core, { seed, count: programs, length, mask });
console.log(JSON.stringify({ ...tally, mismatches: tally.mismatches.slice(0, 3), mismatchCount: tally.mismatches.length, seconds: Math.round((performance.now() - t0) / 1000) }));
process.exit(tally.mismatches.length ? 1 : 0);

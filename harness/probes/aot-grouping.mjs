#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// How well region grouping keeps calls inside a region (plan piste 3, P4).
// Plans a disc image (read in place, read-only), groups each module's
// functions with groupRegions, and reports the share of static call edges
// (call and tail) whose caller and callee land in the same region. No game
// name is printed.
//
// node harness/probes/aot-grouping.mjs --iso disc.iso [--max 100] [--profile p.bin]
import { openSync, readSync, closeSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { planDisc } from "../../src/aot-recomp.js";
import { orderedRegions } from "../../src/aot-plan.js";
import { decodeProfile } from "../../src/aot-profile.js";
import { groupRegions } from "../../src/aot-region-module.js";

const { values } = parseArgs({ options: { iso: { type: "string" }, max: { type: "string", default: "100" }, profile: { type: "string" } } });
const fd = openSync(values.iso, "r");
const read = (offset, length) => {
  const out = new Uint8Array(length);
  readSync(fd, out, 0, length, offset);
  return out;
};
try {
  const profile = values.profile ? decodeProfile(readFileSync(values.profile)) : null;
  const plan = await planDisc(read, { profile });
  const ordered = orderedRegions(plan);
  const modules = [...plan.modules, ...plan.rels.filter((r) => r.functions)];
  let edges = 0, inside = 0, regions = 0, functions = 0, weighted = 0, weightedInside = 0;
  for (const m of modules) {
    const order = ordered.filter((r) => r.module === m.id).map((r) => m.functions.indexOf(r.f)).filter((i) => i >= 0);
    const groups = groupRegions(m, order, { maxFunctions: Number(values.max) });
    const regionOf = new Int32Array(m.functions.length).fill(-1);
    groups.forEach((g, r) => g.forEach((f) => (regionOf[f] = r)));
    regions += groups.length;
    functions += m.functions.length;
    const { from, to, kind } = m.edges;
    for (let i = 0; i < from.length; i++) {
      if (kind[i] !== 3 && kind[i] !== 4) continue;
      const a = m.blocks.func[from[i]], b = m.blocks.func[to[i]];
      if (a < 0 || b < 0 || a === b) continue;
      edges += 1;
      const same = regionOf[a] >= 0 && regionOf[a] === regionOf[b];
      if (same) inside += 1;
      // weight by the caller's profile hits (hot call sites count more)
      const w = m.functions[a].profileHits ?? 0;
      weighted += w;
      if (same) weightedInside += w;
    }
  }
  console.log(JSON.stringify({
    maxFunctions: Number(values.max),
    modules: modules.length,
    functions,
    regions,
    callEdges: edges,
    intraRegionShare: edges ? +(inside / edges).toFixed(4) : null,
    profileWeightedShare: weighted ? +(weightedInside / weighted).toFixed(4) : null
  }));
} finally {
  closeSync(fd);
}

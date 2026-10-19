#!/usr/bin/env node
// Build the ahead-of-time compilation plan of a disc image from the command
// line (the browser runs the same code on the user's File). The disc is read
// in place; the plan is written outside the repository unless the disc is a
// homebrew built from harness/homebrew.
//
//   node tools/aot-plan.mjs --disc path.iso --out dir [--profile p.bin] [--hints h.json]
//     [--compare-symbols symbols.txt]
//
// --compare-symbols takes a decomp-toolkit symbols.txt of the same DOL and
// reports how many of its functions and jump tables discovery found.
import { mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseHints } from "../src/aot-hints.js";
import { encodePlanRegions, validatePlan } from "../src/aot-plan.js";
import { decodeProfile } from "../src/aot-profile.js";
import { planDisc } from "../src/aot-recomp.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    disc: { type: "string" },
    out: { type: "string" },
    profile: { type: "string" },
    hints: { type: "string" },
    "compare-symbols": { type: "string" }
  }
});
if (!values.disc || !values.out) throw new Error("usage: aot-plan.mjs --disc path.iso --out dir [--profile p.bin] [--hints h.json] [--compare-symbols symbols.txt]");
const disc = path.resolve(values.disc);
const out = path.resolve(values.out);
const homebrew = disc.startsWith(path.join(REPO_ROOT, "harness", "homebrew"));
if (!homebrew && (out + path.sep).startsWith(REPO_ROOT + path.sep)) {
  throw new Error("the plan of a non-homebrew disc stays outside the repository");
}

const fd = openSync(disc, "r");
const read = (offset, length) => {
  const b = new Uint8Array(length);
  const n = readSync(fd, b, 0, length, offset);
  return b.subarray(0, n);
};
const profile = values.profile ? decodeProfile(readFileSync(values.profile)) : null;
const hints = values.hints ? parseHints(readFileSync(values.hints, "utf8")) : null;

const t0 = performance.now();
const plan = validatePlan(await planDisc(read, { profile, hints }));
const ms = Math.round(performance.now() - t0);

const summary = {
  gameId: plan.disc.gameId,
  ms,
  modules: plan.modules.map((m) => ({ kind: m.kind, ...m.stats, jumpTables: m.jumpTables.length, indirectSites: m.indirectSites.length,
    byConfidence: m.functions.reduce((acc, f) => { acc[f.confidence] = (acc[f.confidence] ?? 0) + 1; return acc; }, {}) })),
  rels: plan.rels.map((r) => ({ name: r.name, functions: r.functions?.length ?? 0, error: r.error ?? null })),
  dynamic: plan.dynamic.length
};

if (values["compare-symbols"]) {
  const dol = plan.modules[0];
  const entries = new Set(dol.functions.map((f) => f.entry));
  const starts = new Set(dol.blocks.start);
  const tables = new Map(dol.jumpTables.map((t) => [t.table, t.count]));
  let fn = 0, exact = 0, blockOnly = 0, jt = 0, jtFound = 0, jtExact = 0;
  for (const line of readFileSync(values["compare-symbols"], "utf8").split("\n")) {
    const f = /:0x([0-9A-Fa-f]+); \/\/ type:function size:0x([0-9A-Fa-f]+)/.exec(line);
    if (f) {
      const a = parseInt(f[1], 16);
      fn++;
      if (entries.has(a)) exact++; else if (starts.has(a)) blockOnly++;
    }
    const t = /^jumptable_\w+ = \.\w+:0x([0-9A-Fa-f]+); \/\/ type:object size:0x([0-9A-Fa-f]+)/.exec(line);
    if (t) {
      jt++;
      const a = parseInt(t[1], 16);
      if (tables.has(a)) { jtFound++; if (tables.get(a) * 4 === parseInt(t[2], 16)) jtExact++; }
    }
  }
  summary.compare = { functions: fn, exactEntries: exact, blockStartOnly: blockOnly, missing: fn - exact - blockOnly, jumpTables: jt, jumpTablesFound: jtFound, jumpTablesExactCount: jtExact };
}

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "plan.json"), JSON.stringify(plan));
writeFileSync(path.join(out, "plan-regions.bin"), encodePlanRegions(plan));
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(JSON.stringify(summary, null, 1));

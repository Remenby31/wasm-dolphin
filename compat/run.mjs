#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Hardware-value CPU tests (ported dolphin-emu/hwtests, compat/hwtests) on
// the committed core, in Node: each check runs on the interpreter and on the
// WASM JIT (the JIT oracle, patch 0071) and is compared with the value the
// Dolphin project measured on a console. No game, no disc, no browser.
//
//   node compat/run.mjs [--core-dir DIR] [--json FILE] [--md FILE] [--only SUITE,...]
//
// Exit 1 when a check fails without being listed in compat/expected-failures.json,
// or when a listed failure now passes (remove it from the list). Exit 2 when
// the core cannot run the oracle.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { PRODUCTION_DISABLE_MASK, loadOracleCore } from "../tests/helpers/jit-oracle.mjs";

export const SUITES = ["mtspr", "cr", "rlw", "srawix", "frsp", "fctiwz", "fctiw", "ni", "fprf", "fprf-default"];

const TIERS = ["interp", "jit"];
// The production mask, but with blocks of 2 ops allowed (bit 21 clear): a
// ported check is one instruction and a blr, which production would leave to
// the interpreter (minimum prefix of 4).
const MASK = PRODUCTION_DISABLE_MASK & ~(1 << 21);

/** Runs every case of the given suites; returns one record per check. */
export async function runSuites(core, suites = SUITES) {
  const records = [];
  for (const name of suites) {
    const mod = await import(new URL(`./hwtests/cputest/${name}.mjs`, import.meta.url));
    for (const c of mod.cases()) {
      if (c.config?.fprf !== undefined) core.setFprf(c.config.fprf);
      const r = core.run(Uint32Array.from(c.program), c.state, MASK);
      if (c.config?.fprf !== undefined) core.setFprf(false);
      const rec = { suite: name, source: mod.source, id: c.id, code: r.code, compiledOps: r.compiledOps };
      if (r.code < 0 || r.code > 2) {
        for (const t of TIERS) rec[t] = { status: "error", detail: r.message || `oracle code ${r.code}` };
      } else {
        for (const t of TIERS) {
          if (t === "jit" && r.code === 2) { rec[t] = { status: "n/c" }; continue; }
          const { got, expected } = c.check(r[t]);
          rec[t] = { status: got === expected ? "pass" : "fail", got, expected };
        }
      }
      records.push(rec);
    }
  }
  return records;
}

/** Applies the expected-failure list: marks each failure known or not. */
export function judge(records, expectedFailures) {
  const known = new Map(expectedFailures.map((e) => [e.id, e]));
  const problems = [];
  for (const rec of records) {
    const entry = known.get(rec.id);
    for (const t of TIERS) {
      const res = rec[t];
      const listed = entry?.tiers.includes(t) ?? false;
      res.expectedFailure = listed;
      if ((res.status === "fail" || res.status === "error") && !listed)
        problems.push(`unexpected ${res.status} [${t}] ${rec.id}: got ${res.got ?? res.detail}, hardware ${res.expected ?? "?"}`);
      if (res.status === "pass" && listed)
        problems.push(`now passes [${t}] ${rec.id}: remove it from compat/expected-failures.json`);
    }
  }
  return problems;
}

export function markdown(records, problems, meta) {
  const lines = [];
  lines.push(`### Hardware tests (CPU), ${meta.core}`);
  lines.push("");
  lines.push("| suite | checks | interpreter | JIT | JIT compiled | known failures |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  const bySuite = new Map();
  for (const r of records) (bySuite.get(r.suite) ?? bySuite.set(r.suite, []).get(r.suite)).push(r);
  const pct = (n, d) => (d ? `${n}/${d}` : "–");
  const total = { n: 0, i: 0, j: 0, jc: 0, k: 0 };
  for (const [suite, rs] of bySuite) {
    const i = rs.filter((r) => r.interp.status === "pass").length;
    const jc = rs.filter((r) => r.jit.status !== "n/c").length;
    const j = rs.filter((r) => r.jit.status === "pass").length;
    const k = rs.filter((r) => TIERS.some((t) => r[t].expectedFailure)).length;
    total.n += rs.length; total.i += i; total.j += j; total.jc += jc; total.k += k;
    lines.push(`| ${suite} | ${rs.length} | ${pct(i, rs.length)} | ${pct(j, jc)} | ${jc} | ${k} |`);
  }
  lines.push(`| **all** | **${total.n}** | **${pct(total.i, total.n)}** | **${pct(total.j, total.jc)}** | ${total.jc} | ${total.k} |`);
  lines.push("");
  lines.push(problems.length ? `**${problems.length} problem(s):**` : "No unexpected result.");
  for (const p of problems.slice(0, 50)) lines.push(`- ${p}`);
  const failures = records.filter((r) => TIERS.some((t) => r[t].status === "fail" || r[t].status === "error"));
  if (failures.length) {
    lines.push("");
    lines.push(`<details><summary>${failures.length} failing check(s)</summary>`);
    lines.push("");
    lines.push("| check | interpreter | JIT | hardware | known |");
    lines.push("|---|---|---|---|---|");
    for (const r of failures.slice(0, 200)) {
      const v = (t) => (r[t].status === "pass" ? "pass" : r[t].status === "n/c" ? "n/c" : `\`${r[t].got ?? r[t].detail}\``);
      const known = TIERS.filter((t) => r[t].expectedFailure).join("+") || "no";
      lines.push(`| \`${r.id}\` | ${v("interp")} | ${v("jit")} | \`${r.interp.expected ?? r.jit.expected ?? "?"}\` | ${known} |`);
    }
    lines.push("");
    lines.push("</details>");
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({
    options: {
      "core-dir": { type: "string" },
      json: { type: "string" },
      md: { type: "string" },
      only: { type: "string" }
    }
  });
  const coreDir = values["core-dir"]
    ? pathToFileURL(values["core-dir"].replace(/\/?$/, "/"))
    : new URL("../cores/dolphin/", import.meta.url);
  const core = await loadOracleCore(coreDir);
  if (!core) {
    console.error("compat: this core has no JIT oracle (DolphinWeb_JitOracleRun)");
    process.exit(2);
  }
  core.setFprf(false);
  const suites = values.only ? values.only.split(",") : SUITES;
  const t0 = Date.now();
  const records = await runSuites(core, suites);
  const expected = JSON.parse(readFileSync(new URL("./expected-failures.json", import.meta.url), "utf8"));
  const problems = judge(records, expected.failures);
  let coreId = "core";
  try {
    const lock = JSON.parse(readFileSync(new URL("core.lock.json", coreDir), "utf8"));
    coreId = `core ${String(lock.sha256 ?? "").slice(0, 12) || "?"}`;
  } catch {}
  const md = markdown(records, problems, { core: coreId });
  process.stdout.write(md);
  console.error(`compat: ${records.length} checks in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (values.json) writeFileSync(values.json, JSON.stringify({ core: coreId, records, problems }, null, 1));
  if (values.md) writeFileSync(values.md, md);
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

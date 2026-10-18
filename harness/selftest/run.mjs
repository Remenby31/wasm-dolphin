#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Mutation test of the gate: the acceptance criterion of the harness.
//
// (a) Each mutant is a known regression applied to the candidate side only
//     (an in-memory patch of the served app, or a mutant homebrew disc). The
//     gate must block every one of them.
// (b) Clean runs compare this tree with itself. The gate must never block.
//
//   node harness/selftest/run.mjs [--only id,id] [--clean N] [--port 8082]
//
// Writes harness/results/selftest-…/selftest.json and selftest.md.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { abCompare } from "../cli.mjs";
import { REPO_ROOT } from "../lib/browser.mjs";
import { claim } from "../lib/ownership.mjs";

const HB = "harness/homebrew/out";
const WORKER = "src/upstream-discio-worker.js";

// Small specs: each mutant only needs the cells that can see it.
const scene = (extra = {}) => ({
  runs: 1, warmupSec: 6, sampleSec: 12, maxLoad: 1000, reference: "sw-interp", renderFrame: 300,
  games: [{ id: "gxscene", iso: `${HB}/gxscene.iso`, static: true }],
  configs: [{ id: "sw-interp", preset: "sw-interp" }, { id: "sw-jit", preset: "sw-fast-jit" }],
  ...extra
});
const tone = { id: "tonetest", iso: `${HB}/tonetest.iso`, static: true, audio: true };

export const MUTANTS = [
  {
    id: "geometry", what: "3D objects missing from the picture (interpreter and JIT alike)",
    spec: scene(), candidate: { discs: { [`${HB}/gxscene.iso`]: `${HB}/gxscene-nocubes.iso` } }
  },
  {
    id: "color", what: "one tile colour off by 3/255 in blue",
    spec: scene(), candidate: { discs: { [`${HB}/gxscene.iso`]: `${HB}/gxscene-color.iso` } }
  },
  {
    id: "jit-crash", what: "the JIT emits an invalid module (cpufuzz block with mcrf)",
    spec: scene({ configs: [{ id: "sw-interp", preset: "sw-interp" }], fuzz: [`${HB}/cpufuzz-nomcrf.iso`] }),
    candidate: { discs: { [`${HB}/cpufuzz-nomcrf.iso`]: `${HB}/cpufuzz.iso` } }
  },
  {
    // Ports 2-4 do not work on main yet (phase 1), so "port 2 cut" cannot be
    // a regression today; the working port is cut instead.
    id: "port", what: "gamepads no longer reach port 1 (ports 2-4 are already dead on main)",
    spec: scene({ configs: [{ id: "sw-interp", preset: "sw-interp" }], pads: true }),
    candidate: { patches: [{ file: "src/app.js", find: "const firstPad = selectPreferredGamepad(pads);", replace: "const firstPad = null;" }] }
  },
  {
    id: "core-freeze", what: "the core stops for 3 s in the measured window",
    spec: scene({ configs: [{ id: "sw-interp", preset: "sw-interp" }] }),
    candidate: { patches: [{ file: WORKER, append: "\n;setTimeout(() => { api?.setCorePaused?.(1); setTimeout(() => api?.setCorePaused?.(0), 3000); }, 16000);\n" }] }
  },
  {
    id: "worker-error", what: "the worker sends a message nobody handles (swallowed)",
    spec: scene({ configs: [{ id: "sw-interp", preset: "sw-interp" }] }),
    candidate: { patches: [{ file: WORKER, append: "\n;setTimeout(() => self.postMessage({ type: \"selftestUnknown\" }), 12000);\n" }] }
  },
  {
    id: "audio-cut", what: "the output gain is zero",
    spec: scene({ games: [tone], configs: [{ id: "sw-interp", preset: "sw-interp" }], reference: "sw-interp" }),
    // update() re-applies the volume after unmuting, so mute it there too.
    candidate: { patches: [
      { file: "src/audio.js", find: "this.gain.gain.value = this.muted ? 0 : this.volume;", replace: "this.gain.gain.value = 0;" },
      { file: "src/audio.js", find: "this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, now, 0.01);", replace: "this.gain.gain.setTargetAtTime(0, now, 0.01);" }
    ] }
  },
  {
    id: "perf-30", what: "emulation runs at 70 % speed",
    spec: scene({ runs: 2, configs: [{ id: "sw-interp", preset: "sw-interp" }] }),
    candidate: { patches: [{ file: WORKER, find: "api.setEmulationSpeed?.(Number(emulationSpeed));", replace: "api.setEmulationSpeed?.(Number(emulationSpeed) * 0.7);" }] }
  }
];

// The clean comparison covers every check the mutants use.
export const CLEAN_SPEC = scene({ games: [scene().games[0], tone], pads: true, fuzz: [`${HB}/cpufuzz-nomcrf.iso`], runs: 2 });

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function main() {
  const { values } = parseArgs({
    options: { only: { type: "string" }, clean: { type: "string", default: "5" }, port: { type: "string", default: process.env.HARNESS_PORT || "8082" }, headless: { type: "boolean", default: false } }
  });
  const dir = path.join(REPO_ROOT, "harness", "results", `selftest-${stamp()}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  claim(dir, REPO_ROOT, "results");
  const only = values.only ? new Set(values.only.split(",")) : null;
  const base = { root: REPO_ROOT };
  const rows = [];
  const runOne = async (id, kind, spec, candidate) => {
    const sub = path.join(dir, id);
    mkdirSync(sub);
    const opts = { port: values.port, headless: values.headless, confirm: "2" };
    let gate, error = null;
    try {
      gate = await abCompare({ spec, specDir: REPO_ROOT, values: opts, dir: sub, baseline: base, candidate: { root: REPO_ROOT, ...candidate } });
    } catch (e) {
      error = e.message;
    }
    const blocked = gate ? !gate.decision.ok : null;
    const expected = kind === "mutant";
    const row = {
      id, kind,
      blocked,
      reason: gate?.decision.reason ?? null,
      by: gate ? [...gate.correctness.blocking.map((r) => `${r.check} ${r.status}`), ...gate.perf.filter((r) => r.regressed).map((r) => `perf ${r.metric} ${Math.round(r.median * 100)} %`)] : [],
      ok: error ? false : blocked === expected,
      error
    };
    rows.push(row);
    console.log(`[selftest] ${id}: ${error ? `ERROR ${error}` : blocked ? `blocked (${row.by.join("; ")})` : "passed"} → ${row.ok ? "OK" : "WRONG"}`);
  };
  for (const m of MUTANTS) if (!only || only.has(m.id)) await runOne(m.id, "mutant", m.spec, m.candidate);
  for (let i = 1; i <= Number(values.clean); i += 1) if (!only || only.has("clean")) await runOne(`clean-${i}`, "clean", CLEAN_SPEC, {});
  const md = [
    "| Case | Kind | What | Gate | Blocked by | Expected |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.kind} | ${MUTANTS.find((m) => m.id === r.id)?.what ?? "this tree vs itself"} | ${r.error ? `error: ${r.error}` : r.blocked ? "BLOCK" : "PASS"} | ${r.by.join("<br>") || "–"} | ${r.ok ? "yes" : "**NO**"} |`),
    "",
    `${rows.filter((r) => r.kind === "mutant" && r.ok).length}/${rows.filter((r) => r.kind === "mutant").length} mutants blocked, ${rows.filter((r) => r.kind === "clean" && r.ok).length}/${rows.filter((r) => r.kind === "clean").length} clean runs passed.`
  ].join("\n");
  writeFileSync(path.join(dir, "selftest.json"), JSON.stringify(rows, null, 2));
  writeFileSync(path.join(dir, "selftest.md"), md + "\n");
  console.log("\n" + md);
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

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
import { pathToFileURL } from "node:url";
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
    // All four ports work on main: pads no longer reach port 2.
    id: "port", what: "gamepads no longer reach port 2",
    spec: scene({ configs: [{ id: "sw-interp", preset: "sw-interp" }], pads: true }),
    candidate: { patches: [{ file: "src/app.js", find: "    const nextPorts = assignGamepadPorts(gamepadPorts, pads);", replace: "    const nextPorts = assignGamepadPorts(gamepadPorts, pads);\n    nextPorts[1] = null;" }] }
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

// The Chrome renderer process dies (JS heap exhausted on the page) 10 s
// after load, on every run: the cell is run again, crashes again, blocks.
MUTANTS.push({
  id: "renderer-crash", what: "the Chrome renderer crashes on every run (candidate only)",
  spec: scene({ configs: [{ id: "sw-interp", preset: "sw-interp" }] }),
  candidate: { patches: [{ file: "src/app.js", append: "\n;setTimeout(() => { const hog = []; for (;;) hog.push(new Array(1 << 20).fill(hog.length)); }, 10000);\n" }] }
});

// Nondeterministic output: one random byte of each exact capture flipped, so
// every run of the patched side shows a different picture (like the JIT
// nondeterminism found on main). Single-config spec: only renderVsBaseline
// can see it.
const NONDETERMINISTIC = [{
  file: WORKER,
  find: "      const pixels = m.HEAPU8.slice(ptr, ptr + width * height * 4);",
  replace: "      const pixels = m.HEAPU8.slice(ptr, ptr + width * height * 4);\n      pixels[(Math.random() * width * height * 4) & ~3] ^= 0x5a;"
}];
const repeated = scene({ runs: 3, configs: [{ id: "sw-interp", preset: "sw-interp" }] });

MUTANTS.push({
  id: "nondeterministic", what: "the candidate's picture changes from run to run (main's is stable)",
  spec: repeated, candidate: { patches: NONDETERMINISTIC }
});

// Main's nondeterminism on this cell is declared known, as
// harness/known-failures.json does for cpufuzz-nomcrf/sw-jit.
const KNOWN_NONDETERMINISTIC = [{ cell: "gxscene/sw-interp", check: "renderVsBaseline", reason: "selftest: main made nondeterministic" }];

MUTANTS.push({
  id: "nondeterministic-base-broken", what: "main's picture changes from run to run (known) and the candidate stably loses its geometry",
  spec: repeated, baseline: { patches: NONDETERMINISTIC }, known: KNOWN_NONDETERMINISTIC,
  candidate: { discs: { [`${HB}/gxscene.iso`]: `${HB}/gxscene-nocubes.iso` } }
});

// Controls: known trouble on the baseline side that must NOT block a sound candidate.
export const CONTROLS = [{
  id: "baseline-nondeterministic", what: "main's picture changes from run to run (known), the candidate's is stable and right",
  spec: repeated, baseline: { patches: NONDETERMINISTIC }, known: KNOWN_NONDETERMINISTIC
}];

// The clean comparison covers every check the mutants use.
export const CLEAN_SPEC = scene({ games: [scene().games[0], tone], pads: true, fuzz: [`${HB}/cpufuzz-nomcrf.iso`], runs: 2 });

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function main() {
  const { values } = parseArgs({
    options: { only: { type: "string" }, clean: { type: "string", default: "5" }, port: { type: "string", default: process.env.HARNESS_PORT || "8082" }, display: { type: "string", default: "headless" } }
  });
  const dir = path.join(REPO_ROOT, "harness", "results", `selftest-${stamp()}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  claim(dir, REPO_ROOT, "results");
  const only = values.only ? new Set(values.only.split(",")) : null;
  const base = { root: REPO_ROOT };
  const rows = [];
  const runOne = async (id, kind, spec, candidate, baseline = {}, known = []) => {
    const sub = path.join(dir, id);
    mkdirSync(sub);
    const opts = { port: values.port, display: values.display, confirm: "2" };
    let gate, error = null;
    try {
      gate = await abCompare({ spec, specDir: REPO_ROOT, values: opts, dir: sub, baseline: { ...base, ...baseline }, candidate: { root: REPO_ROOT, ...candidate }, known });
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
  for (const m of MUTANTS) if (!only || only.has(m.id)) await runOne(m.id, "mutant", m.spec, m.candidate, m.baseline, m.known);
  for (const c of CONTROLS) if (!only || only.has(c.id)) await runOne(c.id, "control", c.spec, {}, c.baseline, c.known);
  for (let i = 1; i <= Number(values.clean); i += 1) if (!only || only.has("clean")) await runOne(`clean-${i}`, "clean", CLEAN_SPEC, {});
  const md = [
    "| Case | Kind | What | Gate | Blocked by | Expected |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.kind} | ${[...MUTANTS, ...CONTROLS].find((m) => m.id === r.id)?.what ?? "this tree vs itself"} | ${r.error ? `error: ${r.error}` : r.blocked ? "BLOCK" : "PASS"} | ${r.by.join("<br>") || "–"} | ${r.ok ? "yes" : "**NO**"} |`),
    "",
    `${rows.filter((r) => r.kind === "mutant" && r.ok).length}/${rows.filter((r) => r.kind === "mutant").length} mutants blocked, ${rows.filter((r) => r.kind === "control" && r.ok).length}/${rows.filter((r) => r.kind === "control").length} controls passed, ${rows.filter((r) => r.kind === "clean" && r.ok).length}/${rows.filter((r) => r.kind === "clean").length} clean runs passed.`
  ].join("\n");
  writeFileSync(path.join(dir, "selftest.json"), JSON.stringify(rows, null, 2));
  writeFileSync(path.join(dir, "selftest.md"), md + "\n");
  console.log("\n" + md);
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

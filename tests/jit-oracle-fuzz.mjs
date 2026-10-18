// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Interpreter-vs-JIT fuzz in Node, on the built core (the same engine as
// Chrome compiles the generated blocks). Two modes, both from fixed seeds:
//
//   node tests/jit-oracle-fuzz.mjs --per-instruction 200   # every instruction class × N states
//   node tests/jit-oracle-fuzz.mjs --programs 5000         # random blocks (cpufuzz-like)
//
// Options: --seed S, --core <dir>, --mask <hex> (CachedInterpreter disable
// mask; default production), --regalloc both|on|off, --json out.json.
// Exit 0 when nothing diverged and nothing was rejected by the engine.

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  PRODUCTION_DISABLE_MASK,
  REGALLOC_OFF,
  SHORT_PREFIX_MASK,
  classifyDifference,
  describeDifference,
  generate,
  hex,
  instructionNames,
  loadOracleCore,
  makeRng,
  randomProgram,
  randomState
} from "./helpers/jit-oracle.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const seed = Number(opt("seed", "1")) >>> 0;
const perInstruction = Number(opt("per-instruction", "0"));
const programs = Number(opt("programs", "0"));
const length = Number(opt("length", "24"));
const coreDir = opt("core", null);
const regalloc = opt("regalloc", "both");
const baseMask = Number(opt("mask", String(PRODUCTION_DISABLE_MASK))) >>> 0;
const jsonOut = opt("json", null);
const only = opt("only", null)?.split(",") ?? null;

const core = await loadOracleCore(coreDir ? pathToFileURL(path.resolve(coreDir) + "/") : undefined);
if (!core) {
  console.error("this core has no JIT oracle or predates these sources (npm run build:core:repro -- --install)");
  process.exit(2);
}
const masks = { both: [0, REGALLOC_OFF], on: [0], off: [REGALLOC_OFF] }[regalloc];

const findings = new Map(); // key -> {count, example}
let compared = 0, notCompiled = 0, rejected = 0, raisedException = 0;
function record(kind, name, mask, program, state, result) {
  const key = `${kind}:${name}`;
  const entry = findings.get(key) ?? { kind, name, count: 0, example: null };
  entry.count += 1;
  if (!entry.example) {
    entry.example = {
      mask: hex(mask),
      program: Array.from(program, hex),
      message: result.message,
      differences: describeDifference(result.interp, result.jit).slice(0, 12),
      state: Array.from(state, hex)
    };
  }
  findings.set(key, entry);
}

function check(name, program, state, mask) {
  let result;
  try {
    result = core.run(program, state, mask);
  } catch (error) {
    // A trap inside the core (abort, unreachable) aborts this program only.
    record("trap", name, mask, program, state, { message: String(error?.message || error), interp: state, jit: state });
    return;
  }
  if (result.code === 2) { notCompiled += 1; return; }

  if (result.code === -3) { rejected += 1; record("engine-reject", name, mask, program, state, result); return; }
  if (result.code < 0) throw new Error(`oracle setup error ${result.code} (${name}): ${result.message}`);
  compared += 1;
  if (result.message.startsWith("exception")) raisedException += 1;
  if (result.code === 1) {
    const kind = result.message.startsWith("memory") ? "values" : classifyDifference(result.interp, result.jit);
    record(kind === "fpscr-status" ? "fpscr-status" : "divergence", name, mask, program, state, result);
  }
}

const started = Date.now();
if (perInstruction > 0) {
  const r = makeRng(seed);
  for (const name of only ?? instructionNames()) {
    for (let k = 0; k < perInstruction; k++) {
      const program = Uint32Array.from([generate(name, r), 0x4e800020]);
      const state = randomState(r);
      for (const m of masks) check(name, program, state, SHORT_PREFIX_MASK | m);
    }
  }
}
if (programs > 0) {
  const r = makeRng(seed ^ 0x9e3779b9);
  for (let i = 0; i < programs; i++) {
    const program = randomProgram(r, length, { names: only });
    const state = randomState(r);
    for (const m of masks) check(`program`, program, state, baseMask | m);
  }
}

// Delta-debug one divergent example: replace instructions by nop while the
// difference stays, so the report shows the few instructions that matter.
function reduce(example) {
  const state = Uint32Array.from(example.state, (h) => Number.parseInt(h, 16));
  let program = Uint32Array.from(example.program, (h) => Number.parseInt(h, 16));
  const mask = Number.parseInt(example.mask, 16);
  const diverges = (p) => {
    try {
      const res = core.run(p, state, mask);
      if (res.code !== 1 || res.message === "step limit reached") return false; // a reduction can loop forever
      return res.message.startsWith("memory") || classifyDifference(res.interp, res.jit) === "values";
    } catch {
      return false;
    }
  };
  if (!diverges(program)) return null;
  for (let i = 0; i < program.length - 1; i++) {
    if (program[i] === 0x60000000) continue;
    const candidate = Uint32Array.from(program);
    candidate[i] = 0x60000000;
    if (diverges(candidate)) program = candidate;
  }
  const res = core.run(program, state, mask);
  return {
    program: Array.from(program, hex).filter((h) => h !== "0x60000000"),
    differences: [res.message, ...describeDifference(res.interp, res.jit)].filter(Boolean).slice(0, 12)
  };
}

const list = [...findings.values()].sort((a, b) => b.count - a.count);
if (args.includes("--reduce")) {
  for (const f of list.filter((x) => x.kind === "divergence")) f.reduced = reduce(f.example);
}
for (const f of list) {
  console.log(`${f.kind} ${f.name} ×${f.count} (mask ${f.example.mask})`);
  console.log(`  program: ${f.example.program.join(" ")}`);
  if (f.example.message) console.log(`  ${f.example.message}`);
  for (const d of f.example.differences) console.log(`  ${d}`);
  if (f.reduced) {
    console.log(`  reduced (nops removed): ${f.reduced.program.join(" ")}`);
    for (const d of f.reduced.differences) console.log(`    ${d}`);
  }
}
const summary = {
  seed, perInstruction, programs, length, masks: masks.map((m) => hex(baseMask | m)),
  compared, notCompiled, raisedException, rejected, divergent: list.filter((f) => f.kind === "divergence").reduce((n, f) => n + f.count, 0),
  fpscrStatus: list.filter((f) => f.kind === "fpscr-status").reduce((n, f) => n + f.count, 0),
  seconds: (Date.now() - started) / 1000
};
console.log(JSON.stringify(summary));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, findings: list }, null, 2));
// Random programs set FE0/FE1 in one state in six: none raising means the
// exception paths silently went uncompared.
const noExceptions = programs > 0 && raisedException === 0;
if (noExceptions) console.log("no program raised an exception: exception paths were not compared");
process.exit(list.length || noExceptions ? 1 : 0);

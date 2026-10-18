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
  exactFmaDouble,
  force25Bit,
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
  return result;
}

const fmaCases = Number(opt("fma", "0"));
let exactChecked = 0, exactMismatch = 0, singleInexact = 0;

// Adversarial operands for the FMA family: full-width significands (products
// never exact), b close to -a*c (cancellation), magnitudes around the exact
// path's guards (2^995, 2^-900), subnormals, overflow, zeros of both signs,
// single values (Force25Bit, ties).
function fmaOperands(r) {
  const d = (x) => { const f = new Float64Array([x]); return Array.from(new Uint32Array(f.buffer)); };
  const full = () => [r.next(), ((1023 + r.below(41) - 20) << 20 | (r.next() & 0xfffff)) >>> 0];
  const asDouble = ([lo, hi]) => new Float64Array(new Uint32Array([lo, hi]).buffer)[0];
  const scaled = (w, k) => d(asDouble(w) * 2 ** k);
  const single = () => d(new Float32Array([asDouble(full())])[0]);
  if (r.chance(0.15)) {
    // Single-precision tie trap: a, c singles (a*c exact), b = fl(m - a*c)
    // for a single midpoint m, so a*c + b lands on m or a hair off it: the
    // case NI_madd_msub corrects after its double FMA.
    const av = Math.fround((1 + r.next() / 2 ** 32) * 2 ** (r.below(41) - 20)) * (r.chance(0.5) ? 1 : -1);
    const cv = Math.fround((1 + r.next() / 2 ** 32) * 2 ** (r.below(41) - 20)) * (r.chance(0.5) ? 1 : -1);
    const p = av * cv;
    const y = Math.fround(p * (r.chance(0.5) ? 1 : -1) * (1 + r.below(64) / 16));
    const k = Math.floor(Math.log2(Math.abs(y)));
    const m = y + Math.sign(y) * 2 ** (k - 24);
    return { a: d(av), c: d(cv), b: d(m - p) };
  }
  if (r.chance(0.25)) {
    // Double-rounding trap: c has 24 bits (Force25Bit keeps it), a = 1/c, so
    // a*c rounds to 1 with a tiny nonzero error e; b's ulp is 2 * 2^m, so
    // p + b is an exact tie in double and only e decides the rounding.
    const cv = Math.fround(1 + r.next() / 2 ** 32) * (r.chance(0.5) ? 1 : -1);
    const m = r.below(61) - 30;
    const av = (1 / cv) * 2 ** m;
    const bv = (r.chance(0.5) ? 1 : -1) * (1 + r.next() / 2 ** 32 + (r.next() >>> 12) / 2 ** 52) * 2 ** (m + 53);
    return { a: d(av), c: d(cv), b: d(bv) };
  }
  const a = r.chance(0.4) ? single() : full();
  const c = r.chance(0.4) ? single() : full();
  let b;
  switch (r.below(8)) {
    case 0: case 1: b = d(-asDouble(a) * asDouble(c)); break;                 // cancellation
    case 2: b = d(-asDouble(a) * asDouble(c) * (1 + 2 ** -(20 + r.below(33)))); break;
    case 3: b = r.pick([[0, 0], [0, 0x80000000], [1, 0], [0, 0x00080000]]); break; // zeros, subnormals
    default: b = r.chance(0.5) ? single() : full();
  }
  const extreme = r.below(12);
  if (extreme === 0) return { a: scaled(a, 990 + r.below(10)), c, b };
  if (extreme === 1) return { a: scaled(a, -460 - r.below(30)), c: scaled(c, -440 - r.below(30)), b };
  if (extreme === 2) return { a: scaled(a, 520), c: scaled(c, 500), b };       // overflow
  if (extreme === 3) return { a: r.pick([[0, 0], [0, 0x80000000]]), c, b };
  if (extreme === 4) return { a, c: r.pick([[1, 0], [0, 0x80000], [0x10000000, 0x80000000], [0, 0]]), b }; // denormal frC
  if (extreme === 5) {
    // Products at the bottom of the range: exact-looking significands whose
    // product underflows to a subnormal or a zero (±0 b included).
    const k = r.below(60);
    // b: ±0, or a normal at the bottom of the range where the lost product
    // decides the rounding (ulp(b) = 2^-1074).
    const bottom = [r.below(4), (r.chance(0.5) ? 0x80000000 : 0) | 0x00100000 | r.below(2)];
    return { a: d(r.pick([1, -1, 1.5, -1.25]) * 2 ** -(480 + k)), c: d(r.pick([1, -1, 1.5]) * 2 ** -(540 + r.below(60))), b: r.chance(0.4) ? r.pick([[0, 0], [0, 0x80000000]]) : r.chance(0.7) ? bottom : b };
  }
  if (extreme === 6) return { a: r.pick([[1, 0], [0, 0x80000], [0, 0x80080000]]), c, b }; // denormal a
  return { a, c, b };
}
const FMA_NAMES = ["fmadd", "fmsub", "fnmadd", "fnmsub", "fmadds", "fmsubs", "fnmadds", "fnmsubs", "ps_madd", "ps_msub", "ps_nmadd", "ps_nmsub", "ps_madds0", "ps_madds1"];

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
if (fmaCases > 0) {
  const r = makeRng(seed ^ 0xf3a);
  for (let i = 0; i < fmaCases; i++) {
    const name = FMA_NAMES[i % FMA_NAMES.length];
    let word;
    do word = generate(name, r); while (word & 1); // no Rc: the direct tier compiles it
    const fa = (word >>> 16) & 31, fb = (word >>> 11) & 31, fc = (word >>> 6) & 31;
    if (fa === fb || fa === fc || fb === fc) { i--; continue; }
    const state = randomState(r);
    state[36] = r.chance(0.8) ? 0 : (r.next() & 0x7) | 0x4; // round to nearest, sometimes NI
    state[37] = 0x00002032;
    const { a, b, c } = fmaOperands(r);
    for (const [f, w] of [[fa, a], [fb, b], [fc, c]]) {
      const w2 = name.startsWith("ps_") ? fmaOperands(r).a : w;
      state.set([w[0], w[1], w2[0], w2[1]], 48 + f * 4);
    }
    for (const m of masks) {
      const result = check(name, Uint32Array.from([word, 0x4e800020]), state, SHORT_PREFIX_MASK | m);
      // Double forms, round to nearest: the interpreter (std::fma) and so the
      // JIT must give the correctly rounded a*c +- b, from exact arithmetic.
      const opcd = word >>> 26;
      if (!result || (result.code !== 0 && result.code !== 1) || (opcd !== 63 && opcd !== 59) || (state[36] & 7) !== 0) continue;
      const xo = (word >>> 1) & 31;
      const value = (i) => new Float64Array(Uint32Array.from(state.slice(48 + i * 4, 48 + i * 4 + 2)).buffer)[0];
      const single = opcd === 59;
      const want = exactFmaDouble(value(fa), single ? force25Bit(value(fc)) : value(fc), (xo === 28 || xo === 30 ? -1 : 1) * value(fb), single);
      if (!want) continue;
      if (xo >= 30) want[1] = (want[1] ^ 0x80000000) >>> 0;
      exactChecked += 1;
      const fd = (word >>> 21) & 31;
      if (result.interp[48 + fd * 4] !== want[0] || result.interp[48 + fd * 4 + 1] !== want[1]) {
        // Single forms: NI_madd_msub's tie fix is exact for single-precision
        // inputs only (its own comment); with a double b it can miss. The JIT
        // reproduces it, so this is counted, not failed.
        if (single) { singleInexact += 1; continue; }
        exactMismatch += 1;
        if (exactMismatch <= 5) console.log(`not correctly rounded: ${name} ${hex(word)} a ${value(fa)} c ${value(fc)} b ${value(fb)}`);
      }
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
  ...(fmaCases ? { exactChecked, exactMismatch, singleInexact } : {}),
  seconds: (Date.now() - started) / 1000
};
console.log(JSON.stringify(summary));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, findings: list }, null, 2));
// Random programs set FE0/FE1 in one state in six: none raising means the
// exception paths silently went uncompared.
const noExceptions = programs > 0 && raisedException === 0;
if (noExceptions) console.log("no program raised an exception: exception paths were not compared");
process.exit(list.length || noExceptions || exactMismatch ? 1 : 0);

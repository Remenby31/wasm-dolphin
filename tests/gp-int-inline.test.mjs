// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0195 (?gpint=1, enable bit 19): an integer store outside RAM tests the
// gather pipe page and appends there in line (then flushes at 32 bytes), as
// the float stores do, instead of MMU::Write. Regions and the block JIT, mode
// on and off, against the interpreter: the CPU state, RAM (where a flushed
// burst lands) and the bytes left in the pipe; stw/sth/stb through
// 0xCC008000, under and over 32 bytes, and a
// store to another hardware page (the import, as before). Mode off: the same
// code as before 0195 (digest), bit 19 changes it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assembleRegion } from "../src/aot-region-module.js";
import { HELPER_SIGNATURES, ORACLE_CODE, bigEndian, compareCall, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, makeRng, randomState } from "./helpers/jit-oracle.mjs";
import { staticConstants, staticNormalizedCode } from "./helpers/static-digest.mjs";

const GP_INT = 1 << 19;
const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const built = JSON.parse(readFileSync(new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url), "utf8"));
const thisSeries = built.source?.patchSeriesSha256 === lock.patchSeriesSha256 && lock.patches.some((p) => p.path.includes("/0195-"));
const core = thisSeries ? await loadAotCore() : null;
const skip = !thisSeries ? "core built from a patch series without 0195" : false;

const D = (op, s, a, imm) => ((op << 26) | (s << 21) | (a << 16) | (imm & 0xffff)) >>> 0;
const lis = (d, imm) => D(15, d, 0, imm), ori = (a, s, imm) => D(24, s, a, imm), addi = (d, a, imm) => D(14, d, a, imm);
const stw = (s, a, off) => D(36, s, a, off), sth = (s, a, off) => D(44, s, a, off), stb = (s, a, off) => D(38, s, a, off);
const BLR = 0x4e800020;
// r3 = (hi << 16) | 0x8000, the pipe address under that mirror, then `n` rounds of stw r4, sth r5, stb r6
// (7 bytes a round), the values stepped; `extra` stores after them.
function program(hi, n, extra = []) {
  const w = [lis(3, hi), ori(3, 3, 0x8000)];
  for (let i = 0; i < n; i++) w.push(stw(4, 3, 0), sth(5, 3, 0), stb(6, 3, 0), addi(4, 4, 0x111), addi(5, 5, 3), addi(6, 6, 1));
  return [...w, ...extra, BLR];
}
const pipe = () => {
  const p = core.module._malloc(512);
  try {
    const n = core.module._DolphinWeb_GatherPipeForTest(0, p, 512);
    return { n, bytes: Array.from(core.module.HEAPU8.slice(p, p + Math.min(n, 512))) };
  } finally { core.module._free(p); }
};
function check(words, mask, seed) {
  const state = randomState(makeRng(seed));
  state[37] = 0x00002032; state[33] = 0; state[36] = 0;
  core.loadState(state, ORACLE_CODE);
  core.load(ORACLE_CODE, bigEndian(words));
  const f = core.translate(ORACLE_CODE, { mask, ranges: [[ORACLE_CODE, ORACLE_CODE + 4 * words.length]] });
  assert.ok(f, "translated");
  const { bytes } = assembleRegion([f], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  const handle = core.compile(bytes);
  const regionAt = new Map(f.entries.map((pc) => [pc >>> 0, handle]));
  const baseline = core.ram().slice();
  const pipes = [];
  const result = compareCall(core, regionAt, () => {
    pipes.push(pipe());
    core.ram().set(baseline);
    core.loadState(state, ORACLE_CODE);
    core.module._DolphinWeb_GatherPipeForTest(1, 0, 0);
    core.setDowncount(400000);
  }, { strictCycles: true });
  pipes.push(pipe());
  assert.ok(!result.error && !result.trap, JSON.stringify(result));
  assert.ok(result.equal, JSON.stringify(result.difference));
  // compareCall runs: interpreter, regions, interpreter again; the pipe after
  // the regions' run (pipes[2], read at the third start) as the interpreter's.
  assert.deepEqual(pipes[2], pipes[3], "the pipe's pending bytes");
  return pipes[2];
}

// The stream sent to the FIFO: the test export puts the CPU FIFO at RAM
// 1 MiB, so every burst lands after the previous one; the stream is that
// range up to the write pointer, then the bytes still pending. The JIT flushes
// late (as for float stores) and the interpreter at every 32 bytes: the
// stream, not the moment of each burst, is what must match.
const FIFO_BASE = 0x00100000;
function streams(words, mask, seed) {
  const state = randomState(makeRng(seed));
  state[37] = 0x00002032; state[33] = 0; state[36] = 0;
  core.loadState(state, ORACLE_CODE);
  core.load(ORACLE_CODE, bigEndian(words));
  const f = core.translate(ORACLE_CODE, { mask, ranges: [[ORACLE_CODE, ORACLE_CODE + 4 * words.length]] });
  assert.ok(f, "translated");
  const { bytes } = assembleRegion([f], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  const handle = core.compile(bytes);
  const baseline = core.ram().slice();
  const run = (useRegion) => {
    core.ram().set(baseline);
    core.loadState(state, ORACLE_CODE);
    core.module._DolphinWeb_GatherPipeForTest(1, 0, 0);
    core.setDowncount(400000);
    for (let guard = 0; guard < 100000 && core.pc() !== 0x80002000; guard++) {
      if (useRegion && core.pc() === ORACLE_CODE) { core.runRegion(handle); continue; }
      assert.equal(core.interpretOne(), 0);
    }
    // Every whole burst out (the JIT left them pending): both sides then
    // hold the same < 32 bytes, so the pipe's pointers in the state agree.
    core.module._DolphinWeb_GatherPipeForTest(2, 0, 0);
    const end = core.module._DolphinWeb_GatherPipeFifoForTest() >>> 0;
    const sent = Array.from(core.ram().slice(FIFO_BASE, end));
    return { state: core.state(), stream: sent.concat(pipe().bytes), bursts: sent.length / 32 };
  };
  const reference = run(false), got = run(true);
  assert.deepEqual(got.state, reference.state, "CPU state");
  assert.equal(reference.stream.length, 7 * ((words.length - 3) / 6), "the interpreter sent every byte");
  assert.deepEqual(got.stream, reference.stream, "the bytes sent to the FIFO, in order");
}

for (const [name, mask] of [["mode off", PRODUCTION_DISABLE_MASK], ["mode on", PRODUCTION_DISABLE_MASK | GP_INT]]) {
  test(`${name}: integer stores to the gather pipe, under and over 32 bytes, through its mirrors, like the interpreter`, { skip }, () => {
    // Through 0xCC008000, the uncached mirror games write the pipe at. The
    // other mirrors (0x8C008000 under DBAT0, 0x0C008000 in real mode) take the
    // same in-line test, as the float stores' does; the test CPU has no BATs
    // set up, so its interpreter would not reach the pipe there to compare.
    // Flushed at every 32-byte burst as the interpreter does: state, RAM
    // (the bursts) and the pending bytes, exactly, under and over 32 bytes.
    for (const n of [2, 4, 5, 9, 20]) {
      const left = check(program(0xcc00, n), mask, 0x188 + n);
      assert.equal(left.n, (7 * n) % 32, `x${n}: what the 32-byte bursts left`);
    }
    // And the stream at the CPU FIFO (bursts kept in order at RAM 1 MiB).
    for (const n of [5, 9, 20]) streams(program(0xcc00, n), mask, 0x1890 + n);
    // A store to another hardware page goes through the import as before.
    check(program(0xcc00, 1, [lis(7, 0xcc00), stw(4, 7, 0x2000)]), mask, 0x1880);
  });
}

test("mode off translates as before 0195; bit 19 changes the integer stores", { skip }, () => {
  const h = (mask) => {
    const hash = createHash("sha256");
    for (const words of [program(0xcc01, 2), program(0x8c01, 9)]) {
      core.load(ORACLE_CODE, bigEndian(words));
      const f = core.translate(ORACLE_CODE, { mask, ranges: [[ORACLE_CODE, ORACLE_CODE + 4 * words.length]] });
      // static addresses relative (regshape-x64: they move with any patch's data)
      const range = { low: 0x10000, high: Math.min(...(f.heapBases ?? [0x1000000])) };
      const statics = staticConstants(f.code, range);
      hash.update(statics.length ? staticNormalizedCode(f.code, { ...range, base: Math.min(...statics) }) : f.code); hash.update(JSON.stringify(f.relocs));
    }
    return hash.digest("hex");
  };
  assert.equal(h(PRODUCTION_DISABLE_MASK), GP_INT_MODE_OFF_DIGEST);
  assert.notEqual(h(PRODUCTION_DISABLE_MASK | GP_INT), GP_INT_MODE_OFF_DIGEST);
});
// Measured on main's core before 0195 (8f764efa, 2026-10-31), static
// addresses relative.
const GP_INT_MODE_OFF_DIGEST = "ecea9ee112dde3af8aa533201202610f9ce7fbae1e5a0fa72b59b8d2562931d9";

test("?gpint=1 sets the enable bit 19 of the codegen mask (its modules have their own cache keys); off by default; a raw ?disable= never does", () => {
  const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /gpint: {11}1 << 19,/);
  assert.match(host, /if \(params\.get\("gpint"\) === "1"\) \{\n\s*mask \|= CACHED_INTERPRETER_DISABLE_BITS\.gpint;/);
  assert.match(host, /mask &= ~CACHED_INTERPRETER_DISABLE_BITS\.gpint;/);
  const patch = readFileSync(new URL("../patches/dolphin-wasm/snapshot/0195-gp-int-inline.patch", import.meta.url), "utf8");
  assert.match(patch, /\+constexpr u32 DOLPHIN_WEB_ENABLE_GP_INT_INLINE = 1u << 19;/);
  // Flushed at every 32-byte burst after an integer store (0188's late flush froze rendering).
  assert.match(patch, /\+  EmitI32Const\(body, GPFifo::GATHER_PIPE_SIZE\);\n\+  body\.push_back\(0x4f\);  \/\/ i32\.ge_u/);
});

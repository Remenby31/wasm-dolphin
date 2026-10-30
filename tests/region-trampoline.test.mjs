// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// ?regiontramp= (bit 19 of the codegen mask, default-off): a region's jumps
// between fragments and returns to its dispatcher become returned codes and
// a wrapper loop, because JavaScriptCore runs a return_call ~14x slower than
// V8 (3.7 against 0.27 ns, research/jit-contention-2cores.md). The oracle
// and call-graph tests run both forms against the interpreter
// (aot-region-oracle, aot-region-core, regshape-x64); here, the assembler's
// own contract and the option's way to the worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { TRAMP_BASE, assembleRegion } from "../src/aot-region-module.js";

const pad = [0x80, 0x80, 0x80, 0x80, 0x00];
// A at 0x3000 jumps to B (return_call reloc); B returns 7; C calls B as a
// guest call (0142) and returns what it gives plus 1; D writes B's pc to
// state.pc and dispatches (a return to the region's own dispatcher).
const A = { entry: 0x80003000, entries: [0x80003000], code: Uint8Array.from([0x00, 0x20, 0x00, 0x12, ...pad, 0x0b]), relocs: [{ offset: 4, kind: "jump", targetPc: 0x80003010 }] };
const B = { entry: 0x80003010, entries: [0x80003010], code: Uint8Array.from([0x00, 0x41, 0x07, 0x0b]), relocs: [] };
const C = { entry: 0x80003020, entries: [0x80003020], code: Uint8Array.from([0x00, 0x20, 0x00, 0x10, ...pad, 0x41, 0x01, 0x6a, 0x0b]), relocs: [{ offset: 4, kind: "call", targetPc: 0x80003010 }] };
const slebBytes = (v) => { const o = []; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) { o.push(b); return o; } o.push(b | 0x80); } };
const dHead = [0x00, 0x41, 0x00, 0x41, ...slebBytes(0x80003010 | 0), 0x36, 0x02, 0x00, 0x20, 0x00, 0x12];
const D = { entry: 0x80003030, entries: [0x80003030], code: Uint8Array.from([...dHead, ...pad, 0x0b]), relocs: [{ offset: dHead.length, kind: "dispatch" }] };
const run = (trampoline) => {
  const r = assembleRegion([A, B, C, D], { helpers: {}, pcOffset: 0, memoryPages: 1, sharedMemory: false, trampoline });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(r.bytes), { env: { memory } });
  const pc = (v) => { new Uint32Array(memory.buffer)[0] = v; };
  const out = {};
  pc(0x80003000); out.f = exports.f(0); out.frag0 = exports.fragments.get(0)(0);
  pc(0x80003020); out.call = exports.f(0);
  pc(0x80003030); out.dispatch = exports.f(0);
  pc(0x80009999); out.miss = exports.f(0);
  return { out, bytes: r.bytes };
};

test("trampoline: every entry point returns the codes of the tail-call module, both forms", () => {
  const base = run(null).out;
  assert.deepEqual(base, { f: 7, frag0: 7, call: 8, dispatch: 7, miss: 1 });
  for (const form of ["indirect", "direct"]) {
    const { out, bytes } = run(form);
    assert.deepEqual(out, base, form);
    // no tail call left in the fragments' jumps: the sites hold i32.const + return
    assert.ok(Buffer.from(bytes).includes(Buffer.from([0x41, 0x80 | ((TRAMP_BASE + 1) & 0x7f), 0x80 | (((TRAMP_BASE + 1) >>> 7) & 0x7f), 0x80 | (((TRAMP_BASE + 1) >>> 14) & 0x7f), ((TRAMP_BASE + 1) >>> 21) & 0x3f, 0x0f])), `${form}: A's jump to B is a returned code`);
  }
  assert.throws(() => assembleRegion([B], { helpers: {}, pcOffset: 0, memoryPages: 1, trampoline: "bogus" }), /trampoline bogus/);
});

test("?regiontramp= sets the enable bit 19 and the form, through the host, the adapter and the worker; a raw ?disable= never does", async () => {
  const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /regiontramp: {5}1 << 19,/);
  assert.match(host, /if \(requestedRegionTrampoline\(window\.location\.search\)\) \{\n\s*mask \|= CACHED_INTERPRETER_DISABLE_BITS\.regiontramp;/);
  assert.match(host, /mask &= ~CACHED_INTERPRETER_DISABLE_BITS\.regiontramp;/);
  assert.match(host, /\n {12}regionTrampoline: this\.regionTrampoline,\n/);
  assert.match(host, /return v === "1" \|\| v === "indirect" \? "indirect" : v === "direct" \? "direct" : null;/);
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter().regionTrampoline, null);
  assert.equal(new UpstreamWorkerAdapter({ regionTrampoline: "direct" }).regionTrampoline, "direct");
  const adapter = readFileSync(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");
  assert.match(adapter, /\n {6}regionTrampoline: this\.regionTrampoline,\n/);
  const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /\n {8}regionTrampoline: payload\.regionTrampoline,\n/);
  assert.match(worker, /trampoline: \(\(keyParts\?\.codegenMask \?\? 0\) & \(1 << 19\)\) !== 0 \? aotRegionTrampoline : null/);
});

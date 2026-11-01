// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { aotAssemblerRequested, createAotAssemblerClient, installAotAssemblerWorker } from "../src/aot-assembler-worker.js";
import { assembleRegion, paddedSleb, paddedUleb } from "../src/aot-region-module.js";

// Synthetic fragments in the translator's shape (as tests/aot-region-module.test.mjs).
const PC = 0, COUNT = 4, LR = 8, STATE = 64;
const HELPERS = { bump: { params: ["i32"], results: [] }, read_u32: { params: ["i32", "i32"], results: ["i32"] } };
function sleb(v) {
  const out = [];
  v |= 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

// Tiny fragment assembler: items are byte arrays or reloc markers.
function fragment(entry, entries, items) {
  const code = [0x00]; // no locals
  const relocs = [];
  for (const it of items) {
    if (Array.isArray(it)) code.push(...it);
    else { relocs.push({ offset: code.length, ...it }); code.push(...paddedUleb(0)); }
  }
  code.push(0x0b);
  return { entry, entries, code: Uint8Array.from(code), relocs };
}
const get = [0x20, 0x00];
const load = (off) => [...get, 0x28, 0x02, off];
const store = (off, value) => [...get, ...value, 0x36, 0x02, off];
const konst = (v) => [0x41, ...sleb(v)];
const add = (off, n) => store(off, [...load(off), ...konst(n), 0x6a]);
const ifPc = (pc, body) => [...load(PC), ...konst(pc), 0x46, 0x04, 0x40, ...body, 0x0b];
const tail = (reloc) => [[...get, 0x12], reloc];

// A (0x1000, 0x1004, 0x1008) calls B (0x2000), which returns through LR.
function program() {
  const A = fragment(0x1000, [0x1000, 0x1004, 0x1008], [
    ifPc(0x1000, []).slice(0, -1), add(COUNT, 1), store(LR, konst(0x1004)), store(PC, konst(0x2000)),
    ...tail({ kind: "jump", targetPc: 0x2000 }), [0x0b],
    ifPc(0x1004, []).slice(0, -1), add(COUNT, 100), store(PC, konst(0x80009000)),
    ...tail({ kind: "jump", targetPc: 0x80009000 }), [0x0b],
    ifPc(0x1008, [...konst(2), 0x0f]),
    konst(1)
  ]);
  const B = fragment(0x2000, [0x2000], [
    get, [0x10], { kind: "import", name: "bump" },
    add(COUNT, 10), store(PC, load(LR)),
    ...tail({ kind: "dispatch" })
  ]);
  return [A, B];
}

// The core's side of region chaining (patch 0102): region_chain(state) picks
// the next region's table index in `table`, 0 to return to the dispatcher.

// A worker in this thread: messages cloned both ways, as postMessage does.
function fakeWorker() {
  const scope = { postMessage: (data) => queueMicrotask(() => w.onmessage?.({ data: structuredClone(data) })) };
  installAotAssemblerWorker(scope);
  const w = { posted: 0, postMessage: (data) => { w.posted += 1; queueMicrotask(() => scope.onmessage({ data: structuredClone(data) })); }, terminate() {} };
  return w;
}

test("aot assembler: the bytes assembled in the worker are the ones assembled in place; errors come back with their message", async () => {
  const options = { helpers: HELPERS, pcOffset: PC, memoryPages: 1 };
  let made = 0;
  const client = createAotAssemblerClient({ options, createWorker: () => { made += 1; return fakeWorker(); } });
  const [a, b] = await Promise.all([client.assemble(program()), client.assemble(program())]);
  assert.deepEqual([...a], [...assembleRegion(program(), options).bytes]);
  assert.deepEqual([...b], [...a]);
  assert.equal(made, 1, "one worker for every request");
  await assert.rejects(client.assemble([]), /no fragments/);
  assert.equal(aotAssemblerRequested(""), true);
  assert.equal(aotAssemblerRequested("?aotasm=0"), false);
});

test("aot assembler: the discio worker hands first-launch assembly to it unless ?aotasm=0, the optimizer awaits it", () => {
  const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /aotAssemblerEnabled && typeof Worker === "function"\s*\? \(await import\("\.\/aot-assembler-worker\.js"\)\)\.createAotAssemblerClient\(\{ options: assembleOptions \}\)/);
  assert.match(worker, /tuning: \{ assemble: \(fragments\) => aotAssemblerClient\.assemble\(fragments\) \}/);
  const optimizer = readFileSync(new URL("../src/aot-optimizer.js", import.meta.url), "utf8");
  assert.match(optimizer, /bytes = await this\.assemble\(fragments\);/);
  const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /aotAssembler: this\.aotAssembler,/);
  const adapter = readFileSync(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");
  assert.match(adapter, /aotAssembler: this\.aotAssembler,/);
  assert.match(worker, /aotAssembler: payload\.aotAssembler,/);
});

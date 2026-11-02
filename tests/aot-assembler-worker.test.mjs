// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { aotAssemblerRequested, createAotAssemblerClient, installAotAssemblerWorker } from "../src/aot-assembler-worker.js";
import { assembleRegion, paddedSleb, paddedUleb } from "../src/aot-region-module.js";
import { AotOptimizer, fakeCache, fakeTranslator } from "../src/aot-optimizer.js";
import { imageFromDol } from "../src/aot-image.js";
import { planDol } from "../src/aot-plan.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";

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
  assert.match(worker, /aotAssemblerEnabled && typeof Worker === "function"\s*\? \(await import\("\.\/aot-assembler-worker\.js"\)\)\.createAotAssemblerClient\(\{ options: assembleOptions,/);
  assert.match(worker, /tuning: \{ assemble: \(fragments\) => aotAssemblerClient\.assemble\(fragments\) \}/);
  const optimizer = readFileSync(new URL("../src/aot-optimizer.js", import.meta.url), "utf8");
  assert.match(optimizer, /bytes = await this\.assemble\(fragments\);/);
  const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /aotAssembler: this\.aotAssembler,/);
  const adapter = readFileSync(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");
  assert.match(adapter, /aotAssembler: this\.aotAssembler,/);
  assert.match(worker, /aotAssembler: payload\.aotAssembler,/);
});

// Review of #405: a failure of the helper itself (transport) is never the
// module's: assembled in place, the helper dropped for the session, nothing
// refused. Only the module's own assembly error is judged as before.
const OPTIONS = { helpers: HELPERS, pcOffset: PC, memoryPages: 1 };
const expected = () => [...assembleRegion(program(), OPTIONS).bytes];

test("aot assembler: a Worker that cannot be made: in place, made once, every later request in place", async () => {
  let made = 0, failures = [];
  const client = createAotAssemblerClient({ options: OPTIONS, createWorker: () => { made += 1; throw new Error("SecurityError: refused by CSP"); }, onHelperFailure: (w) => failures.push(w) });
  const out = await Promise.all([client.assemble(program()), client.assemble(program()), client.assemble(program())]);
  for (const b of out) assert.deepEqual([...b], expected());
  assert.equal(made, 1, "never made again after it failed");
  assert.match(client.failed, /refused by CSP/);
  assert.equal(failures.length, 1);
});

test("aot assembler: a worker erroring at startup: requests in flight assembled in place, the worker terminated, not made again", async () => {
  let made = 0, terminated = 0;
  const createWorker = () => {
    made += 1;
    const w = { postMessage() { queueMicrotask(() => w.onerror?.({ message: "404 aot-assembler-worker.js" })); }, terminate() { terminated += 1; } };
    return w;
  };
  const client = createAotAssemblerClient({ options: OPTIONS, createWorker });
  const out = await Promise.all([client.assemble(program()), client.assemble(program())]);
  for (const b of out) assert.deepEqual([...b], expected());
  assert.deepEqual([...await client.assemble(program())], expected());
  assert.equal(made, 1);
  assert.equal(terminated, 1);
});

test("aot assembler: a clone error on postMessage, an unreadable reply, no reply: in place", async () => {
  const clone = createAotAssemblerClient({ options: OPTIONS, createWorker: () => ({ postMessage() { throw new DOMException("could not be cloned", "DataCloneError"); }, terminate() {} }) });
  assert.deepEqual([...await clone.assemble(program())], expected());
  assert.match(clone.failed, /could not be cloned/);
  const unreadable = createAotAssemblerClient({ options: OPTIONS, createWorker: () => { const w = { postMessage() { queueMicrotask(() => w.onmessageerror?.({})); }, terminate() {} }; return w; } });
  assert.deepEqual([...await unreadable.assemble(program())], expected());
  const silent = createAotAssemblerClient({ options: OPTIONS, timeoutMs: 20, createWorker: () => ({ postMessage() {}, terminate() {} }) });
  assert.deepEqual([...await silent.assemble(program())], expected());
  assert.match(silent.failed, /no reply within 20 ms/);
});

test("aot assembler: the module's own assembly error still rejects (judged as before), the helper stays in use", async () => {
  let made = 0;
  const client = createAotAssemblerClient({ options: OPTIONS, createWorker: () => { made += 1; return fakeWorker(); } });
  await assert.rejects(client.assemble([]), /no fragments/);
  assert.equal(client.failed, null);
  assert.deepEqual([...await client.assemble(program())], expected());
  assert.equal(made, 1);
});

test("aot assembler: terminate() ends the worker; what is still in flight is assembled in place", async () => {
  let terminated = 0;
  const client = createAotAssemblerClient({ options: OPTIONS, createWorker: () => ({ postMessage() {}, terminate() { terminated += 1; } }) });
  const inFlight = client.assemble(program());
  client.terminate();
  assert.deepEqual([...await inFlight], expected());
  assert.equal(terminated, 1);
  assert.deepEqual([...await client.assemble(program())], expected());
});

// A first launch whose helper fails to start: every region stored, none refused.
function dolPlan(n = 24) {
  const items = ["entry"];
  for (let i = 0; i < n; i++) items.push((pc, l) => asm.bl(pc, l[`f${i}`]));
  items.push(asm.blr());
  for (let i = 0; i < n; i++) {
    items.push(`f${i}`);
    for (let k = 0; k <= i; k++) items.push(asm.li(3, i * 100 + k));
    items.push(asm.blr());
  }
  const t = assemble(0x80003100, items);
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: 0x80003100, text: t.words, entry: t.labels.entry }));
  return planDol({ image, entryPoint, options: { gapFill: false } });
}

test("aot optimizer with a helper that fails to start: 0 regions blacklisted, every one stored by the in-place path", async () => {
  const run = async (assembleFn) => {
    const blacklist = new Set();
    const cache = fakeCache({ blacklist });
    const p = dolPlan();
    const o = new AotOptimizer({ discKey: "disc", cacheIdentity: { compilerVersion: "fake-1" }, openCache: cache, translator: fakeTranslator(), maxFunctions: 8,
      assembleOptions: { helpers: {}, pcOffset: 0, memoryPages: 1 }, buildPlan: async () => p, ...(assembleFn ? { assemble: assembleFn } : {}) });
    await o.start();
    return { blacklist, status: await o.status(), regions: o.regions.length };
  };
  const inPlace = await run(null);
  const client = createAotAssemblerClient({ options: { helpers: {}, pcOffset: 0, memoryPages: 1 }, createWorker: () => { throw new Error("worker refused"); } });
  const failedHelper = await run((fragments) => client.assemble(fragments));
  assert.equal(failedHelper.blacklist.size, 0, "nothing refused because the helper failed");
  assert.deepEqual(failedHelper.status, inPlace.status);
  assert.equal(failedHelper.status.state, "complete");
  assert.ok(failedHelper.regions > 1);
});

test("aot first launch: dispose() terminates the assembler", () => {
  const orchestrator = readFileSync(new URL("../src/aot-orchestrator.js", import.meta.url), "utf8");
  assert.match(orchestrator, /dispose\(\) \{\n\s+disposed = true;\n\s+this\.cancel\(\);\n\s+try \{ disposeAssembler\?\.\(\); \}/);
  const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /disposeAssembler: \(\) => aotAssemblerClient\.terminate\(\)/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { Worker } from "node:worker_threads";

import { functionBodySizes, JSC_OMG_MAX_FUNCTION_BYTES, moduleSizeSummary, regionCounts, sizeRecords, WASM_NOTIFY_MODULE, WASM_SIZES_TAG, webkitBootVerdict } from "../harness/probes/webkit-boot.mjs";

// A module of one type, n functions whose bodies are `sizes` bytes (locals
// count 0, then nops, then end), to check the code section walk.
function moduleWithBodies(sizes) {
  const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const bodies = sizes.flatMap((size) => [...leb(size), 0, ...new Array(size - 2).fill(0x01), 0x0b]);
  const code = [...leb(sizes.length), ...bodies];
  const funcs = [...leb(sizes.length), ...sizes.map(() => 0)];
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, ...leb(funcs.length), ...funcs, 10, ...leb(code.length), ...code]);
}

test("functionBodySizes reads each function's body size from the code section", () => {
  const sizes = [5, 300, 100001];
  const bytes = moduleWithBodies(sizes);
  assert.ok(WebAssembly.validate(bytes), "the test module is valid wasm");
  assert.deepEqual(functionBodySizes(bytes), sizes);
  assert.equal(functionBodySizes(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])), null);
});

test("moduleSizeSummary counts region functions over JavaScriptCore's OMG cap, not the core", () => {
  assert.equal(JSC_OMG_MAX_FUNCTION_BYTES, 100000);
  const records = [
    { bytes: 50 << 20, functions: [200000] }, // the core: left out
    { bytes: 120000, functions: [99000, 1000] },
    { bytes: 130000, functions: [100001] },
    { bytes: 20, functions: null },
  ];
  assert.deepEqual(moduleSizeSummary(records), { modules: 2, functions: 3, maxFunctionBytes: 100001, overOmgCap: 1 });
});

test("the verdict needs a boot, installed regions and no compile error", () => {
  const base = { booted: true, installs: 4, refused: 0, compileErrors: [], regionStats: { regionCalls: 10 } };
  assert.equal(webkitBootVerdict(base).ok, true);
  assert.equal(webkitBootVerdict({ ...base, installs: 0 }).ok, false);
  assert.equal(webkitBootVerdict({ ...base, refused: 1 }).ok, false);
  assert.equal(webkitBootVerdict({ ...base, compileErrors: ["CompileError: x"] }).ok, false);
  assert.equal(webkitBootVerdict({ ...base, booted: false }).ok, false);
  assert.equal(webkitBootVerdict({ ...base, regionStats: { regionCalls: 0 } }).ok, false, "installed but never run");
});

test("regionCounts takes the installs from the progress events and the refusals from the status", () => {
  const progress = { state: "complete", events: [{ type: "install", loaded: 0 }, { type: "done", compiled: 4, refused: 0 }, { type: "install", loaded: 4, after: "first-image" }] };
  assert.deepEqual(regionCounts(progress, { regionsRefused: 0 }), { installs: 4, compiled: 4, refused: 0, state: "complete" });
  assert.deepEqual(regionCounts({ state: "complete", events: [{ type: "done", compiled: 3 }] }, {}), { installs: 3, compiled: 3, refused: null, state: "complete" });
});

test("module sizes come back as console lines, so a worker that never yields cannot hang the read", () => {
  const lines = ["relaxed_madd: unsupported", `${WASM_SIZES_TAG}{"bytes":120000,"functions":[99000]}`, `${WASM_SIZES_TAG}not json`];
  assert.deepEqual(sizeRecords(lines), [{ bytes: 120000, functions: [99000] }]);
});

test("the lane's wasm notify module is valid and its notify wakes Atomics.waitAsync (V8 here)", async () => {
  const bytes = new Uint8Array(WASM_NOTIFY_MODULE);
  assert.ok(WebAssembly.validate(bytes));
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const mod = await WebAssembly.compile(bytes);
  const keepAlive = setInterval(() => {}, 1000);
  const worker = new Worker(`const { parentPort } = require("node:worker_threads"); parentPort.on("message", async ({ mod, memory }) => { const i = await WebAssembly.instantiate(mod, { e: { m: memory } }); setTimeout(() => i.exports.n(), 30); });`, { eval: true });
  const wait = Atomics.waitAsync(new Int32Array(memory.buffer), 0, 0, 2000);
  worker.postMessage({ mod, memory });
  try {
    assert.equal(await wait.value, "ok");
  } finally {
    clearInterval(keepAlive);
    await worker.terminate();
  }
});

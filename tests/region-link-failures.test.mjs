// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { integrityOf } from "../harness/lib/integrity.mjs";
import { REGION_LINK_FATAL, REGION_LINK_KEYS, createRegionLinkFailures, regionLinkCause } from "../src/region-link-failures.js";
import { INTEGRITY_FATAL } from "../src/wgpu-integrity.js";

const hex = (s) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "hex"));
// exports f: (f64) -> f64
const F64_IDENTITY = hex("0061736d01000000 0106016001 7c 01 7c 03020100 0705010166 0000 0a0601040020000b");
// imports env.f: (i32) -> i32
const IMPORTS_I32 = hex("0061736d01000000 0106016001 7f 01 7f 0209010365 6e76 0166 0000");

async function engineErrors() {
  let compileError, typeError, callableError;
  try {
    await WebAssembly.compile(hex("0061736d01000000 0a01"));
  } catch (e) {
    compileError = e;
  }
  const f64 = new WebAssembly.Instance(await WebAssembly.compile(F64_IDENTITY)).exports.f;
  const importer = await WebAssembly.compile(IMPORTS_I32);
  try {
    new WebAssembly.Instance(importer, { env: { f: f64 } });
  } catch (e) {
    typeError = e;
  }
  try {
    new WebAssembly.Instance(importer, { env: { f: 1 } });
  } catch (e) {
    callableError = e;
  }
  return { compileError, typeError, callableError };
}

test("region link failures are classified by cause: import type, validation, other", async () => {
  const { compileError, typeError, callableError } = await engineErrors();
  assert.ok(compileError instanceof WebAssembly.CompileError);
  assert.ok(typeError instanceof WebAssembly.LinkError, "a helper of another type is refused at instantiation");
  assert.equal(regionLinkCause(compileError), "regionLinkValidation");
  assert.equal(regionLinkCause(typeError), "regionLinkImportType");
  assert.equal(regionLinkCause(callableError), "regionLinkImportType");
  // as a pthread message carries them: name and message only
  assert.equal(regionLinkCause({ name: typeError.name, message: typeError.message }), "regionLinkImportType");
  assert.equal(regionLinkCause({ name: "CompileError", message: "x" }), "regionLinkValidation");
  assert.equal(regionLinkCause({ name: "LinkError", message: "memory too small" }), "regionLinkOther");
  assert.equal(regionLinkCause(new RangeError("WebAssembly.Instance(): Out of memory")), "regionLinkOther");
  assert.equal(regionLinkCause(null), "regionLinkOther");
  // compileFailureReason's strings and the cache's reason
  assert.equal(regionLinkCause("compile"), "regionLinkValidation");
  assert.equal(regionLinkCause("engine-reject"), "regionLinkValidation");
  assert.equal(regionLinkCause("link"), "regionLinkImportType");
  assert.equal(regionLinkCause("oom"), "regionLinkOther");
});

test("each module counts once, whichever path saw it first", async () => {
  const { compileError, typeError } = await engineErrors();
  const counts = createRegionLinkFailures();
  assert.deepEqual(counts.snapshot(), { regionLinkImportType: 0, regionLinkValidation: 0, regionLinkOther: 0 });
  assert.equal(counts.record("r:a", compileError), "regionLinkValidation");
  assert.equal(counts.record("r:a", typeError), null, "the same module again: not counted");
  assert.equal(counts.record("r:b", typeError), "regionLinkImportType");
  assert.equal(counts.record("r:c", new RangeError("out of memory")), "regionLinkOther");
  counts.record(null, compileError);
  counts.record(null, compileError);
  assert.deepEqual(counts.snapshot(), { regionLinkImportType: 1, regionLinkValidation: 3, regionLinkOther: 1 });
});

test("import type and validation failures are fatal in the integrity gate, out of memory is not", () => {
  assert.deepEqual([...REGION_LINK_KEYS].sort(), ["regionLinkImportType", "regionLinkOther", "regionLinkValidation"]);
  for (const k of REGION_LINK_FATAL) assert.ok(INTEGRITY_FATAL.includes(k), k);
  assert.ok(!INTEGRITY_FATAL.includes("regionLinkOther"));
  const start = { regionLinkImportType: 0, regionLinkValidation: 0, regionLinkOther: 0, stateLoads: 0 };
  const end = { regionLinkImportType: 0, regionLinkValidation: 2, regionLinkOther: 1, stateLoads: 0 };
  const verdict = integrityOf(start, end);
  assert.deepEqual(verdict.fatal, ["regionLinkValidation 2"]);
  assert.equal(verdict.delta.regionLinkOther, 1);
  // a baseline tree without the counters: nothing read, never fatal
  assert.deepEqual(integrityOf({ stateLoads: 0 }, { stateLoads: 0 }).fatal, []);
  // refusals counted before the window (at boot) are fatal on their total
  assert.deepEqual(integrityOf({ stateLoads: 0 }, { stateLoads: 0, regionLinkValidation: 5 }).fatal, ["regionLinkValidation 5 since boot"]);
});

const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);

test("the worker counts region modules the engine refused and reports them in validationReadIntegrity", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const { precompileAotRegion, installDolphinPthreadChannels, regionLinkFailuresForTest, setDolphinAotCompilerForTest } =
    await import(`${workerUrl.href}?region-link-failures-test=${Date.now()}`);
  setDolphinAotCompilerForTest({});
  const before = regionLinkFailuresForTest();
  assert.deepEqual(before, { regionLinkImportType: 0, regionLinkValidation: 0, regionLinkOther: 0 });

  // the first launch's compile: bytes that do not validate, counted once
  const junk = hex("0061736d01000000 0a01");
  assert.deepEqual(await precompileAotRegion("r:junk", junk), { reason: "compile" });
  assert.deepEqual(await precompileAotRegion("r:junk", junk), { reason: "compile" });
  assert.equal(regionLinkFailuresForTest().regionLinkValidation, 1);

  // the CPU thread's instantiation, by message
  const listeners = [];
  const cpu = { addEventListener: (type, listener) => listeners.push(listener), postMessage() {} };
  await installDolphinPthreadChannels({ PThread: { runningWorkers: [cpu], unusedWorkers: [] } }, { jitCacheEnabled: true });
  const onFailure = listeners.find((l) => l.name === "handleDolphinRegionLinkFailure");
  assert.ok(onFailure, "the pthread listener is installed with the JIT's");
  const { typeError } = await engineErrors();
  onFailure({ currentTarget: cpu, data: { type: "dolphin-region-link-failure", key: "r:fma", name: typeError.name, message: typeError.message } });
  onFailure({ currentTarget: cpu, data: { type: "dolphin-region-link-failure", key: "r:fma", name: "LinkError", message: typeError.message } });
  onFailure({ currentTarget: cpu, data: { type: "dolphin-jit-new-compile", hash: "x" } });
  assert.deepEqual(regionLinkFailuresForTest(), { regionLinkImportType: 1, regionLinkValidation: 1, regionLinkOther: 0 });

  // the counters reach validationReadIntegrity, the cache's load reports into them
  const worker = await readFile(workerUrl, "utf8");
  const read = worker.slice(worker.indexOf("function readWgpuIntegrity()"), worker.indexOf("function harnessGeometryCacheStats()"));
  assert.match(read, /\.\.\.regionLinkFailures\.snapshot\(\),/);
  assert.match(worker, /onLoadReject: \(key, error\) => regionLinkFailures\.record\(key, error\),/);
  assert.match(worker, /\} catch \(err\) \{\n\s+regionLinkFailures\.record\(key, err\);\n\s+return \{ reason: compileFailureReason\(err\) \};/);
});

// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The JIT engages on emulated frames only: same frame whatever the wall
// clock, machine load or JIT cache state, and nothing turns it off later.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
const adapter = await readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const match = new RegExp(`^function ${name}\\(`, "m").exec(source);
  assert.ok(match, `missing ${name}`);
  return source.slice(match.index, source.indexOf("\n}", match.index) + 2);
}

function createGate({ warmup = 60, preWarmed = false } = {}) {
  let now = 0;
  const modes = [];
  const context = vm.createContext({
    api: { setPpcWasmJitEnabled: (mode) => modes.push(mode) },
    console: { log: () => {} },
    postStatus: () => {},
    performance: { now: () => now },
    ppcWasmJitRequested: true,
    ppcWasmJitActive: false,
    ppcWasmJitCorePaused: false,
    ppcWasmJitTimingSuspensions: 0,
    ppcWasmJitEnabledAtFrame: 0,
    ppcWasmJitWarmupFrames: warmup,
    ppcWasmJitTier: "guarded",
    dolphinJitCachePreWarmed: preWarmed
  });
  vm.runInContext(extractFunction(worker, "maybeEnablePpcWasmJit"), context);
  return {
    modes,
    context,
    at(frame, wallMs) {
      now = wallMs;
      context.maybeEnablePpcWasmJit(frame);
    }
  };
}

test("JIT engages at exactly the warmup frame, whatever the wall clock or cache", () => {
  for (const preWarmed of [false, true]) {
    for (const msPerFrame of [1, 16.7, 500]) {
      const gate = createGate({ preWarmed });
      for (let frame = 0; frame < 120; frame++) gate.at(frame, frame * msPerFrame);
      assert.deepEqual(gate.modes, [1], `preWarmed=${preWarmed} msPerFrame=${msPerFrame}`);
      assert.equal(gate.context.ppcWasmJitEnabledAtFrame, 60);
    }
  }
});

test("warmup 0 engages on the first poll; nothing in the worker turns the JIT off", () => {
  const gate = createGate({ warmup: 0 });
  gate.at(0, 0);
  assert.deepEqual(gate.modes, [1]);
  assert.doesNotMatch(worker, /setPpcWasmJitEnabled\(0\)/);
});

test("the default warmup is short and the same on every layer", () => {
  assert.match(worker, /^const DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES = 60;$/m);
  assert.match(host, /^const DEFAULT_JIT_WARMUP_FRAMES = 60;$/m);
  assert.match(adapter, /ppcWasmJitWarmupFrames = 60,/);
  assert.doesNotMatch(host, /3600/);
});

test("with the core gate, the worker arms once and only reports the core's engage field", () => {
  const calls = [];
  let engaged = -1;
  const statuses = [];
  const context = vm.createContext({
    api: {
      setPpcWasmJitWarmup: (policy, fields) => calls.push([policy, fields]),
      getPpcWasmJitEngagedFrame: () => engaged,
      setPpcWasmJitEnabled: () => { throw new Error("the worker must not engage the JIT itself"); }
    },
    console: { log: () => {} },
    postStatus: (s) => statuses.push(s),
    ppcWasmJitRequested: true,
    ppcWasmJitActive: false,
    ppcWasmJitArmed: false,
    ppcWasmJitCorePaused: true, // pauses and loads no longer matter: the core counts fields
    ppcWasmJitTimingSuspensions: 1,
    ppcWasmJitEnabledAtFrame: 0,
    ppcWasmJitWarmupFrames: 60,
    ppcWasmJitTier: "guarded",
    dolphinJitCachePreWarmed: false
  });
  vm.runInContext(extractFunction(worker, "maybeEnablePpcWasmJit"), context);
  for (let frame = 0; frame < 5; frame++) context.maybeEnablePpcWasmJit(frame);
  assert.deepEqual(calls, [[1, 60]]);
  assert.equal(context.ppcWasmJitActive, false);
  engaged = 61;
  context.maybeEnablePpcWasmJit(70);
  context.maybeEnablePpcWasmJit(71);
  assert.equal(context.ppcWasmJitActive, true);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0], /field 61/);
});

test("the worker arms the core-side warmup in loadCore, before bootDisc", () => {
  const arm = worker.indexOf("api.setPpcWasmJitWarmup(ppcWasmJitTier");
  const boot = worker.indexOf("api.bootDisc(path)");
  assert.ok(arm > 0 && boot > 0 && arm < boot, "armed before the disc boots");
  assert.match(worker.slice(arm - 400, arm), /if \(ppcWasmJitRequested && api\.setPpcWasmJitWarmup\)/);
});

test("?jitwarmupload=boot reaches the core: host, adapter, worker message and loadCore (patch 0172)", async () => {
  assert.match(host, /get\("jitwarmupload"\) === "boot" \? "boot" : "restart"/);
  assert.equal(host.match(/ppcWasmJitWarmupOnLoad: this\.ppcWasmJitWarmupOnLoad,/g)?.length, 2, "both init messages");
  assert.match(adapter, /ppcWasmJitWarmupOnLoad = "restart",/);
  assert.match(adapter, /this\.ppcWasmJitWarmupOnLoad = ppcWasmJitWarmupOnLoad === "boot" \? "boot" : "restart";/);
  assert.match(adapter, /ppcWasmJitWarmupOnLoad: this\.ppcWasmJitWarmupOnLoad,/, "rebuilt field by field: carried");
  assert.match(worker, /ppcWasmJitWarmupOnLoad: payload\.ppcWasmJitWarmupOnLoad,/);
  assert.match(worker, /setJitWarmupOnLoad: optionalCwrap\("DolphinWeb_SetJitWarmupOnLoad", null, \["number"\]\)/);
  const set = worker.indexOf("api.setJitWarmupOnLoad?.(ppcWasmJitWarmupOnLoad");
  assert.ok(set > 0 && set < worker.indexOf("api.bootDisc(path)"), "set before the disc boots");
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0172-jit-warmup-from-boot-on-load.patch", import.meta.url), "utf8");
  assert.match(patch, /\+std::atomic<bool> s_wasm_warmup_from_boot_on_load\{false\};/, "off by default");
  assert.match(patch, /\+ {2}s_wasm_arm_from_boot\.store\(s_wasm_warmup_from_boot_on_load\.load\(std::memory_order_relaxed\),/);
  assert.match(patch, /\+extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_SetJitWarmupOnLoad\(int from_boot\)/);
});

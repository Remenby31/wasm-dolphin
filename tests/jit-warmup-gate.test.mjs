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

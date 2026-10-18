import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
function extractFunction(name, optional = false) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  if (optional && !match) return "";
  assert.ok(match, `missing production function ${name}`);
  const end = source.indexOf("\n}", match.index);
  assert.ok(end > match.index, `missing function boundary for ${name}`);
  return source.slice(match.index, end + 2);
}
const jitSource = [
  extractFunction("resetPpcWasmJitTiming", true),
  extractFunction("sampleCoreFpsRolling"),
  extractFunction("maybeEnablePpcWasmJit"),
  extractFunction("maybeDisablePpcWasmJit"),
].join("\n");
const thresholds = [...new Set(jitSource.match(/\bWASM_JIT_[A-Z_]+\b/g))]
  .map((name) => {
    const declaration = source.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
    assert.ok(declaration, `missing production threshold ${name}`);
    return declaration[0];
  }).join("\n");

function createHarness() {
  let now = 10000;
  let frame = 600;
  let state = "Running";
  const modes = [];
  const statuses = [];
  const timers = [];
  const noop = () => {};
  const api = {
    getFrame: () => frame,
    getCoreStateName: () => state,
    setPpcWasmJitEnabled: (mode) => modes.push(mode),
    setCorePaused: (paused) => { state = paused ? "Paused" : "Running"; return 1; },
    loadStateFile: () => 1,
    loadState: () => 1,
  };
  const context = vm.createContext({
    api, console: { log: noop }, self: {},
    performance: { now: () => now },
    setTimeout: (callback) => timers.push(callback),
    postStatus: (status) => statuses.push(status),
    ppcWasmJitActive: true,
    ppcWasmJitRequested: true,
    ppcWasmJitForce: false,
    ppcWasmJitDisabledForSession: false,
    ppcWasmJitCorePaused: false,
    ppcWasmJitTimingSuspensions: 0,
    ppcWasmJitCooldownUntilFrame: 0,
    ppcWasmJitEnabledAtFrame: 60,
    ppcWasmJitWarmupFrames: 60,
    ppcWasmJitTier: "guarded",
    dolphinJitCachePreWarmed: false,
    ppcWasmJitPreEngageFps: 57,
    ppcWasmJitPreEngageCoreFps: 60,
    ppcWasmJitCoreSampleFrame: 600,
    ppcWasmJitCoreSampleTime: 10000,
    ppcWasmJitCoreFpsRolling: 60,
    ppcWasmJitFuseLastFrame: 600,
    ppcWasmJitFuseLastTime: 10000,
    presentationFps: 57,
    presentationMaxIntervalMs: 16,
    maxIntervalSincePresentationFps: 16,
    lastPresentedAt: 10000,
    moduleInstance: { FS: { writeFile: noop } },
    forceWgpuMappedDrainLifecycle: noop,
    WGPU_MAPPED_DRAIN_FORCE_REASONS: { LOAD: "load" },
    wgpuSparseUbo: null,
    wgpuUboComputeProjectionActive: false,
    wgpuUboComputeReconstruction: null,
    workletAudioProducer: { transition: noop },
    collectWebGpuProducerStateStats: noop,
    webGpuCausalStats: { uploadTimeoutCount: 0 },
    collectMetrics: false,
    wgpuReplayClassifier: null,
    wgpuLoadEpochFence: false,
    webGpuCmdRing: null,
    wgpuUploadArenaMiB: 64,
    wgpuProducerProfileRequested: false,
    wgpuDrawProfileRequested: false,
    wgpuGeometryPackEnabled: false,
    wgpuGeometryRangeEnabled: false,
    softwareTevHotCaseMode: 0,
    applyWgpuTailGate: noop,
    wgpuExactCapture: { onLoad: noop },
    webGpuUboCacheMode: () => 0,
    webGpuUboPackMode: () => 0,
  });
  context.framePayload = () => {
    context.maybeEnablePpcWasmJit();
    return { frame };
  };
  vm.runInContext(`${thresholds}\n${jitSource}\n${extractFunction("handleMessage")}`, context);
  return {
    context, api, modes, statuses,
    advance: (ms, frames = 0) => { now += ms; frame += frames; },
    tick: () => { context.maybeEnablePpcWasmJit(); context.maybeDisablePpcWasmJit(); },
    request: (type, payload = {}) => context.handleMessage(type, payload),
    finishTimer: async (request) => {
      assert.equal(timers.length, 1, "one asynchronous operation should be pending");
      timers.shift()();
      return await request;
    },
  };
}

test("explicit pause longer than five seconds preserves active JIT and rearms running timing", async () => {
  const h = createHarness();
  const pause = h.request("validationSetCorePaused", { paused: true });
  h.advance(100);
  await h.finishTimer(pause);
  h.advance(6000);
  h.context.presentationMaxIntervalMs = 6100;
  h.context.maxIntervalSincePresentationFps = 6100;
  h.tick();
  assert.deepEqual(h.modes, []);
  assert.equal(h.context.ppcWasmJitActive, true);
  assert.equal(h.context.ppcWasmJitPreEngageCoreFps, 60, "pause preserves the same-scene baseline");

  await h.request("validationSetCorePaused", { paused: false });
  assert.equal(h.context.presentationMaxIntervalMs, 0);
  assert.equal(h.context.maxIntervalSincePresentationFps, 0);
  assert.equal(h.context.lastPresentedAt, 16100, "next interval starts at resume");
  assert.equal(h.context.ppcWasmJitCoreFpsRolling, 0);
  h.tick();
  h.advance(1600, 96);
  h.tick();
  assert.deepEqual(h.modes, []);
  assert.deepEqual(h.statuses, []);
  assert.equal(h.context.ppcWasmJitCooldownUntilFrame, 0);
  assert.equal(h.context.ppcWasmJitCoreFpsRolling, 60);
});

test("a paused core cannot engage an inactive JIT", async () => {
  const h = createHarness();
  h.context.ppcWasmJitActive = false;
  await h.finishTimer(h.request("validationSetCorePaused", { paused: true }));
  h.advance(6000);
  h.tick();
  assert.deepEqual(h.modes, []);
  await h.request("validationSetCorePaused", { paused: false });
  h.tick();
  assert.deepEqual(h.modes, [1]);
});

test("genuine running stalls still trip after an intentional pause", async () => {
  for (const presentationStall of [false, true]) {
    const h = createHarness();
    await h.finishTimer(h.request("validationSetCorePaused", { paused: true }));
    h.advance(6000);
    await h.request("validationSetCorePaused", { paused: false });
    h.tick();
    if (presentationStall) {
      h.context.ppcWasmJitEnabledAtFrame = 600;
      h.context.presentationMaxIntervalMs = 6001;
    } else {
      h.advance(1600);
    }
    h.tick();
    assert.deepEqual(h.modes, [0]);
    assert.equal(h.context.ppcWasmJitDisabledForSession, presentationStall);
    assert.match(h.statuses[0], presentationStall ? /post-activation stall/ : /catastrophic/);
  }
});

for (const accepted of [true, false]) {
  test(`${accepted ? "accepted" : "rejected"} file load suspends timing and cleans up`, async () => {
    const h = createHarness();
    h.api.loadStateFile = () => accepted ? 1 : 0;
    const load = h.request("loadStateFile", { fsPath: "/test.sav" });
    h.advance(6000);
    h.context.presentationMaxIntervalMs = 6000;
    h.tick();
    assert.deepEqual(h.modes, []);
    const result = await h.finishTimer(load);
    assert.equal(result.loaded, accepted);
    assert.equal(h.context.ppcWasmJitTimingSuspensions, 0);
    assert.equal(h.context.ppcWasmJitPreEngageCoreFps, accepted ? 0 : 60);
    assert.equal(h.context.ppcWasmJitPreEngageFps, accepted ? 0 : 57);
    assert.equal(h.context.presentationMaxIntervalMs, 0);
    h.tick();
    assert.deepEqual(h.modes, []);
    assert.equal(h.context.ppcWasmJitActive, true);
  });
}

test("throwing or unavailable file loads cannot leave the JIT guard suspended", async () => {
  const h = createHarness();
  h.api.loadStateFile = () => { throw new Error("native load failed"); };
  await assert.rejects(h.request("loadStateFile", { fsPath: "/test.sav" }), /native load failed/);
  assert.equal(h.context.ppcWasmJitTimingSuspensions, 0);
  assert.equal(h.context.ppcWasmJitPreEngageCoreFps, 60);
  h.api.loadStateFile = null;
  assert.equal((await h.request("loadStateFile", {})).loaded, false);
  assert.equal(h.context.ppcWasmJitTimingSuspensions, 0);
  h.context.presentationMaxIntervalMs = 6001;
  h.tick();
  assert.deepEqual(h.modes, [0]);
});

test("load cleanup preserves an enclosing native pause", async () => {
  const h = createHarness();
  await h.finishTimer(h.request("validationSetCorePaused", { paused: true }));
  await h.finishTimer(h.request("loadStateFile", { fsPath: "/test.sav" }));
  h.advance(6000);
  h.context.presentationMaxIntervalMs = 6001;
  h.tick();
  assert.deepEqual(h.modes, []);
  assert.equal(h.context.ppcWasmJitCorePaused, true);
});

test("slot loads use the same suspension and baseline cleanup", async () => {
  for (const accepted of [true, false]) {
    const h = createHarness();
    h.api.loadState = () => {
      h.advance(6000);
      h.context.presentationMaxIntervalMs = 6001;
      h.tick();
      return accepted ? 1 : 0;
    };
    assert.equal((await h.request("loadState", { slot: 1 })).loaded, accepted);
    assert.deepEqual(h.modes, []);
    assert.equal(h.context.ppcWasmJitTimingSuspensions, 0);
    assert.equal(h.context.ppcWasmJitPreEngageCoreFps, accepted ? 0 : 60);
  }
});

test("failed pause requests preserve guard operation", async () => {
  for (const throws of [true, false]) {
    const h = createHarness();
    h.api.setCorePaused = () => {
      if (throws) throw new Error("pause failed");
      return 0;
    };
    const pause = h.request("validationSetCorePaused", { paused: true });
    if (throws) await assert.rejects(pause, /pause failed/);
    else assert.equal((await h.finishTimer(pause)).paused, false);
    assert.equal(h.context.ppcWasmJitTimingSuspensions, 0);
    assert.equal(h.context.ppcWasmJitCorePaused, false);
    h.context.presentationMaxIntervalMs = 6001;
    h.tick();
    assert.deepEqual(h.modes, [0]);
  }
});

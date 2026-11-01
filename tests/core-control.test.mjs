import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CORE_CONTROL_OPS, CORE_CONTROL_TIMEOUT_MS, runCoreControl } from "../src/core-control.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// A fake core: request ids from 1, a scripted sequence of results per id,
// and a clock the polling advances.
function fakeCore(sequence, { refuse = false } = {}) {
  let clock = 0;
  const calls = [];
  const results = [...sequence];
  return {
    calls,
    request: (op, path) => { calls.push({ op, path }); return refuse ? 0 : 7; },
    result: (id) => { assert.equal(id, 7); return results.length > 1 ? results.shift() : results[0]; },
    sleep: async (ms) => { clock += ms; },
    now: () => clock
  };
}

test("a request is done when the core says so, late or not", async () => {
  const core = fakeCore([0, 0, 1]);
  assert.deepEqual(await runCoreControl({ ...core, op: CORE_CONTROL_OPS.saveFile, path: "/s.sav", what: "Save state" }), { id: 7, late: false });
  assert.deepEqual(core.calls, [{ op: 1, path: "/s.sav" }]);
  // past the core's time (-2), then done late (2)
  assert.deepEqual(await runCoreControl({ ...fakeCore([0, -2, -2, 2]), op: CORE_CONTROL_OPS.loadFile, what: "Load state" }), { id: 7, late: true });
});

test("a refusal or a failure is an error with a message, never silence", async () => {
  await assert.rejects(runCoreControl({ ...fakeCore([1], { refuse: true }), op: 3, what: "pause" }), /pause: the emulator refused the request/);
  await assert.rejects(runCoreControl({ ...fakeCore([0, -1]), op: 2, what: "Load slot 1" }), /Load slot 1: the emulator could not do it$/);
  await assert.rejects(runCoreControl({ ...fakeCore([-2, -3]), op: 1, what: "Save state" }), /could not do it \(it gave up late\)/);
});

test("past the worker's limit, a request still running fails with a message", async () => {
  await assert.rejects(
    runCoreControl({ ...fakeCore([0, -2]), op: 1, what: "Save state", timeoutMs: 1000 }),
    /Save state: the emulator did not finish within 1 s \(it is still working on it; try again in a moment\)/
  );
  await assert.rejects(runCoreControl({ ...fakeCore([0]), op: 5, what: "stop", timeoutMs: 1000 }), /did not finish within 1 s$/);
  assert.equal(CORE_CONTROL_TIMEOUT_MS, 60000);
});

test("the core runs pausing requests on its control pthread and reports their real end", async () => {
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /EMSCRIPTEN_KEEPALIVE\n#endif\nint RequestCoreControl\(int op, const char\* path\)/);
  assert.match(core, /EMSCRIPTEN_KEEPALIVE\n#endif\nint CoreControlResult\(int id\)/);
  assert.match(core, /std::thread\(CoreControlThread\)\.detach\(\);/);
  // one request at a time, in order
  assert.match(core, /job = std::move\(s_control_queue\.front\(\)\);\n\s+s_control_queue\.pop_front\(\);/);
  // the real end: the file written by the CPU job, the load applied, the state reached
  assert.match(core, /State::SaveToFileSync\(system, path\);\n\s+written->store\(true/);
  assert.match(core, /s_last_loaded_checkpoint_generation\.load\(std::memory_order_acquire\) != before/);
  assert.match(core, /wait_until\(\[&\] \{ return Core::GetState\(system\) == Core::State::Uninitialized; \}\);/);
  // late is reported, never a lie: the thread stays on it
  assert.match(core, /state\.rc = late \? \(ok \? 2 : -3\) : \(ok \? 1 : -1\);/);
  assert.match(core, /return std::chrono::steady_clock::now\(\) >= it->second\.deadline \? -2 : 0;/);
});

test("the worker never calls a pausing export when the core has the control pthread", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /stopCore: coreControl\n\s+\? \(\) => coreControl\(CORE_CONTROL_OPS\.stop, "", "stop"\)/);
  assert.match(worker, /setCorePaused: coreControl\n\s+\? \(paused\) => coreControl\(paused \? CORE_CONTROL_OPS\.pause : CORE_CONTROL_OPS\.resume/);
  // each synchronous export only in the branch for a core without it
  for (const call of ["api.loadStateFile(path)", "api.saveStateFile(path)"]) {
    for (const at of [...worker.matchAll(new RegExp(call.replace(/[.()]/g, "\\$&"), "g"))].map((m) => m.index)) {
      const before = worker.slice(Math.max(0, at - 1200), at);
      assert.match(before, /if \(api\.coreControl\) \{[\s\S]*\}(?: else \{)?/, `${call} at ${at} outside the fallback`);
    }
  }
  // a file load: everything after it runs once the core applied it
  const load = worker.slice(worker.indexOf("const loadFenceArmed = wgpuLoadFenceActive;"), worker.indexOf('applyWgpuTailGate("save-state reload")'));
  assert.match(load, /await api\.coreControl\(CORE_CONTROL_OPS\.loadFile, path, "Load state"\);/);
  assert.ok(load.indexOf("await api.coreControl(") < load.indexOf("wgpuIntegrity.stateLoad();"), "the load counted after it ended");
  // a slot load awaited, its failure answered
  assert.match(worker, /loaded = Boolean\(await api\?\.loadState\(payload\.slot \| 0\)\);/);
  assert.match(worker, /return \{ loaded, \.\.\.\(loadError \? \{ error: loadError \} : \{\}\), \.\.\.framePayload\(\) \};/);
  // a save on the control pthread, then the OPFS copy before the answer
  assert.match(worker, /await api\.coreControl\(CORE_CONTROL_OPS\.saveFile, path, "Save state"\);\n\s+const bytes = fs\.readFile\(path\);/);
  assert.match(worker, /const persisted = await flushUserDataReported\(\)|persisted: await flushUserDataReported\(\)/);
  // a new boot over a running game stops it there first
  assert.match(worker, /if \(api\.coreControl && running && running !== "Uninitialized"\) \{\n\s+await api\.coreControl\(CORE_CONTROL_OPS\.stop, "", "Stop the previous game"\);/);
  assert.match(worker, /if \(await api\.setCorePaused\(paused \? 1 : 0\)\) \{/);
});

test("the lifecycle awaits pause, resume and stop", async () => {
  const { createCoreLifecycle } = await import("../src/core-lifecycle.js");
  let state = "Running";
  const order = [];
  const api = {
    getCoreStateName: () => state,
    setCorePaused: async (p) => { order.push(`pause ${p}`); await null; state = p ? "Paused" : "Running"; order.push("paused"); return 1; },
    stopCore: async () => { order.push("stop"); await null; state = "Uninitialized"; order.push("stopped"); }
  };
  const life = createCoreLifecycle({ api: () => api, isBooted: () => true, sleep: async () => {} });
  assert.equal((await life.pause()).state, "Paused");
  assert.equal((await life.resume()).state, "Running");
  assert.equal((await life.stop()).state, "Uninitialized");
  assert.deepEqual(order, ["pause 1", "paused", "pause 0", "paused", "stop", "stopped"]);
});

test("the page answers a slot save or load within its limit, and a refused load says so", async () => {
  const { UpstreamWorkerAdapter, SLOT_REQUEST_TIMEOUT_MS } = await import("../src/upstream-worker-adapter.js");
  assert.equal(SLOT_REQUEST_TIMEOUT_MS, 70000);
  const statuses = [];
  const adapter = new UpstreamWorkerAdapter({ onStatus: (s) => statuses.push(s) });
  adapter.loaded = true;
  adapter.applyFrame = () => {};
  // a worker that never answers
  adapter.worker = { postMessage() {} };
  await assert.rejects(adapter.requestWithin("saveState", { slot: 1 }, 20, "Save slot 1"),
    /Save slot 1: the emulator did not answer within 0 s\. The game keeps running; try again\./);
  // a worker that answers a refused load
  adapter.worker = { postMessage(m) { queueMicrotask(() => adapter.handleMessage({ id: m.id, ok: true, loaded: false, error: "Load slot 2: the emulator could not do it" })); } };
  adapter.loadState(2);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(statuses.at(-1), "Load slot 2 failed: Load slot 2: the emulator could not do it");
  const source = await read("../src/upstream-worker-adapter.js");
  assert.match(source, /this\.requestWithin\("saveState", \{ slot \}, SLOT_REQUEST_TIMEOUT_MS, `Save slot \$\{slot\}`\)/);
  assert.match(source, /this\.requestWithin\("loadState", \{ slot \}, SLOT_REQUEST_TIMEOUT_MS, `Load slot \$\{slot\}`\)/);
});

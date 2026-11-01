import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CORE_CONTROL_GAVE_UP, CORE_CONTROL_OPS, CORE_CONTROL_STUCK, CORE_CONTROL_TIMEOUT_MS, runCoreControl, setPausedThroughControl } from "../src/core-control.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// A fake core: request ids from 1, a scripted sequence of results per id,
// and a clock the polling advances.
function fakeCore(sequence, { refuse = false, stuck = false } = {}) {
  let clock = 0;
  const calls = [];
  const abandoned = [];
  const results = [...sequence];
  return {
    calls,
    abandoned,
    abandon: (id) => abandoned.push(id),
    request: (op, path) => { calls.push({ op, path }); return stuck ? -1 : refuse ? 0 : 7; },
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

test("past the worker's limit, a request is given back to the core and the player is told to reload", async () => {
  assert.equal(CORE_CONTROL_STUCK, "the emulator is stuck on an earlier request: reload the page");
  assert.equal(CORE_CONTROL_GAVE_UP, "the emulator is stuck on it: reload the page");
  const late = fakeCore([0, -2]);
  await assert.rejects(runCoreControl({ ...late, op: 1, what: "Save state", timeoutMs: 1000 }),
    /^Error: Save state: the emulator did not finish within 1 s; the emulator is stuck on it: reload the page$/);
  assert.deepEqual(late.abandoned, [7], "the abandoned request is freed in the core");
  const queued = fakeCore([0]);
  await assert.rejects(runCoreControl({ ...queued, op: 5, what: "stop", timeoutMs: 1000 }), /did not finish within 1 s; .*reload the page$/);
  assert.deepEqual(queued.abandoned, [7]);
  // a finished request is never abandoned
  const done = fakeCore([0, 1]);
  await runCoreControl({ ...done, op: 3, what: "pause" });
  assert.deepEqual(done.abandoned, []);
  assert.equal(CORE_CONTROL_TIMEOUT_MS, 60000);
});

test("once the core is stuck, a new request fails at once with the reload message", async () => {
  const core = fakeCore([1], { stuck: true });
  const started = core.now();
  await assert.rejects(runCoreControl({ ...core, op: 5, what: "Stop the previous game" }),
    /^Error: Stop the previous game: the emulator is stuck on an earlier request: reload the page$/);
  assert.equal(core.now(), started, "no wait");
  assert.deepEqual(core.abandoned, []);
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
  assert.match(worker, /setCorePaused: coreControl\n\s+\? \(paused\) => setPausedThroughControl\(coreControl, paused\)/);
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

test("the main-thread adapter pauses and saves through the control pthread too", async () => {
  const { UpstreamMainThreadAdapter } = await import("../src/upstream-main-thread-adapter.js");
  const statuses = [];
  const adapter = new UpstreamMainThreadAdapter({ canvas: null, onStatus: (s) => statuses.push(s) });
  const requests = [];
  let next = 0;
  const outcomes = [1, 1, 1, -1];
  adapter.api = {
    setCorePaused: () => { throw new Error("the synchronous pause must not be called"); },
    saveCoreState: () => { throw new Error("the synchronous save must not be called"); },
    requestCoreControl: (op, path) => { requests.push(["control", op, path]); return 1; },
    requestCoreControlSlot: (op, slot) => { requests.push(["slot", op, slot]); return 1; },
    coreControlResult: () => outcomes[next++]
  };
  assert.equal(await adapter.pause(), 1);
  assert.equal(await adapter.start(), 1);
  assert.equal(await adapter.saveState(3), 1);
  assert.equal(await adapter.loadState(4), 0, "a load the core could not apply");
  assert.deepEqual(requests, [["control", 3, ""], ["control", 4, ""], ["slot", 1, 3], ["slot", 2, 4]]);
  assert.deepEqual(statuses, ["Load slot 4: the emulator could not do it"]);
  // a core without the control pthread: the synchronous exports, as before
  const legacy = [];
  adapter.api = { setCorePaused: (p) => { legacy.push(p); return 1; } };
  adapter.pause();
  assert.deepEqual(legacy, [1]);
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /int RequestCoreControlSlot\(int op, int slot\)/);
  assert.match(core, /File::GetUserPath\(D_STATESAVES_IDX\) \+ SConfig::GetInstance\(\)\.GetGameID\(\) \+ suffix/);
});

test("a load counts as loaded only when the core applied the state (patch 0210)", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0210-state-load-applied.patch");
  // the after-load callback runs whatever the outcome; the outcome is set just before it
  assert.match(patch, /\+  s_last_load_applied\.store\(was_file_read && loaded_successfully, std::memory_order_release\);\n   if \(s_on_after_load_callback\)\n     s_on_after_load_callback\(\);/);
  assert.match(patch, /\+bool LastLoadApplied\(\);/);
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  const callback = core.slice(core.indexOf("State::SetOnAfterLoadCallback([]() {"), core.indexOf("fifo.RunGpu();"));
  const gate = callback.indexOf("if (State::LastLoadApplied())");
  assert.ok(gate > 0, "the generation is gated");
  const gated = callback.slice(gate, callback.indexOf("    }\n", gate));
  for (const counted of ["s_last_loaded_checkpoint_generation.fetch_add(1", "DolphinWeb_HarnessOnStateLoaded();", "s_last_loaded_ticks_low.store(", "s_last_loaded_ppc_pc.store("]) {
    assert.ok(gated.includes(counted), `${counted} only for an applied load`);
    assert.equal(callback.split(counted).length, 2, `${counted} once`);
  }
  // the epoch and the GPU wake stay unconditional (an undo replayed DoState too)
  assert.ok(callback.indexOf("NotifyWebGpuOwnershipTraceLoadRequested();") > callback.indexOf("    }\n", gate));
  assert.match(callback, /fifo\.EmulatorState\(true\);/);
});

test("a stuck control pthread refuses at once, and an abandoned request leaves nothing behind", async () => {
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  // refused only behind a request the worker gave up on, never because one is late
  assert.match(core, /if \(s_control_running_id != 0 && s_control_abandoned\.count\(s_control_running_id\) != 0\)\n\s+return -1;/);
  assert.ok(!core.includes("s_control_running_deadline"));
  // a request's own time starts when the thread starts it, not when it was queued
  assert.match(core, /s_control_results\[id\] = \{0, std::chrono::steady_clock::time_point::max\(\)\};/);
  assert.match(core, /s_control_running_id = job\.id;\n\s+s_control_results\[job\.id\]\.deadline =\n\s+std::chrono::steady_clock::now\(\) \+ std::chrono::milliseconds\(CoreControlTimeoutMs\(job\.op\)\);/);
  const abandon = core.slice(core.indexOf("void CoreControlAbandon(int id)"));
  assert.match(abandon, /s_control_queue\.erase\(queued\);/, "a queued request never runs");
  assert.match(abandon, /else if \(id == s_control_running_id\)\n\s+s_control_abandoned\.insert\(id\);/);
  assert.match(abandon, /s_control_results\.erase\(id\);/);
  assert.match(core, /s_control_running_id = 0;\n\s+if \(s_control_abandoned\.erase\(job\.id\)\)\n\s+\{\n\s+s_control_results\.erase\(job\.id\);\n\s+continue;/);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /abandon: coreControlAbandon \?\? undefined/);
  const page = await read("../src/upstream-main-thread-adapter.js");
  assert.equal(page.split("abandon: api.coreControlAbandon ?? undefined").length, 3);
});

test("the control pthread sets the core status, and one dispatcher runs host jobs at a time", async () => {
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  const run = core.slice(core.indexOf("bool RunCoreControl(const CoreControlJob& job)"), core.indexOf("void CoreControlThread()"));
  for (const status of ["Saving state", "State saved", "Save state failed", "Loading state", "State loaded", "Load state failed", "Stopped"]) {
    assert.ok(run.includes(`"${status}"`), status);
  }
  assert.match(run, /SetCoreStatus\(pause \? "Paused" : "Running"\);/);
  // Core::Stop dumps host jobs: under the dispatch lock, which the worker only tries
  assert.match(run, /std::lock_guard dispatch\(s_host_dispatch_mutex\);\n\s+Core::Stop\(system\);/);
  assert.match(core, /std::unique_lock lock\(s_host_dispatch_mutex, std::try_to_lock\);\n\s+if \(lock\.owns_lock\(\)\)\n\s+Core::HostDispatchJobs\(Core::System::GetInstance\(\)\);/);
  assert.equal(core.split("Core::HostDispatchJobs(").length, 2, "every other dispatch goes through DispatchHostJobs");
});

test("the worker reports its pthreads against the pool", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /case "validationReadPthreads":\n\s+return readPthreadUse\(\);/);
  const PTHREAD_POOL_SIZE = Number(worker.match(/export const PTHREAD_POOL_SIZE = (\d+);/)[1]);
  const build = await read("../patches/dolphin-wasm/0001-browser-platform-build-gates.patch");
  assert.match(build, new RegExp(`-sPTHREAD_POOL_SIZE=${PTHREAD_POOL_SIZE}"`));
});

test("a slot save never reads as saved from the slot's previous file", async () => {
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  const save = core.slice(core.indexOf("case CoreControlOp::SaveFile:\n  {"), core.indexOf("case CoreControlOp::LoadFile:\n  {"));
  assert.match(save, /if \(had_previous && !File::Rename\(job\.path, previous\)\)/);
  assert.ok(save.indexOf("File::Rename(job.path, previous)") < save.indexOf("Core::RunOnCPUThread("), "moved aside before the save");
  assert.match(save, /const bool saved = File::Exists\(job\.path\) && File::GetSize\(job\.path\) > 0;/);
  assert.match(save, /if \(saved\)\n\s+File::Delete\(previous\);\n\s+else\n\s+File::Rename\(previous, job\.path\);/);
});

test("a pause the core cannot do yet answers 0, as SetCorePaused did, so callers retry until it holds", async () => {
  // the salon pauses right after mounting, while the game still boots, and
  // retries until the core reports Paused: a throw there stopped its retries
  // and the game ran behind the loading screen (2026-11-01, after 0209)
  const control = (sequence, opts) => (op, path, what) => runCoreControl({ ...fakeCore(sequence, opts), op, path, what });
  assert.equal(await setPausedThroughControl(control([0, -1]), true), 0, "still booting: the core could not");
  assert.equal(await setPausedThroughControl(control([1], { refuse: true }), true), 0, "no runtime yet");
  assert.equal(await setPausedThroughControl(control([0, 1]), true), 1);
  assert.equal(await setPausedThroughControl(control([1]), false), 1);
  // a time limit or a stuck thread is never a quiet 0
  await assert.rejects(setPausedThroughControl((op, path, what) => runCoreControl({ ...fakeCore([0]), op, path, what, timeoutMs: 1000 }), true), /reload the page/);
  await assert.rejects(setPausedThroughControl(control([1], { stuck: true }), true), /reload the page/);
});

test("the harness pause barrier answers the core's state, never throws, for a pause during boot", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  const barrier = worker.slice(worker.indexOf('case "validationSetCorePaused": {'), worker.indexOf('case "validationSetCorePaused": {') + 1500);
  assert.match(barrier, /if \(await api\.setCorePaused\(paused \? 1 : 0\)\) \{/);
  assert.match(barrier, /coreStateName,/);
});

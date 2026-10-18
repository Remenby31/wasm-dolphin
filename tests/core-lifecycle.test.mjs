import assert from "node:assert/strict";
import test from "node:test";

import { CORE_STATES, createCoreLifecycle } from "../src/core-lifecycle.js";

// A core whose state follows SetCorePaused/StopCore after `lagPolls` reads,
// the way Dolphin's CPU thread acknowledges a request a little later.
function fakeCore({ state = CORE_STATES.running, lagPolls = 2, refusePause = false } = {}) {
  const core = {
    state,
    target: null,
    lag: 0,
    calls: [],
    getCoreStateName() {
      if (core.target && --core.lag <= 0) {
        core.state = core.target;
        core.target = null;
      }
      return core.state;
    },
    setCorePaused(paused) {
      core.calls.push(["setCorePaused", paused]);
      if (refusePause) return 0;
      core.target = paused ? CORE_STATES.paused : CORE_STATES.running;
      core.lag = lagPolls;
      return 1;
    },
    resetCore() {
      core.calls.push(["resetCore"]);
      return core.state === CORE_STATES.running || core.state === CORE_STATES.paused ? 1 : 0;
    },
    stopCore() {
      core.calls.push(["stopCore"]);
      core.state = CORE_STATES.stopping;
      core.target = CORE_STATES.uninitialized;
      core.lag = lagPolls;
    }
  };
  return core;
}

function lifecycle(core, extra = {}) {
  return createCoreLifecycle({
    api: () => core,
    isBooted: () => true,
    sleep: async () => {},
    timeoutMs: 50,
    stopTimeoutMs: 50,
    ...extra
  });
}

test("pause and resume wait until the core reports the requested state", async () => {
  const core = fakeCore();
  const transitions = [];
  const life = lifecycle(core, {
    beforeTransition: (paused) => transitions.push(["before", paused]),
    afterTransition: (paused) => transitions.push(["after", paused])
  });

  assert.deepEqual(await life.pause(), { state: "Paused", changed: true });
  assert.deepEqual(await life.pause(), { state: "Paused", changed: false });
  assert.deepEqual(await life.resume(), { state: "Running", changed: true });
  assert.deepEqual(await life.start(), { state: "Running", changed: false });
  assert.deepEqual(transitions, [["before", true], ["after", true], ["before", false], ["after", false]]);
});

test("every lifecycle request fails loudly without a booted game", async () => {
  const life = createCoreLifecycle({ api: () => fakeCore(), isBooted: () => false, sleep: async () => {} });
  for (const action of ["start", "pause", "resume", "reset", "stop"]) {
    await assert.rejects(life[action](), new RegExp(`^Error: ${action}: no game is booted`));
  }
  const unloaded = createCoreLifecycle({ api: () => null, isBooted: () => true, sleep: async () => {} });
  await assert.rejects(unloaded.pause(), /pause: the core is not loaded/);
});

test("a refused or unacknowledged pause is an error, not a silent success", async () => {
  await assert.rejects(lifecycle(fakeCore({ refusePause: true })).pause(), /SetCorePaused refused/);
  await assert.rejects(lifecycle(fakeCore({ lagPolls: 1e9 })).pause(), /core still Running after 50 ms \(wanted Paused\)/);
});

test("a core that is still starting is waited for before pausing", async () => {
  const core = fakeCore({ state: CORE_STATES.starting });
  core.target = CORE_STATES.running;
  core.lag = 3;
  assert.deepEqual(await lifecycle(core).pause(), { state: "Paused", changed: true });
});

test("a missing export names itself", async () => {
  const core = fakeCore();
  delete core.resetCore;
  await assert.rejects(lifecycle(core).reset(), /reset: this core build has no resetCore export/);
});

test("reset taps the reset button; stop persists before and after the core goes down", async () => {
  const core = fakeCore();
  const order = [];
  const life = lifecycle(core, {
    beforeStop: async () => order.push(`before:${core.state}`),
    afterStop: async () => order.push(`after:${core.state}`)
  });
  assert.equal((await life.reset()).changed, true);
  assert.deepEqual(await life.stop(), { state: "Uninitialized", changed: true });
  assert.deepEqual(order, ["before:Running", "after:Uninitialized"]);
  assert.deepEqual(core.calls, [["resetCore"], ["stopCore"]]);
});

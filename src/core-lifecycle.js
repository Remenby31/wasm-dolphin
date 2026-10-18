// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// start / pause / resume / reset / stop for the upstream worker. Every call
// either reaches the state it names, observed through GetCoreStateName, or
// throws an error that says why. Nothing is answered with a silent no-op:
// the site had to fall back on a validation barrier because "start" and
// "pause" used to come back as "Unknown upstream worker message".

// Core::State names, as GetCoreStateName spells them (Core/Core.h).
export const CORE_STATES = Object.freeze({
  uninitialized: "Uninitialized",
  paused: "Paused",
  running: "Running",
  stopping: "Stopping",
  starting: "Starting"
});

export const LIFECYCLE_REQUEST_TYPES = Object.freeze(["start", "pause", "resume", "reset", "stop"]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCoreLifecycle({
  api,
  isBooted,
  sleep = defaultSleep,
  pollMs = 20,
  timeoutMs = 3000,
  stopTimeoutMs = 10_000,
  // Hooks the worker uses to keep its JIT timing honest around a transition
  // and to persist /dolphin-user before the core goes away.
  beforeTransition = () => {},
  afterTransition = () => {},
  beforeStop = async () => {},
  afterStop = async () => {}
} = {}) {
  function stateName() {
    return api()?.getCoreStateName?.() || CORE_STATES.uninitialized;
  }

  function requireCore(action) {
    const core = api();
    if (!core) throw new Error(`${action}: the core is not loaded`);
    if (!isBooted()) throw new Error(`${action}: no game is booted`);
    return core;
  }

  function requireExport(core, name, action) {
    if (typeof core[name] !== "function") {
      throw new Error(`${action}: this core build has no ${name} export`);
    }
    return core[name];
  }

  async function waitFor(predicate, limitMs, action, wanted) {
    const deadline = Date.now() + limitMs;
    let state = stateName();
    while (!predicate(state)) {
      if (Date.now() >= deadline) {
        throw new Error(`${action}: core still ${state} after ${limitMs} ms (wanted ${wanted})`);
      }
      await sleep(pollMs);
      state = stateName();
    }
    return state;
  }

  async function setPaused(paused, action) {
    const core = requireCore(action);
    const setCorePaused = requireExport(core, "setCorePaused", action);
    const wanted = paused ? CORE_STATES.paused : CORE_STATES.running;
    // A core still starting cannot be paused yet; wait for it to run first.
    if (stateName() === CORE_STATES.starting) {
      await waitFor((s) => s !== CORE_STATES.starting, timeoutMs, action, CORE_STATES.running);
    }
    const before = stateName();
    if (before === wanted) return { state: before, changed: false };
    if (before !== CORE_STATES.paused && before !== CORE_STATES.running) {
      throw new Error(`${action}: core is ${before}`);
    }
    beforeTransition(paused);
    let state = before;
    try {
      if (!setCorePaused(paused ? 1 : 0)) {
        throw new Error(`${action}: SetCorePaused refused (core ${stateName()})`);
      }
      state = await waitFor((s) => s === wanted, timeoutMs, action, wanted);
    } finally {
      afterTransition(state === CORE_STATES.paused);
    }
    return { state, changed: true };
  }

  return {
    stateName,
    // start resumes a paused game and is a no-op on a running one. Booting
    // is mountFile's job: start without a booted game is an error.
    start: () => setPaused(false, "start"),
    resume: () => setPaused(false, "resume"),
    pause: () => setPaused(true, "pause"),
    async reset() {
      const core = requireCore("reset");
      const resetCore = requireExport(core, "resetCore", "reset");
      const state = stateName();
      if (!resetCore()) throw new Error(`reset: ResetCore refused (core ${state})`);
      return { state: stateName(), changed: true };
    },
    async stop() {
      const core = requireCore("stop");
      const stopCore = requireExport(core, "stopCore", "stop");
      await beforeStop();
      stopCore();
      const state = await waitFor(
        (s) => s === CORE_STATES.uninitialized,
        stopTimeoutMs,
        "stop",
        CORE_STATES.uninitialized
      );
      await afterStop();
      return { state, changed: true };
    }
  };
}

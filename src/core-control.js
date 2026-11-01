// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Saving, loading, pausing and stopping pause the core's CPU thread, and that
// pause waits for the GPU thread. The worker is the WebGPU replay consumer:
// if it waited inside such a call, nothing would drain the command ring, the
// GPU thread would wait for room forever and the game would freeze for good
// (Spark, 2026-10-31: 3 slot saves in 20). The core runs these requests on
// its own control pthread (RequestCoreControl, core/upstream/
// dolphin_web_core.cpp); the worker asks, keeps replaying, and polls the
// result from its event loop here.

export const CORE_CONTROL_OPS = Object.freeze({ saveFile: 1, loadFile: 2, pause: 3, resume: 4, stop: 5 });

// The worker's own limit, above the core's (save 30 s, load 20 s, stop 15 s,
// pause 10 s): past it the request fails with a message, never silence.
export const CORE_CONTROL_TIMEOUT_MS = 60000;

// What the player reads when the control pthread is stuck: nothing more can
// pause, save, load or stop the core until the page is reloaded. STUCK: a new
// request refused behind one given up on; GAVE_UP: this request, given up.
export const CORE_CONTROL_STUCK = "the emulator is stuck on an earlier request: reload the page";
export const CORE_CONTROL_GAVE_UP = "the emulator is stuck on it: reload the page";

// RequestCoreControl: an id, 0 refused, -1 stuck on an earlier request given
// up on. CoreControlResult: 0 pending, 1 done, -1 failed or refused, -2
// still running past the core's time, 2 done late, -3 failed late. A request
// given up here is handed back to the core (abandon: CoreControlAbandon), so
// a queued one never runs later and no result is left behind.
export async function runCoreControl({
  request,
  result,
  abandon = () => {},
  op,
  path = "",
  what,
  timeoutMs = CORE_CONTROL_TIMEOUT_MS,
  pollMs = 20,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now()
}) {
  const id = request(op, path) | 0;
  if (id === -1) throw new Error(`${what}: ${CORE_CONTROL_STUCK}`);
  if (id <= 0) throw new Error(`${what}: the emulator refused the request`);
  const deadline = now() + timeoutMs;
  let late = false;
  for (;;) {
    const rc = result(id) | 0;
    if (rc === 1 || rc === 2) return { id, late: late || rc === 2 };
    if (rc === -1 || rc === -3) {
      throw new Error(`${what}: the emulator could not do it${rc === -3 ? " (it gave up late)" : ""}`);
    }
    if (rc === -2) late = true;
    if (now() >= deadline) {
      abandon(id);
      throw new Error(`${what}: the emulator did not finish within ${Math.round(timeoutMs / 1000)} s; ` +
        CORE_CONTROL_GAVE_UP);
    }
    await sleep(pollMs);
  }
}

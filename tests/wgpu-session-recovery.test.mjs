import assert from "node:assert/strict";
import test from "node:test";

import { PAUSE_TIMEOUT_MS, SAVE_TIMEOUT_MS, captureSessionAfterDeviceLoss, requestedWgpuSessionRecover } from "../src/wgpu-session-recovery.js";
import { EmulatorHost } from "../src/core-host.js";

test("?wgpurecover=1 is the only switch", () => {
  assert.equal(requestedWgpuSessionRecover(""), false);
  assert.equal(requestedWgpuSessionRecover("?video=wgpu"), false);
  assert.equal(requestedWgpuSessionRecover("?wgpurecover=0"), false);
  assert.equal(requestedWgpuSessionRecover("?video=wgpu&wgpurecover=1"), true);
});

function fakeAdapter({ pause = async () => ({ state: "Paused", changed: true }), save } = {}) {
  const calls = [];
  return {
    calls,
    lifecycle: (type) => { calls.push(type); return pause(); },
    exportSaveState: (options) => { calls.push(["export", options]); return save(); }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the state is taken only once the pause has finished, not alongside it", async () => {
  let finishPause;
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const adapter = fakeAdapter({
    pause: () => new Promise((resolve) => { finishPause = resolve; }),
    save: async () => ({ gameId: "GABCDE", bytes })
  });
  const pending = captureSessionAfterDeviceLoss(adapter);
  await settle();
  await settle();
  assert.deepEqual(adapter.calls, ["pause"], "no save while the pause is pending");
  finishPause({ state: "Paused", changed: true });
  const session = await pending;
  assert.deepEqual(adapter.calls, ["pause", ["export", { slot: 0 }]]);
  assert.deepEqual(session, { paused: true, pauseChanged: true, state: bytes, stateGameId: "GABCDE", stateError: "" });
});

test("a game the player had paused says so (pauseChanged false)", async () => {
  const bytes = new Uint8Array([1]).buffer;
  const fromHost = await captureSessionAfterDeviceLoss(fakeAdapter({
    pause: async () => ({ state: "Paused", changed: false }),
    save: async () => ({ gameId: "GABCDE", bytes })
  }));
  assert.equal(fromHost.paused, true);
  assert.equal(fromHost.pauseChanged, false);
  const fromWorker = await captureSessionAfterDeviceLoss(fakeAdapter({ save: async () => ({ bytes }) }), {
    workerPause: { state: "Paused", changed: false }
  });
  assert.equal(fromWorker.pauseChanged, false);
});

test("the worker's pause at the loss replaces the host's", async () => {
  const bytes = new Uint8Array([4]).buffer;
  const adapter = fakeAdapter({ save: async () => ({ gameId: "GABCDE", bytes }) });
  const session = await captureSessionAfterDeviceLoss(adapter, { workerPause: { state: "Paused", changed: true } });
  assert.deepEqual(adapter.calls, [["export", { slot: 0 }]]);
  assert.equal(session.paused, true);
  assert.equal(session.pauseChanged, true);
  const refused = await captureSessionAfterDeviceLoss(fakeAdapter({ save: async () => ({ bytes }) }), {
    workerPause: { error: "pause: core is Stopping" }
  });
  assert.equal(refused.paused, false);
  assert.equal(refused.state, bytes, "a refused pause still saves");
  assert.equal(refused.stateError, "pause: pause: core is Stopping");
});

test("a refused pause still saves; a failed save resolves with the reason", async () => {
  const bytes = new Uint8Array([7]).buffer;
  const late = await captureSessionAfterDeviceLoss(fakeAdapter({
    pause: async () => { throw new Error("core is Stopping"); },
    save: async () => ({ gameId: "GABCDE", bytes })
  }));
  assert.equal(late.paused, false);
  assert.equal(late.state, bytes);
  assert.equal(late.stateError, "pause: core is Stopping");

  const none = await captureSessionAfterDeviceLoss(fakeAdapter({ save: async () => { throw new Error("No game is booted"); } }));
  assert.deepEqual(none, { paused: true, pauseChanged: true, state: null, stateGameId: "", stateError: "save state: No game is booted" });
  const empty = await captureSessionAfterDeviceLoss(fakeAdapter({ save: async () => ({ bytes: new ArrayBuffer(0) }) }));
  assert.equal(empty.state, null);
  assert.match(empty.stateError, /no bytes/);
});

test("a pause that never answers skips the save: no 2 x timeout of silence", async () => {
  const adapter = fakeAdapter({ pause: () => new Promise(() => {}), save: () => new Promise(() => {}) });
  const session = await captureSessionAfterDeviceLoss(adapter, { pauseTimeoutMs: 20, saveTimeoutMs: 60_000 });
  assert.deepEqual(adapter.calls, ["pause"]);
  assert.equal(session.paused, false);
  assert.equal(session.state, null);
  assert.equal(session.stateError, "pause: pause timed out after 20 ms; save state: skipped, the worker did not answer the pause");
  // A save that never answers is bounded too.
  const stuck = await captureSessionAfterDeviceLoss(fakeAdapter({ save: () => new Promise(() => {}) }), { saveTimeoutMs: 20 });
  assert.equal(stuck.stateError, "save state: save state timed out after 20 ms");
  assert.equal(PAUSE_TIMEOUT_MS + SAVE_TIMEOUT_MS, 25_000);
});

function fakeHost({ recover, adapter, onGpuDeviceLost = null }) {
  const lost = [];
  const status = [];
  const recovering = [];
  const host = {
    wgpuSessionRecover: recover,
    mode: "dolphin",
    enhancements: { internalResolution: 2 },
    scaleLostCeiling: 4,
    adapter,
    onStatus: (s) => status.push(s),
    onGpuRecovering: (e) => recovering.push(e),
    onGpuDeviceLost: onGpuDeviceLost ?? ((e) => lost.push(e)),
    recoverSessionAfterDeviceLoss: EmulatorHost.prototype.recoverSessionAfterDeviceLoss
  };
  return { host, lost, status, recovering };
}

const lose = (host, event) => EmulatorHost.prototype.handleGpuDeviceLost.call(host, event);

test("without the switch the page hears of the loss at once, as before", () => {
  const { host, lost, recovering } = fakeHost({ recover: false, adapter: fakeAdapter({ save: async () => { throw new Error("unused"); } }) });
  const result = lose(host, { internalResolution: 2, reason: "unknown", detail: "oom" });
  assert.equal(result, null);
  assert.deepEqual(lost, [{ internalResolution: 2, fallback: 1, reason: "unknown", detail: "oom" }]);
  assert.deepEqual(recovering, []);
});

test("with the switch: recovering at once, then the loss once, with the paused session", async () => {
  const bytes = new Uint8Array([9, 9]).buffer;
  const adapter = fakeAdapter({ save: async () => ({ gameId: "GABCDE", bytes }) });
  const { host, lost, status, recovering } = fakeHost({ recover: true, adapter });
  const pending = lose(host, { internalResolution: 2, reason: "unknown", detail: "oom", pause: { state: "Paused", changed: true } });
  assert.deepEqual(recovering, [{ internalResolution: 2, fallback: 1, reason: "unknown" }], "before any await");
  assert.deepEqual(lost, [], "not before the state is taken");
  await pending;
  assert.deepEqual(adapter.calls, [["export", { slot: 0 }]], "the worker already paused");
  assert.deepEqual(lost, [{
    internalResolution: 2, fallback: 1, reason: "unknown", detail: "oom",
    paused: true, pauseChanged: true, state: bytes, stateGameId: "GABCDE", stateError: ""
  }]);
  assert.equal(host.enhancements.internalResolution, 1);
  assert.match(status.at(-1), /Session kept after the device loss \(2 bytes\)/);
});

test("the page always hears of the loss, even when the capture throws", async () => {
  const { host, lost } = fakeHost({ recover: true, adapter: null });
  host.onGpuRecovering = () => { throw new Error("page handler broke"); };
  const session = await lose(host, { internalResolution: 1, reason: "destroyed", detail: "" });
  assert.equal(lost.length, 1);
  assert.equal(lost[0].fallback, null);
  assert.equal(lost[0].state, null);
  assert.match(lost[0].stateError, /pause|save state|lifecycle/);
  assert.equal(session.state, null);
  // Something in the recovery itself throws after the capture: still told.
  const bytes = new Uint8Array([5]).buffer;
  const broken = fakeHost({ recover: true, adapter: fakeAdapter({ save: async () => ({ bytes }) }) });
  broken.host.onStatus = (s) => { if (s.startsWith("Session kept")) throw new Error("status broke"); };
  await lose(broken.host, { internalResolution: 2, reason: "unknown", detail: "" });
  assert.equal(broken.lost.length, 1);
  assert.equal(broken.lost[0].stateError, "status broke");
  // A throwing page handler does not reject the recovery either.
  const thrower = fakeHost({ recover: true, adapter: fakeAdapter({ save: async () => ({ bytes: new Uint8Array([1]).buffer }) }), onGpuDeviceLost: () => { throw new Error("boom"); } });
  const kept = await lose(thrower.host, { internalResolution: 2, reason: "unknown", detail: "" });
  assert.equal(kept.paused, true);
  assert.match(thrower.status.at(-1), /Device loss handler failed: boom/);
});

test("the worker pauses the core at the loss, before it posts, and the adapter passes the pause on", async () => {
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /const pause = wgpuSessionRecoverEnabled \? await pauseCoreAfterDeviceLoss\(\) : null;\s*self\.postMessage\(\{\s*type: "wgpu-device-lost"[\s\S]*?\.\.\.\(pause \? \{ pause \} : \{\}\)/);
  assert.match(worker, /async function pauseCoreAfterDeviceLoss\(\) \{\s*try \{\s*const \{ state, changed \} = await coreLifecycle\.pause\(\);/);
  // The switch reaches the worker (the adapter rebuilds the load message field by field).
  assert.match(worker, /wgpuSessionRecover: payload\.wgpuSessionRecover,/);
  assert.match(worker, /wgpuSessionRecoverEnabled = Boolean\(requestedWgpuSessionRecover\);/);
  const adapterSource = await readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");
  assert.match(adapterSource, /wgpuSessionRecover: this\.wgpuSessionRecover,/);
  const hostSource = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(hostSource, /wgpuSessionRecover: this\.wgpuSessionRecover,/);

  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({ wgpuSessionRecover: true }).wgpuSessionRecover, true);
  assert.equal(new UpstreamWorkerAdapter().wgpuSessionRecover, false);
  const seen = [];
  const adapter = new UpstreamWorkerAdapter({ onGpuDeviceLost: (e) => seen.push(e) });
  adapter.handleMessage({ type: "wgpu-device-lost", internalResolution: 2, reason: "unknown", detail: "", pause: { state: "Paused", changed: false } });
  adapter.handleMessage({ type: "wgpu-device-lost", internalResolution: 2, reason: "unknown", detail: "" });
  assert.deepEqual(seen, [
    { internalResolution: 2, reason: "unknown", detail: "", pause: { state: "Paused", changed: false } },
    { internalResolution: 2, reason: "unknown", detail: "" }
  ]);
});

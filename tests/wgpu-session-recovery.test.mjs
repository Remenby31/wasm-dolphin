import assert from "node:assert/strict";
import test from "node:test";

import { captureSessionAfterDeviceLoss, requestedWgpuSessionRecover } from "../src/wgpu-session-recovery.js";
import { EmulatorHost } from "../src/core-host.js";

test("?wgpurecover=1 is the only switch", () => {
  assert.equal(requestedWgpuSessionRecover(""), false);
  assert.equal(requestedWgpuSessionRecover("?video=wgpu"), false);
  assert.equal(requestedWgpuSessionRecover("?wgpurecover=0"), false);
  assert.equal(requestedWgpuSessionRecover("?video=wgpu&wgpurecover=1"), true);
});

function fakeAdapter({ pause = async () => ({ state: "Paused" }), save } = {}) {
  const calls = [];
  return {
    calls,
    lifecycle: (type) => { calls.push(type); return pause(); },
    exportSaveState: (options) => { calls.push(["export", options]); return save(); }
  };
}

test("the core is paused before the state is taken, and the bytes come back", async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const adapter = fakeAdapter({ save: async () => ({ gameId: "GABCDE", bytes }) });
  const session = await captureSessionAfterDeviceLoss(adapter);
  assert.deepEqual(adapter.calls, ["pause", ["export", { slot: 0 }]]);
  assert.deepEqual(session, { paused: true, state: bytes, stateGameId: "GABCDE", stateError: "" });
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
  assert.deepEqual(none, { paused: true, state: null, stateGameId: "", stateError: "save state: No game is booted" });
  const empty = await captureSessionAfterDeviceLoss(fakeAdapter({ save: async () => ({ bytes: new ArrayBuffer(0) }) }));
  assert.equal(empty.state, null);
  assert.match(empty.stateError, /no bytes/);
});

test("a worker that never answers cannot hold the page's restart", async () => {
  const session = await captureSessionAfterDeviceLoss(fakeAdapter({
    pause: () => new Promise(() => {}),
    save: () => new Promise(() => {})
  }), { timeoutMs: 20 });
  assert.equal(session.paused, false);
  assert.equal(session.state, null);
  assert.equal(session.stateError, "pause: pause timed out after 20 ms; save state: save state timed out after 20 ms");
});

function fakeHost({ recover, adapter }) {
  const lost = [];
  const status = [];
  return {
    lost,
    status,
    host: {
      wgpuSessionRecover: recover,
      mode: "dolphin",
      enhancements: { internalResolution: 2 },
      scaleLostCeiling: 4,
      adapter,
      onStatus: (s) => status.push(s),
      onGpuDeviceLost: (e) => lost.push(e)
    }
  };
}

test("without the switch the page hears of the loss at once, as before", () => {
  const { host, lost } = fakeHost({ recover: false, adapter: fakeAdapter({ save: async () => { throw new Error("unused"); } }) });
  const result = EmulatorHost.prototype.handleGpuDeviceLost.call(host, { internalResolution: 2, reason: "unknown", detail: "oom" });
  assert.equal(result, null);
  assert.deepEqual(lost, [{ internalResolution: 2, fallback: 1, reason: "unknown", detail: "oom" }]);
});

test("with the switch the page hears of the loss once, with the paused session", async () => {
  const bytes = new Uint8Array([9, 9]).buffer;
  const adapter = fakeAdapter({ save: async () => ({ gameId: "GABCDE", bytes }) });
  const { host, lost, status } = fakeHost({ recover: true, adapter });
  const pending = EmulatorHost.prototype.handleGpuDeviceLost.call(host, { internalResolution: 2, reason: "unknown", detail: "oom" });
  assert.deepEqual(lost, [], "not before the state is taken");
  await pending;
  assert.deepEqual(lost, [{
    internalResolution: 2, fallback: 1, reason: "unknown", detail: "oom",
    paused: true, state: bytes, stateGameId: "GABCDE", stateError: ""
  }]);
  assert.equal(host.enhancements.internalResolution, 1);
  assert.match(status.at(-1), /Session kept after the device loss \(2 bytes\)/);
});

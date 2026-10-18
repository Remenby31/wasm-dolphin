import assert from "node:assert/strict";
import test from "node:test";

import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";

function loadedAdapter() {
  const posted = [];
  const adapter = new UpstreamWorkerAdapter();
  adapter.loaded = true;
  adapter.applyFrame = () => {};
  adapter.worker = { postMessage: (message, transfer) => posted.push({ message, transfer }) };
  return { adapter, posted };
}

test("resume and stop are requests that settle with the worker's answer or error", async () => {
  const { adapter, posted } = loadedAdapter();
  const resumed = adapter.resume();
  adapter.handleMessage({ id: posted[0].message.id, ok: true, state: "Running" });
  assert.equal((await resumed).state, "Running");

  const stopped = adapter.stop();
  assert.equal(posted[1].message.type, "stop");
  adapter.handleMessage({ id: posted[1].message.id, ok: false, error: "stop: no game is booted" });
  await assert.rejects(stopped, /stop: no game is booted/);
});

test("saves calls refuse to run before the core is loaded", async () => {
  const adapter = new UpstreamWorkerAdapter();
  await assert.rejects(adapter.flushUserData(), /flushUserData: the core is not loaded/);
  await assert.rejects(adapter.resume(), /resume: the core is not loaded/);
});

test("imported bytes are transferred, not copied", () => {
  const { adapter, posted } = loadedAdapter();
  const card = new Uint8Array(64 + 0x2000);
  adapter.importMemcard(card, { slot: "B", replace: true }).catch(() => {});
  const state = new Uint8Array(48);
  adapter.importSaveState(state, { slot: 2, load: false }).catch(() => {});
  assert.equal(posted[0].message.type, "importMemcard");
  assert.equal(posted[0].message.payload.slot, "B");
  assert.equal(posted[0].transfer[0], card.buffer);
  assert.deepEqual(
    { type: posted[1].message.type, slot: posted[1].message.payload.slot, load: posted[1].message.payload.load },
    { type: "importSaveState", slot: 2, load: false }
  );
  assert.equal(posted[1].transfer[0], state.buffer);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("host and adapter carry the worklet SAB to the sole disc-worker producer", async () => {
  const [app, host, adapter, worker] = await Promise.all([
    read("../src/app.js"),
    read("../src/core-host.js"),
    read("../src/upstream-worker-adapter.js"),
    read("../src/upstream-discio-worker.js"),
  ]);
  assert.match(app, /setTransportBridge\(\(config\) => host\.configureAudioWorklet\(config\)\)/);
  assert.match(host, /configureAudioWorklet\(config\)/);
  assert.match(adapter, /request\("configureAudioWorklet"/);
  assert.match(worker, /case "configureAudioWorklet"/);
  assert.match(worker, /workletAudioProducer\.install\(payload\.sab/);
  assert.doesNotMatch(app, /MixAudio|AudioBuffer/);
});

test("reset and both save-state load paths fence stale worklet audio", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  const reset = worker.slice(worker.indexOf('case "reset"'), worker.indexOf('case "bootProbe"'));
  const slotLoad = worker.slice(worker.indexOf('case "loadState"'), worker.indexOf('case "validationSetCorePaused"'));
  const fileLoad = worker.slice(worker.indexOf("async function loadStateFileNow("), worker.indexOf("async function handleMessage("));
  assert.ok(reset.indexOf("workletAudioProducer.transition()") < reset.indexOf("api?.reset()"));
  assert.ok(slotLoad.indexOf("workletAudioProducer.transition()") < slotLoad.indexOf("api?.loadState"));
  assert.ok(fileLoad.indexOf("workletAudioProducer.transition()") < fileLoad.indexOf("api.loadStateFile"));
});

test("replay budget yields offer a bounded cooperative producer refill", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(
    worker,
    /budgetStopReason === "time-budget"[\s\S]*workletAudioProducer\.refill\(1\)/
  );
  assert.doesNotMatch(worker, /Atomics\.wait\(/);
});

test("the worker producer calls native timers through their global receiver", async () => {
  const producer = await read("../src/audio-pcm-producer.js");
  assert.match(producer, /globalThis\.setInterval\(callback, delay\)/);
  assert.match(producer, /globalThis\.clearInterval\(timer\)/);
});

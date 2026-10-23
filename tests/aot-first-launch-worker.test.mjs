// P7 wiring in the discio worker (?aot=1): messages, a core without the
// translator export, cancel and remount before the post-boot start, and
// nothing of P7 loaded without the flag.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fakeCacheStorage } from "./helpers/fake-cache-storage.mjs";

const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
const DISC = `disc-sha256-v1:${"3".repeat(64)}`;
const CORE = "c".repeat(64);

async function loadWorker(t) {
  const originalSelf = globalThis.self;
  const posted = [];
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage: (m) => posted.push(m) };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const worker = await import(`${workerUrl.href}?aot-test=${Date.now()}-${Math.random()}`);
  return { worker, posted };
}

// A core with the agreed exports; every translation is counted.
function fakeCore() {
  const heap = new Uint8Array(1 << 16);
  let top = 1024;
  const strings = new Map();
  const str = (text) => {
    if (!strings.has(text)) {
      const p = top;
      heap.set(new TextEncoder().encode(`${text}\0`), p);
      top += (text.length + 8) & ~7;
      strings.set(text, p);
    }
    return strings.get(text);
  };
  const m = {
    translations: 0,
    HEAPU8: heap,
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    UTF8ToString: (p) => new TextDecoder().decode(heap.subarray(p, heap.indexOf(0, p))),
    _DolphinWeb_AotKeyParts: (p) => new Uint32Array(heap.buffer, p, 2).set([7, 0]),
    _DolphinWeb_JitHelperName: (i) => (i === 0 ? str("read_u32") : 0),
    _DolphinWeb_JitHelperSignature: (i) => (i === 0 ? str("i32,i32>i32") : 0),
    _DolphinWeb_JitStateLayout: (p) => new Uint32Array(heap.buffer, p, 4).set([0, 4, 8, 1]),
    _DolphinWeb_AotTranslate() {
      m.translations++;
      return 0;
    }
  };
  return m;
}

test("without aot=1 the worker answers disabled and imports nothing of P7", async (t) => {
  const { worker } = await loadWorker(t);
  worker.setAotFirstLaunchEnabledForTest(false);
  assert.deepEqual(await worker.handleAotMessage("validationReadAotProgress"), { schema: "wasm-dolphin.aot-progress.v1", state: "disabled", events: [] });
  assert.deepEqual(await worker.handleAotMessage("aotStatus"), { state: "disabled", fraction: 0 });
  assert.deepEqual(await worker.handleAotMessage("aotOptimize", { resume: true }), { started: false });
  // P7's modules are loaded only under the flag (dynamic import)
  const source = await readFile(workerUrl, "utf8");
  for (const mod of ["aot-orchestrator", "aot-optimizer", "aot-plan-worker", "aot-recomp", "aot-profile"]) {
    assert.ok(!new RegExp(`^import[^;]*"\\./${mod}\\.js"`, "m").test(source), `${mod} is not a static import`);
  }
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.ok(!/aot-orchestrator/.test(host));
});

test("a core without the translator export: unsupported, and the disc key is never read", async (t) => {
  const { worker } = await loadWorker(t);
  worker.setAotFirstLaunchEnabledForTest(true);
  let reads = 0;
  await worker.prepareAotFirstLaunch({}, { module: {}, readDiscKey: async () => { reads++; return DISC; }, coreHash: CORE });
  assert.equal(reads, 0);
  assert.equal((await worker.handleAotMessage("validationReadAotProgress")).state, "unsupported");
  assert.deepEqual(await worker.handleAotMessage("aotStatus"), { state: "unsupported", fraction: 0 });
  await worker.startAotFirstLaunchAfterBoot();
});

test("with the export: install before boot (first launch), then a cancel or a remount before the start wins", async (t) => {
  const { worker, posted } = await loadWorker(t);
  worker.setAotFirstLaunchEnabledForTest(true);
  const core = fakeCore();
  const options = { module: core, readDiscKey: async () => DISC, coreHash: CORE, cacheStorage: fakeCacheStorage(), storageRoot: () => null };
  await worker.prepareAotFirstLaunch({}, options);
  const progress = await worker.handleAotMessage("validationReadAotProgress");
  assert.equal(progress.disc, DISC);
  assert.deepEqual(progress.events.map((e) => [e.type, e.firstLaunch]), [["install", true]]);
  assert.ok(posted.some((m) => m.type === "aot-progress" && m.event.type === "install"), "the page gets the event");

  // aotCancel right after the boot: the queued start does not run
  const started = worker.startAotFirstLaunchAfterBoot();
  await worker.handleAotMessage("aotCancel");
  await started;
  assert.equal(core.translations, 0);
  assert.ok(!(await worker.handleAotMessage("validationReadAotProgress")).events.some((e) => e.type === "start"));

  // remount before the start: the old flow never runs
  const old = worker.startAotFirstLaunchAfterBoot();
  await worker.prepareAotFirstLaunch({}, options);
  await old;
  assert.equal(core.translations, 0);
  worker.setAotFirstLaunchEnabledForTest(false);
});

// Review of #72 (P2-2): a cached module whose layout differs from the core's
// is not copied into the core's heap and is handed back for retranslation,
// under its key; one under the core's layout is queued.
test("a cached region under another layout goes to retranslation, never into the core", async (t) => {
  const { worker } = await loadWorker(t);
  const heap = new Uint8Array(1 << 16);
  let top = 1024;
  const queued = [];
  const core = {
    HEAPU8: heap,
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    _DolphinWeb_AotLayoutHash: () => 0x1234,
    _DolphinWeb_AotQueueRegion: (...args) => queued.push(args)
  };
  const asked = [];
  const flow = { retranslate: async (key) => { asked.push(key); return true; } };
  const region = { key: "region-v1:k", bytes: Uint8Array.of(0, 97, 115, 109), entries: [0x80003100], members: [{ ranges: [[0x80003100, 0x80003110]], hash: "0011223344556677" }] };
  await worker.queueAotRegionForTest(core, { ...region, layout: 0x9999 }, flow);
  assert.deepEqual(asked, ["region-v1:k"]);
  assert.equal(queued.length, 0, "not copied into the core");
  await worker.queueAotRegionForTest(core, { ...region, layout: 0x1234 }, flow);
  assert.equal(queued.length, 1);
  assert.equal(queued[0][8], 0x1234, "queued with its layout");
  assert.deepEqual(asked, ["region-v1:k"], "no retranslation under the core's layout");
});

// Review of #86: the region cache waits for the first presented image (or
// the timeout), never more; with no running core, not at all.
test("the first-image wait: woken by the first presented frame, or by its timeout", async (t) => {
  const { worker } = await loadWorker(t);
  assert.equal(await worker.aotWhenFirstImageForTest(null), false, "no core: at once");
  let woken = null;
  const waiting = worker.aotWhenFirstImageForTest({}, { timeoutMs: 5000 }).then((v) => { woken = v; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(woken, null, "still waiting before a frame");
  worker.recordPresentedFrameForTest(1);
  await waiting;
  assert.equal(woken, true, "the first presented frame wakes it");
  assert.equal(await worker.aotWhenFirstImageForTest({}, { timeoutMs: 30 }), false, "no frame: the timeout");
});

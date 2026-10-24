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
  assert.deepEqual(await worker.handleAotMessage("aotStatus"), { state: "disabled", fraction: 0, wasmFeatures: { relaxedMadd: null } });
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
  assert.deepEqual(await worker.handleAotMessage("aotStatus"), { state: "unsupported", fraction: 0, wasmFeatures: { relaxedMadd: null } });
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

// Harness only: the ledger of what the worker handed the core, per module
// (its entries, the outcome, when), queried by PC; nothing is kept while
// the harness hooks are off.
test("the region ledger: per module what was queued or why not, queried by PC, only with the harness on", async (t) => {
  const { worker } = await loadWorker(t);
  const heap = new Uint8Array(1 << 16);
  let top = 1024;
  const core = {
    HEAPU8: heap,
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    _DolphinWeb_AotLayoutHash: () => 0x1234,
    _DolphinWeb_AotQueueRegion: () => {}
  };
  const flow = { retranslate: async () => true };
  const region = (key, entries, layout) => ({ key, bytes: Uint8Array.of(0, 97, 115, 109), entries, layout, members: [{ ranges: [[0x80003100, 0x80003200]], hash: "0011223344556677" }] });
  await worker.queueAotRegionForTest(core, region("region-v1:off", [0x80003100], 0x1234), flow);
  assert.equal(worker.regionLedgerForTest([0x80003100]).modules, 0, "harness off: nothing kept");
  worker.setHarnessEnabledForTest(true);
  t.after(() => worker.setHarnessEnabledForTest(false));
  await worker.queueAotRegionForTest(core, region("region-v1:a", [0x80003100, 0x80003140], 0x1234), flow);
  await worker.queueAotRegionForTest(core, region("region-v1:b", [0x80003180], 0x9999), flow); // another layout
  const ledger = worker.regionLedgerForTest([0x80003140, 0x80003180, 0x80003300]);
  assert.deepEqual([ledger.modules, ledger.outcomes, ledger.queuedEntries], [2, { queued: 1, layout: 1 }, 2]);
  assert.deepEqual(ledger.pcs.map((p) => p.holders.map((h) => [h.key, h.outcome])), [[["region-v1:a", "queued"]], [["region-v1:b", "layout"]], []]);
  assert.ok(ledger.pcs[0].holders[0].ms <= ledger.nowMs, "when it was handed over");
  assert.equal(ledger.mappedRegions, null, "the core's own count: null without the export");
});

// The ledger's members re-hashed against the plan: one whose code changed
// (what drops a whole module at the core's re-verification) is listed, with
// whether the module holds code of it or only lists it.
test("the region ledger: members whose code no longer matches the plan are listed (translated or only listed)", async (t) => {
  const { worker } = await loadWorker(t);
  const { regionHash } = await import("../src/aot-plan.js");
  const heap = new Uint8Array(1 << 16);
  const RAM = 0x8000;
  let top = 1024;
  const core = {
    HEAPU8: heap,
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    _DolphinWeb_AotLayoutHash: () => 0x1234,
    _DolphinWeb_AotQueueRegion: () => {},
    _DolphinWeb_AotRegionHeapBases: (p) => new Uint32Array(heap.buffer, p, 2).set([RAM, 0])
  };
  const view = new DataView(heap.buffer);
  const word = (pc, w) => view.setUint32(RAM + (pc & 0x01ffffff), w, false);
  const read32 = (pc) => view.getUint32(RAM + (pc & 0x01ffffff), false);
  for (let pc = 0x80003100; pc < 0x80003140; pc += 4) word(pc, 0x38600000 + (pc & 0xff));
  const a = [[0x80003100, 0x80003120]], b = [[0x80003120, 0x80003140]];
  const members = [{ ranges: a, hash: regionHash(read32, a) }, { ranges: b, hash: regionHash(read32, b) }];
  worker.setHarnessEnabledForTest(true);
  t.after(() => worker.setHarnessEnabledForTest(false));
  // Its entries are in the first member only: the second was refused at translation.
  await worker.queueAotRegionForTest(core, { key: "region-v1:m", bytes: Uint8Array.of(0, 97, 115, 109), entries: [0x80003100], members, layout: 0x1234 }, { retranslate: async () => true });
  assert.deepEqual((await worker.regionLedgerStaleForTest(core)).staleCount, 0, "code as the plan saw it");
  word(0x80003124, 0x60000000); // the listed-only member's code changes
  const r = await worker.regionLedgerStaleForTest(core);
  assert.deepEqual([r.checked, r.staleModules], [2, 1]);
  assert.deepEqual(r.stale.map((x) => [x.key, x.member, x.start, x.translated]), [["region-v1:m", 1, 0x80003120, false]]);
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

// Review of #173: the worker's profile wiring with an engine disc key (a
// ':' in it). The recorder writes the profile, the probes see it, and the
// next plan build receives it. Reverting profileKey in the worker fails this.
function fakeOpfs() {
  const notFound = () => Object.assign(new Error("missing"), { name: "NotFoundError" });
  const dir = () => {
    const files = new Map(), dirs = new Map();
    return {
      async getDirectoryHandle(name, { create } = {}) {
        if (!dirs.has(name)) { if (!create) throw notFound(); dirs.set(name, dir()); }
        return dirs.get(name);
      },
      async getFileHandle(name, { create } = {}) {
        if (!files.has(name) && !create) throw notFound();
        if (!files.has(name)) files.set(name, new Uint8Array());
        return {
          getFile: async () => ({ size: files.get(name).length, arrayBuffer: async () => files.get(name).slice().buffer, text: async () => new TextDecoder().decode(files.get(name)) }),
          createWritable: async () => {
            let pending = new Uint8Array();
            return { write: async (b) => { pending = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b.buffer ?? b); }, close: async () => { files.set(name, pending); }, abort: async () => {} };
          }
        };
      },
      async removeEntry(name) { if (!files.delete(name)) throw notFound(); },
      async *entries() { for (const [n] of files) yield [n, null]; }
    };
  };
  return dir();
}

test("the local profile: an engine disc key records, the probes see it, the next plan build receives it", async (t) => {
  const { worker } = await loadWorker(t);
  worker.setAotFirstLaunchEnabledForTest(true);
  const opfs = fakeOpfs();
  const options = { module: fakeCore(), readDiscKey: async () => DISC, coreHash: CORE, cacheStorage: fakeCacheStorage(), storageRoot: () => opfs };
  await worker.prepareAotFirstLaunch({}, options);
  assert.ok(DISC.includes(":"), "an engine disc key");
  const saved = await worker.recordAotProfileForTest([[0x80003100, 5], [0x80003104, 2]]);
  assert.ok(saved, "recorded");
  const { profile } = await worker.handleAotMessage("validationReadAotProgress");
  assert.deepEqual([profile.opfs, profile.records, profile.writeFailures, profile.readFailures], [true, 1, 0, 0]);
  // The next plan build (the flow's start) loads it.
  await worker.startAotFirstLaunchAfterBoot();
  const planned = worker.aotPlanProfileReadForTest();
  assert.deepEqual(planned?.blocks.map((b) => [b[0], b[4]]), [[0x80003100, 5], [0x80003104, 2]], "the plan build got the weights");
  worker.setAotFirstLaunchEnabledForTest(false);
});

// P7 end to end on the JS side (src/aot-orchestrator.js): plan -> optimiser ->
// off-thread compile -> cache on the first launch; loader -> cache -> modules
// retained before the boot on the next. Real: plan, grouping, assembly,
// region keys, the region cache (in-memory CacheStorage), the loader. Stand-in:
// the core's translator, with the fragment contract of the P4 interface.
import assert from "node:assert/strict";
import test from "node:test";

import { openAotCache } from "../src/aot-cache.js";
import { imageFromDol } from "../src/aot-image.js";
import {
  AOT_PROGRESS_SCHEMA, aotFirstLaunchRequested, coreRegionTranslator, createAotFirstLaunch, parseHelperSignature, regionCacheIdentity
} from "../src/aot-orchestrator.js";
import { planDol } from "../src/aot-plan.js";
import { paddedUleb } from "../src/aot-region-module.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { fakeCacheStorage } from "./helpers/fake-cache-storage.mjs";

const TEXT = 0x80003100;
const BASE = "http://127.0.0.1:8090/";
const DISC = `disc-sha256-v1:${"2".repeat(64)}`;
const CORE = "b".repeat(64);
const KEY_PARTS = { compilerVersion: 3, codegenMask: 0x40 };
const PC = 0, COUNT = 4, STATE = 64, OUTSIDE = 0x80009000;
const ASSEMBLE = { helpers: {}, pcOffset: PC, memoryPages: 1 };

// An entry that calls 24 functions: with 4 functions a region, several regions.
function makePlan(n = 24) {
  const items = ["entry"];
  for (let i = 0; i < n; i++) items.push((pc, l) => asm.bl(pc, l[`f${i}`]));
  items.push(asm.blr());
  for (let i = 0; i < n; i++) {
    items.push(`f${i}`);
    for (let k = 0; k <= i % 5; k++) items.push(asm.li(3, i * 10 + k));
    items.push(asm.blr());
  }
  const t = assemble(TEXT, items);
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.entry }));
  return planDol({ image, entryPoint, options: { gapFill: false } });
}

function sleb(v) {
  const out = [];
  v |= 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

// Stand-in translator: each function becomes a fragment that counts its visit
// and leaves the region (state.pc = OUTSIDE, return_call to the exit stub).
// Records every entry it translates.
function standInTranslator({ refuse = new Set(), delayMs = 0 } = {}) {
  const translated = [];
  return {
    translated,
    async translate(batch) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return batch.map((f) => {
        if (refuse.has(f.entry)) return { entry: f.entry, reason: "untranslatable" };
        translated.push(f.entry);
        const get = [0x20, 0x00];
        const code = [0x00, ...get, ...get, 0x28, 0x02, COUNT, 0x41, 0x01, 0x6a, 0x36, 0x02, COUNT];
        code.push(...get, 0x41, ...sleb(OUTSIDE), 0x36, 0x02, PC, ...get, 0x12);
        const relocs = [{ offset: code.length, kind: "jump", targetPc: OUTSIDE }];
        code.push(...paddedUleb(0), 0x0b);
        return { entry: f.entry, fragment: { entry: f.entry, entries: [f.entry], code: Uint8Array.from(code), relocs } };
      });
    }
  };
}

// One "browser profile": its CacheStorage and plan store outlive a launch.
function profile() {
  const storage = fakeCacheStorage();
  const plans = new Map();
  const groups = new Map();
  const attempts = new Map();
  return {
    storage,
    planStore: {
      load: async (k) => plans.get(k) ?? null,
      save: async (k, p) => { plans.set(k, structuredClone(p)); },
      loadGroups: async (k) => groups.get(k) ?? null,
      saveGroups: async (k, g) => { groups.set(k, g); },
      loadAttempts: async (k) => attempts.get(k) ?? null,
      saveAttempts: async (k, a) => { attempts.set(k, structuredClone(a)); }
    }
  };
}

// One launch of the page with ?aot=1.
function launch(p, { translator = standInTranslator(), compile, plan = makePlan(), ...extra } = {}) {
  const retained = new Map();
  const compiled = [];
  let builds = 0;
  const flow = createAotFirstLaunch({
    discKey: DISC, coreHash: CORE, keyParts: KEY_PARTS, translator, assembleOptions: ASSEMBLE, maxFunctions: 4,
    openCache: (identity) => openAotCache({ ...identity, baseUrl: BASE, cacheStorage: p.storage, serviceWorker: false }),
    buildPlan: async () => { builds++; return plan; },
    planStore: p.planStore,
    // P5 stand-in: compile, and keep the Module alive as the discio worker does.
    compile: compile ?? (async (key, bytes) => {
      const module = await WebAssembly.compile(bytes);
      compiled.push(key);
      retained.set(key, module);
      return { module };
    }),
    retain: (key, module) => retained.set(key, module),
    ...extra
  });
  return { flow, retained, compiled, translator, builds: () => builds };
}

const ofType = (flow, type) => flow.progress().events.filter((e) => e.type === type);

function runs(module) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const instance = new WebAssembly.Instance(module, { env: { memory } });
  const u32 = new Uint32Array(memory.buffer);
  return (pc) => {
    u32[(STATE + PC) / 4] = pc;
    return [instance.exports.f(STATE), u32[(STATE + PC) / 4], u32[(STATE + COUNT) / 4]];
  };
}

test("aot=1 is the flag, off by default", () => {
  assert.equal(aotFirstLaunchRequested(""), false);
  assert.equal(aotFirstLaunchRequested("?aot=0"), false);
  assert.equal(aotFirstLaunchRequested("?video=wgpu&aot=1"), true);
});

test("first launch: plan -> optimiser -> off-thread compile -> cache, with progress; second launch installs everything before boot and recompiles 0 regions", async () => {
  const p = profile();
  const first = launch(p);
  // first launch: nothing to install, and the disc is not read before boot
  const install = await first.flow.installBeforeBoot();
  assert.equal(install.loaded, 0);
  assert.equal(first.builds(), 0, "no planning before the boot of a first launch");
  await first.flow.start();
  const total = first.flow.progress().events.find((e) => e.type === "start").total;
  assert.ok(total >= 6, `${total} regions`);
  const progress = ofType(first.flow, "progress");
  assert.ok(progress.every((e, i) => !i || e.fraction >= progress[i - 1].fraction), "monotonic");
  assert.ok(progress.every((e) => e.unit === "regions" && Number.isFinite(e.ms) && Number.isFinite(e.t) && e.total === total));
  assert.equal(progress.at(-1).fraction, 1);
  assert.equal(progress.at(-1).done, total);
  const [done] = ofType(first.flow, "done");
  assert.deepEqual([done.total, done.compiled, done.refused, done.deferred], [total, total, 0, 0]);
  assert.equal(first.compiled.length, total, "every region compiled off the CPU thread before it was stored");
  assert.equal(first.flow.progress().state, "complete");
  assert.equal(first.flow.progress().schema, AOT_PROGRESS_SCHEMA);

  // second launch (reload): the loader brings every region back before boot
  const second = launch(p);
  assert.deepEqual(await second.flow.status(), { state: "complete", fraction: 1 });
  const report = await second.flow.installBeforeBoot();
  assert.equal(report.loaded, total);
  assert.deepEqual(report.failed, []);
  assert.equal(second.retained.size, total);
  const [installed] = ofType(second.flow, "install");
  assert.equal(installed.loaded, total);
  // and the retained modules are the regions: every function runs from one
  const plan = makePlan();
  for (const f of plan.modules[0].functions) {
    const hits = [...second.retained.values()].map((m) => runs(m)(f.entry)).filter(([code]) => code === 0);
    assert.equal(hits.length, 1, `function ${f.entry.toString(16)} is in exactly one region`);
    assert.deepEqual(hits[0], [0, OUTSIDE, 1]);
  }
  // the optimisation of the second launch: 0 region recompiled
  await second.flow.start();
  assert.equal(second.translator.translated.length, 0, "nothing translated");
  assert.equal(second.compiled.length, 0, "nothing compiled");
  const [again] = ofType(second.flow, "done");
  assert.equal(again.compiled, 0);
  assert.equal(second.builds(), 0, "the plan came from the plan store");
});

test("interrupted in the middle of the first launch, the next launch resumes where it stopped", async () => {
  const p = profile();
  const first = launch(p, { translator: standInTranslator({ delayMs: 2 }), batchSize: 2 });
  let total = 0;
  const started = first.flow.start();
  // cancel (tab closed) once about 40 % is done
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const last = ofType(first.flow, "progress").at(-1);
      if (last && last.done / last.total >= 0.4) {
        total = last.total;
        first.flow.cancel();
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
  await started;
  assert.equal(ofType(first.flow, "done").length, 0, "no done after a cancel");
  const stopped = ofType(first.flow, "progress").at(-1);
  assert.ok(stopped.done < total, "interrupted before the end");
  const doneBefore = first.compiled.length;
  assert.ok(doneBefore >= 1);

  const second = launch(p);
  const status = await second.flow.status();
  assert.equal(status.state, "partial");
  assert.ok(status.fraction > 0 && status.fraction < 1);
  // the partial cache is installed before boot
  const report = await second.flow.installBeforeBoot();
  assert.ok(report.loaded >= doneBefore);
  await second.flow.start();
  const [start] = ofType(second.flow, "start");
  assert.equal(start.resumed, true);
  assert.ok(start.done >= doneBefore, "resumes near where it stopped");
  const [done] = ofType(second.flow, "done");
  assert.equal(done.compiled + start.done, total, "the regions already stored are not compiled again");
  // the regions stored by the first launch are not compiled again
  for (const key of first.compiled) assert.ok(!second.compiled.includes(key));
  assert.equal(ofType(second.flow, "progress").at(-1).fraction, 1);
  // third launch: complete, nothing left to do
  const third = launch(p);
  assert.deepEqual(await third.flow.status(), { state: "complete", fraction: 1 });
  assert.equal((await third.flow.installBeforeBoot()).loaded, total);
});

test("a region that fails goes to the blacklist and the optimisation goes on", async () => {
  const p = profile();
  let rejectKey = null;
  const first = launch(p, {
    compile: async (key, bytes) => {
      rejectKey ??= key; // the engine rejects the first region it sees
      if (key === rejectKey) return { reason: "compile" };
      return { module: await WebAssembly.compile(bytes) };
    }
  });
  await first.flow.start();
  const [done] = ofType(first.flow, "done");
  assert.equal(done.refused, 1);
  assert.equal(done.compiled, done.total - 1);
  const errors = ofType(first.flow, "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, false);
  assert.match(errors[0].message, /engine-reject/);
  // next launch: not installed, not retried, and the optimisation is complete
  const second = launch(p);
  const report = await second.flow.installBeforeBoot();
  assert.equal(report.loaded, done.total - 1);
  assert.ok(!second.retained.has(rejectKey));
  assert.deepEqual(await second.flow.status(), { state: "complete", fraction: 1 });
  await second.flow.start();
  assert.equal(second.translator.translated.length, 0);
});

test("an out-of-memory compile is no verdict: the region is retried at the next launch", async () => {
  const p = profile();
  let oomKey = null;
  const first = launch(p, {
    compile: async (key, bytes) => {
      oomKey ??= key;
      if (key === oomKey) return { reason: "oom" };
      return { module: await WebAssembly.compile(bytes) };
    }
  });
  await first.flow.start();
  const [done] = ofType(first.flow, "done");
  assert.deepEqual([done.refused, done.deferred], [0, 1]);
  assert.equal(first.flow.progress().state, "partial");
  const second = launch(p);
  await second.flow.start();
  assert.equal(ofType(second.flow, "done")[0].compiled, 1, "only that region");
});

test("without the core's translator the flow is unsupported and does nothing", async () => {
  const p = profile();
  const { flow } = launch(p, { translator: null });
  assert.equal(flow.supported, false);
  assert.deepEqual(await flow.status(), { state: "unsupported", fraction: 0 });
  assert.equal((await flow.installBeforeBoot()).loaded, 0);
  await flow.start();
  const read = flow.progress();
  assert.deepEqual([read.schema, read.state, read.disc, read.events], [AOT_PROGRESS_SCHEMA, "unsupported", DISC, []]);
  assert.deepEqual(regionCacheIdentity(KEY_PARTS), { compilerVersion: "region-3", flagsMask: 0x40 });
});

test("progress({ drain }) empties the event list for the next read", async () => {
  const p = profile();
  const { flow } = launch(p);
  await flow.start();
  assert.ok(flow.progress({ drain: true }).events.length > 2);
  assert.equal(flow.progress().events.length, 0);
});

// The core's export, on a stand-in module: layout, statuses, slices.
function fakeCore(results) {
  const heap = new Uint8Array(1 << 16);
  let top = 1024;
  const calls = [];
  const m = {
    HEAPU8: heap,
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    _DolphinWeb_AotTranslate(pc, mask, rangesPtr, rangeCount, maxBlocks, hashLo, hashHi) {
      calls.push({ pc, mask, ranges: Array.from(new Uint32Array(heap.buffer, rangesPtr, 2 * rangeCount)), maxBlocks, hashLo, hashHi });
      const r = results(pc);
      const out = 32768;
      const u32 = new Uint32Array(heap.buffer, out, 64);
      u32.fill(0);
      if (r === null) return 0;
      if (typeof r === "number") { u32[0] = r; return out; }
      u32.set([0, pc, r.code.length, r.entries.length, r.relocs.length, r.layout ?? 0]);
      u32.set(r.entries, 6);
      u32.set(r.relocs.flat(), 6 + r.entries.length);
      heap.set(r.code, out + 24 + 4 * (r.entries.length + 3 * r.relocs.length));
      return out;
    }
  };
  return { m, calls };
}

test("coreRegionTranslator reads the agreed layout of _DolphinWeb_AotTranslate", async () => {
  const { m, calls } = fakeCore((pc) => (pc === 0x80003000
    ? { entries: [0x80003000, 0x80003010], relocs: [[5, 0, 1], [11, 1, 0x80004000], [17, 2, 0]], code: [1, 2, 3, 4], layout: 0x5eed1234 }
    : pc === 0x80003100 ? 1 : pc === 0x80003200 ? 4 : null));
  const t = coreRegionTranslator(m, { mask: 0x40, helperNames: ["read_u32", "write_u32"], yieldNow: async () => {} });
  const batch = [
    { entry: 0x80003000, hash: "0123456789abcdef", ranges: [[0x80003000, 0x80003020]] },
    { entry: 0x80003100, hash: "0000000100000002", ranges: [[0x80003100, 0x80003104]] },
    { entry: 0x80003180, hash: null, ranges: [[0x80003180, 0x80003184]] },
    { entry: 0x80003200, hash: null, ranges: [[0x80003200, 0x80003204]] },
    { entry: 0x80003300, hash: null, ranges: [[0x80003300, 0x80003304]] }
  ];
  const out = await t.translate(batch);
  assert.deepEqual(out[0], {
    entry: 0x80003000,
    fragment: {
      entry: 0x80003000, entries: [0x80003000, 0x80003010], code: Uint8Array.from([1, 2, 3, 4]),
      relocs: [{ offset: 5, kind: "import", name: "write_u32" }, { offset: 11, kind: "jump", targetPc: 0x80004000 }, { offset: 17, kind: "dispatch" }],
      layout: 0x5eed1234 // the sixth word: the heap layout hash the code embeds
    }
  });
  assert.deepEqual(out.slice(1).map((r) => r.reason), ["hash-mismatch", "untranslatable", "not-ready"], "stops at not-ready");
  assert.deepEqual(calls[0], { pc: 0x80003000, mask: 0x40, ranges: [0x80003000, 0x80003020], maxBlocks: 64, hashLo: 0x89abcdef, hashHi: 0x01234567 });
  assert.equal(calls.length, 4);

  // a slice of time: the rest of the batch is "budget"
  let clock = 0;
  const sliced = coreRegionTranslator(m, { mask: 0, helperNames: [], sliceMs: 8, now: () => (clock += 10), yieldNow: async () => {} });
  const r = await sliced.translate(batch.slice(2));
  assert.deepEqual(r.map((x) => x.reason), ["untranslatable", "budget"]);
  assert.equal(coreRegionTranslator({}), null);
  assert.deepEqual(parseHelperSignature("f64,f64,f64,i32>f64"), { params: ["f64", "f64", "f64", "i32"], results: ["f64"] });
  assert.deepEqual(parseHelperSignature("i32,i32,i32>"), { params: ["i32", "i32", "i32"], results: [] });
});

// --- review of #38: the P1s ---

test("a cancel before the queued start wins; an explicit start after it runs", async () => {
  const p = profile();
  const { flow, translator } = launch(p);
  const generation = flow.generation;
  flow.cancel(); // aotCancel / stop before the post-boot start
  await flow.start({ resume: true, ifGeneration: generation });
  assert.equal(translator.translated.length, 0);
  assert.equal(ofType(flow, "start").length, 0);
  await flow.start({ resume: true }); // the site's aotOptimize afterwards
  assert.equal(ofType(flow, "done").length, 1);
  // a disposed flow (disc remounted) never runs again
  flow.dispose();
  await flow.start();
  assert.equal(ofType(flow, "start").length, 1);
});

test("a core that stays not-ready ends the run (bounded), the state is partial", async () => {
  const p = profile();
  let calls = 0;
  const translator = { async translate(batch) { calls++; return batch.map((f) => ({ entry: f.entry, reason: "not-ready" })); } };
  const { flow } = launch(p, { translator, tuning: { maxNotReadyWaits: 3, notReadyDelayMs: 0 } });
  await flow.start();
  assert.equal(calls, 4);
  assert.equal(ofType(flow, "done").length, 0);
  assert.match(ofType(flow, "error").at(-1).message, /not ready/);
  assert.equal(flow.progress().state, "partial");
});

test("one plan computation at a time; the boot never plans, even with a stale stored plan", async () => {
  const p = profile();
  let resolvePlan;
  let builds = 0;
  const gate = new Promise((r) => { resolvePlan = r; });
  const { flow } = launch(p, { buildPlan: async () => { builds++; await gate; return makePlan(); } });
  const pending = [flow.status(), flow.status(), flow.start()];
  resolvePlan();
  await Promise.all(pending);
  assert.equal(builds, 1);
  // a stored plan of another analyzer version: rebuilt after the boot, not before
  const stale = profile();
  await stale.planStore.save(DISC.replace(/[^0-9A-Za-z_-]/g, "_"), { ...makePlan(), analyzer: -1 });
  const next = launch(stale);
  const report = await next.flow.installBeforeBoot();
  assert.equal(report.firstLaunch, true);
  assert.equal(next.builds(), 0);
});

test("retries are bounded: a region with no verdict is blacklisted after 3 launches, and the state shows partial work", async () => {
  const p = profile();
  const mismatch = { async translate(batch) { return batch.map((f) => ({ entry: f.entry, reason: "hash-mismatch" })); } };
  const states = [];
  let refused = 0;
  for (let n = 0; n < 3; n++) {
    const { flow } = launch(p, { translator: mismatch });
    await flow.start();
    const [done] = ofType(flow, "done");
    states.push((await flow.status()).state);
    refused = done.refused;
    assert.equal(done.compiled, 0);
  }
  assert.deepEqual(states, ["partial", "partial", "complete"]);
  assert.ok(refused > 0, "blacklisted at the third launch");
  // the fourth launch has nothing left to try
  const last = launch(p, { translator: mismatch });
  await last.flow.start();
  assert.equal(ofType(last.flow, "done")[0].refused, refused);
  assert.equal(ofType(last.flow, "done")[0].deferred, 0);
});

test("resume: false compiles everything again", async () => {
  const p = profile();
  const first = launch(p);
  await first.flow.start();
  const again = launch(p);
  await again.flow.start({ resume: false });
  assert.equal(ofType(again.flow, "done")[0].compiled, first.compiled.length);
});

test("events carry the disc and the run; errors past the cap are counted, not recorded", async () => {
  const p = profile();
  const plan = makePlan();
  const refuse = new Set(plan.modules[0].functions.map((f) => f.entry));
  const { flow } = launch(p, { translator: standInTranslator({ refuse }), maxErrorEvents: 5, runId: "r1" });
  await flow.start();
  const events = flow.progress().events;
  assert.ok(events.every((e) => e.disc === DISC && e.run === "r1"));
  assert.equal(ofType(flow, "error").length, 5);
  assert.ok(ofType(flow, "done")[0].errorsDropped > 0);
  assert.equal(ofType(flow, "start").length, 1, "start is still there");
});

test("the boot loads at most maxBootBytes of region modules", async () => {
  const p = profile();
  await launch(p).flow.start();
  const capped = launch(p, { maxBootBytes: 1 });
  const report = await capped.flow.installBeforeBoot();
  assert.equal(report.loaded, 1, "the byte cap stops after the first module");
  assert.ok(report.overCap > 0);
});

test("planning runs in a worker of its own; its failure or silence rejects", async () => {
  const { planDiscInWorker } = await import("../src/aot-plan-worker.js");
  const fakeWorker = (reply) => () => {
    const w = { terminated: false, terminate() { w.terminated = true; }, postMessage(msg) { setTimeout(() => reply(w, msg), 0); } };
    return w;
  };
  const file = { name: "disc" };
  const plan = await planDiscInWorker(file, { createWorker: fakeWorker((w, msg) => w.onmessage({ data: { ok: true, plan: { got: msg.file === file } } })) });
  assert.deepEqual(plan, { got: true });
  await assert.rejects(planDiscInWorker(file, { createWorker: fakeWorker((w) => w.onmessage({ data: { ok: false, message: "bad DOL" } })) }), /bad DOL/);
  await assert.rejects(planDiscInWorker(file, { createWorker: fakeWorker(() => {}), timeoutMs: 5 }), /timed out/);
});

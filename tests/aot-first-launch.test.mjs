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
import { yieldToEventLoop } from "../src/aot-orchestrator.js";
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
    loadBeforeBoot: true, // the loader's budget and caps (the engine loads after the first image)
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
  // Modules handled before the cancel (stored); one that compiled during
  // the cancel is installed but not stored (no verdict), so it is not
  // counted (review of #144).
  const doneBefore = stopped.done;
  assert.ok(doneBefore >= 1);

  const second = launch(p);
  const status = await second.flow.status();
  assert.equal(status.state, "partial");
  assert.ok(status.fraction > 0 && status.fraction < 1);
  // the partial cache is installed before boot
  const report = await second.flow.installBeforeBoot();
  assert.ok(report.loaded >= doneBefore);
  const stored = new Set(second.retained.keys()); // what the first launch stored
  await second.flow.start();
  const [start] = ofType(second.flow, "start");
  assert.equal(start.resumed, true);
  assert.ok(start.done >= doneBefore, "resumes near where it stopped");
  const [done] = ofType(second.flow, "done");
  assert.equal(done.compiled + start.done, total, "the regions already stored are not compiled again");
  // the regions stored by the first launch are not compiled again; one that
  // compiled during the cancel was not stored, so it is retried (#144)
  for (const key of first.compiled) if (stored.has(key)) assert.ok(!second.compiled.includes(key));
  assert.ok(first.compiled.filter((key) => !stored.has(key)).length <= 1, "at most the module of the cancel");
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

// TTFF of a second launch (+0.8 s when the whole cache loaded before the
// boot): nothing loads before the boot, the cache after the first image, as a
// second "install" event. (A "boot set" of the modules whose code ran before
// the first image was tried: at region granularity it held all 143 modules
// of a commercial disc, and the first image came no sooner.)
test("a second launch loads nothing before the boot and the region cache after the first image", async () => {
  const p = profile();
  await launch(p).flow.start();
  const second = launch(p, { loadBeforeBoot: false });
  const report = await second.flow.installBeforeBoot();
  assert.equal(report.loaded, 0, "nothing before the boot");
  assert.equal(second.retained.size, 0);
  const total = report.deferred;
  assert.ok(total >= 6);
  const rest = await second.flow.loadRest();
  assert.equal(rest.loaded, total, "the whole cache after the first image");
  assert.equal(second.retained.size, total);
  const installs = ofType(second.flow, "install");
  assert.deepEqual(installs.map((e) => [e.loaded, e.after ?? null]), [[0, null], [total, "first-image"]]);
  await second.flow.start();
  assert.equal(second.compiled.length, 0, "0 region recompiled");
});

// Review of #62 (P1-3): a cached module the core refuses (translated for
// another heap layout) is translated again from guest memory after the boot,
// its cache entry overwritten and the new module installed; the next launch
// loads the new one. Once per key and launch, whether the refusal comes
// before the start after the boot or after the run.
test("a module refused at install is translated again live and its cache entry rewritten", async () => {
  const p = profile();
  await launch(p).flow.start();
  for (const when of ["before-start", "after-run"]) {
    const installs = [];
    const next = launch(p, { install: (r) => installs.push(r) });
    await next.flow.installBeforeBoot();
    installs.length = 0; // the cached modules, handed at load
    const key = [...next.retained.keys()][1];
    if (when === "after-run") {
      await next.flow.start();
      assert.equal(next.translator.translated.length, 0, "a second launch translates nothing");
    }
    assert.equal(await next.flow.retranslate(key), true);
    assert.equal(await next.flow.retranslate(key), false, "once per launch");
    if (when === "before-start") await next.flow.start();
    for (let i = 0; i < 100 && !installs.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(next.compiled, [key], `${when}: only that module, compiled again`);
    assert.ok(next.translator.translated.length > 0 && next.translator.translated.length <= 4);
    assert.deepEqual(installs.map((r) => r.key), [key], "handed to the core");
    assert.equal(next.flow.stats().retranslated, 1);
  }
  assert.equal(await launch(p).flow.retranslate("region-v1:unknown"), false, "no plan, nothing to do");
  const last = launch(p);
  assert.equal((await last.flow.installBeforeBoot()).failed.length, 0, "the rewritten entries load");
});

// Review of #72: a key marked after the run's last module but before its end
// (here, from the "done" event) gets one more run; and a key the core keeps
// refusing is translated again 3 launches at most.
test("a refusal at the end of the run gets one more run; retranslations stop after 3 launches", async () => {
  const p = profile();
  await launch(p).flow.start();
  let key = null;
  const installs = [];
  let flow;
  const late = launch(p, {
    install: (r) => installs.push(r.key),
    onEvent: (e) => { if (e.type === "done" && key && !late.asked) { late.asked = true; void flow.retranslate(key); } }
  });
  flow = late.flow;
  await flow.installBeforeBoot();
  installs.length = 0;
  key = [...late.retained.keys()][0];
  await flow.start();
  for (let i = 0; i < 100 && !installs.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(late.compiled, [key], "translated again by the second run");
  assert.deepEqual(installs, [key]);
  // that was launch 1 for this key: two more, then never
  for (const again of [true, true, false]) {
    const next = launch(p);
    await next.flow.installBeforeBoot();
    next.flow.retranslate(key); // before the start: counted when the run reads the attempts
    await next.flow.start();
    assert.deepEqual(next.compiled, again ? [key] : [], again ? "translated again" : "after 3 launches, left as it is");
  }
});

// Review of #86: before the boot the region cache is not even opened (its
// index read cost ~110 ms of the launch); everything happens in loadRest().
test("a second launch reads nothing of the region cache before the boot", async () => {
  const p = profile();
  await launch(p).flow.start();
  let opened = 0;
  const second = launch(p, {
    loadBeforeBoot: false,
    openCache: (identity) => { opened += 1; return openAotCache({ ...identity, baseUrl: BASE, cacheStorage: p.storage, serviceWorker: false }); }
  });
  await second.flow.installBeforeBoot();
  assert.equal(opened, 0, "no cache I/O before the boot");
  const rest = await second.flow.loadRest();
  assert.ok(opened > 0 && rest.loaded > 0, "the cache after the first image");
});

// Review of #86 (adversarial): another disc mounted before this one's first
// image disposes its flow; a stray wake-up must not load its whole cache
// (up to 192 MB) and queue it into the new disc's heap. A cancel (aotCancel)
// stops the deferred load the same way.
test("a disposed or cancelled second launch loads nothing of its deferred cache", async () => {
  const p = profile();
  await launch(p).flow.start();
  for (const stop of ["dispose", "cancel"]) {
    const second = launch(p, { loadBeforeBoot: false });
    const report = await second.flow.installBeforeBoot();
    assert.ok(report.deferred >= 6);
    second.flow[stop]();
    const rest = await second.flow.loadRest();
    assert.equal(rest.loaded, 0, `nothing loads after ${stop}()`);
    assert.equal(second.retained.size, 0, `nothing retained after ${stop}()`);
  }
  // Cancelled while loadRest reads the cache's index: nothing loads either.
  const third = launch(p, { loadBeforeBoot: false });
  await third.flow.installBeforeBoot();
  const rest = third.flow.loadRest();
  third.flow.dispose();
  assert.equal((await rest).loaded, 0);
  assert.equal(third.retained.size, 0);
});

// Research deep-first-minute: the translator yields through a MessageChannel,
// not a setTimeout(0) chain that the browser clamps to 4 ms after 5 levels.
test("the translator's yield is one event-loop turn, chained without the timer clamp", async () => {
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) await yieldToEventLoop();
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `200 chained yields in ${ms.toFixed(1)} ms (a clamped timer chain takes ≥ 800 ms in a browser)`);
});


test("?aotsample: the sampler's period in ms, 0 turns it off and no worker is created", async () => {
  const { aotSamplePeriodRequested, startHotSampler, AOT_SAMPLE_DEFAULT_MS } = await import("../src/aot-hot-sampler.js");
  assert.equal(aotSamplePeriodRequested(""), AOT_SAMPLE_DEFAULT_MS);
  assert.equal(aotSamplePeriodRequested("?aot=1&aotsample=0"), 0);
  assert.equal(aotSamplePeriodRequested("?aotsample=25"), 25);
  assert.equal(aotSamplePeriodRequested("?aotsample=99999"), 1000, "capped");
  for (const bad of ["?aotsample=", "?aotsample=-1", "?aotsample=off", "?aotsample=2.5"]) assert.equal(aotSamplePeriodRequested(bad), AOT_SAMPLE_DEFAULT_MS, bad);
  let created = 0;
  const createWorker = () => { created++; return { postMessage() {}, terminate() {} }; };
  assert.equal(startHotSampler({ buffer: new SharedArrayBuffer(16), pcAddress: 8, periodMs: 0, createWorker }), null);
  assert.equal(created, 0, "?aotsample=0: no worker");
  const on = startHotSampler({ buffer: new SharedArrayBuffer(16), pcAddress: 8, periodMs: 25, createWorker });
  assert.equal(created, 1);
  on.stop();
});

test("the profile sampler needs a shared heap and a PC address; it drains what it counted since the last drain, and blocks while paused", async () => {
  const { startHotSampler } = await import("../src/aot-hot-sampler.js");
  assert.equal(startHotSampler({ buffer: new ArrayBuffer(16), pcAddress: 8 }), null);
  assert.equal(startHotSampler({ buffer: new SharedArrayBuffer(16), pcAddress: 0 }), null);
  // A stand-in worker: what it posts is counted, drained once.
  let worker, ctl;
  const sampler = startHotSampler({ buffer: new SharedArrayBuffer(16), pcAddress: 8, createWorker: () => (worker = { postMessage(m) { ctl = new Int32Array(m.ctl); }, terminate() {} }) });
  worker.onmessage({ data: [[0x80003100, 3], [0x80003104, 1]] });
  worker.onmessage({ data: [[0x80003100, 2]] });
  assert.deepEqual(sampler.drain(), [[0x80003100, 5], [0x80003104, 1]]);
  assert.deepEqual(sampler.drain(), []);
  sampler.pause();
  assert.equal(Atomics.load(ctl, 1), 1, "paused: the worker blocks on this word");
  sampler.resume();
  assert.equal(Atomics.load(ctl, 1), 0);
  sampler.stop();
  assert.equal(Atomics.load(ctl, 0), 1);
});

// Review of #165: two records in flight (a remount during the minute's
// record) count the session once; a failed first record does not use it up.
test("the profile recorder counts a session once, whatever the records in flight", async () => {
  const { createProfileRecorder } = await import("../src/aot-hot-sampler.js");
  const { blocksFromPcSamples } = await import("../src/aot-profile.js");
  const calls = [];
  let fail = true;
  const store = { record: async (key, blocks, { newSession }) => { await new Promise((r) => setTimeout(r, 5)); if (fail) { fail = false; throw new Error("quota"); } calls.push(newSession); return {}; } };
  const record = createProfileRecorder({ store, discKey: "disc", blocksFromPcSamples });
  assert.equal(await record([[0x80003100, 1]]), null, "the first record failed");
  await Promise.all([record([[0x80003100, 1]]), record([[0x80003104, 1]])]);
  assert.deepEqual(calls, [true, false], "one new session, then additions");
  assert.equal(await record([]), null, "nothing to record");
});

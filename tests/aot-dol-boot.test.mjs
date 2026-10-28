// ?aot=1 on a booted .dol (no disc: a homebrew, the CI bench's workloads):
// its own key namespace (dol-sha256-v1, the file's SHA-256), a plan of the
// .dol alone, and the disc path unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { readDiscKeyFromFile, readDolKeyFromFile } from "../src/aot-cache.js";
import { planDolFile, fileReader } from "../src/aot-recomp.js";
import { AOT_DOL_KEY_SCHEMA, aotCacheIdentity, canonicalDiscKey, canonicalDolKey, discKeyHex } from "../src/jit-cache-identity.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { fakeCacheStorage } from "./helpers/fake-cache-storage.mjs";

const TEXT = 0x80003100;
const CORE = "c".repeat(64);

// A small program: an entry calling two functions.
function program() {
  const t = assemble(TEXT, [
    "entry", (pc, l) => asm.bl(pc, l.f), (pc, l) => asm.bl(pc, l.g), asm.blr(),
    "f", asm.li(3, 1), asm.addi(3, 3, 2), asm.blr(),
    "g", asm.li(4, 7), asm.cmplwi(4, 7), (pc, l) => asm.beq(pc, l.g_out), asm.addi(4, 4, 1), "g_out", asm.blr()
  ]);
  return { t, dol: buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.entry }) };
}

test("a .dol's key: dol-sha256-v1 and the file's SHA-256, never a disc key, accepted by the cache identity", async () => {
  const { dol } = program();
  const key = await canonicalDolKey(dol);
  assert.equal(key, `${AOT_DOL_KEY_SCHEMA}:${createHash("sha256").update(dol).digest("hex")}`);
  assert.equal(await readDolKeyFromFile(new Blob([dol])), key);
  assert.equal(discKeyHex(key), key.slice(key.indexOf(":") + 1));
  const identity = aotCacheIdentity({ discKey: key, coreHash: CORE, compilerVersion: "25", flagsMask: 0 });
  assert.equal(identity.discKey, key);
  // The disc path is unchanged: a disc key keeps its schema and its hex.
  const disc = await canonicalDiscKey({ header: new Uint8Array(0x440), dol, fst: new Uint8Array(0) });
  assert.match(disc, /^disc-sha256-v1:[0-9a-f]{64}$/);
  assert.equal(discKeyHex(disc), disc.slice("disc-sha256-v1:".length));
  assert.notEqual(discKeyHex(disc), discKeyHex(key), "the same DOL bytes never give the same key in both namespaces");
  assert.throws(() => aotCacheIdentity({ discKey: "dol-sha256-v1:any", coreHash: CORE, compilerVersion: "25", flagsMask: 0 }), /disc key/);
});

test("each key reader refuses the other kind", async () => {
  const { dol } = program();
  assert.equal(await readDiscKeyFromFile(new Blob([dol])), null, "a .dol has no disc key (the disc path is unchanged)");
  assert.equal(await readDolKeyFromFile(new Blob([new Uint8Array(0x80)])), null, "too small");
  assert.equal(await readDolKeyFromFile({ size: (32 << 20) + 1, slice() { throw new Error("never read"); } }), null, "bigger than a DOL may be");
});

test("planDolFile: the plan of a .dol alone finds its functions, with a disc plan's identity fields", async () => {
  const { t, dol } = program();
  const plan = await planDolFile(fileReader(new Blob([dol])), dol.length);
  const entries = plan.modules.flatMap((m) => m.functions.map((f) => f.entry));
  for (const label of ["entry", "f", "g"]) assert.ok(entries.includes(t.labels[label]), `${label} found`);
  assert.deepEqual(Object.keys(plan.identity).sort(), ["apploaderHash", "dolHash", "hintsHash", "profileHash", "rels"]);
  assert.deepEqual([plan.identity.apploaderHash, plan.identity.rels, plan.identity.hintsHash], [null, [], null]);
});

test("the boots that get aot=1: a disc as before (a full boot image), a .dol, nothing else", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const { aotBootKind } = await import(`${new URL("../src/upstream-discio-worker.js", import.meta.url).href}?aot-kind-test=${Date.now()}`);
  assert.equal(aotBootKind("disc", 1459978240), "disc");
  assert.equal(aotBootKind("disc", 16 << 20), "disc");
  assert.equal(aotBootKind("disc", (16 << 20) - 1), null, "a disc too small to boot: none, as before");
  assert.equal(aotBootKind("dol", 0x400), "dol", "a .dol, whatever its size");
  for (const kind of ["elf", "dff"]) assert.equal(aotBootKind(kind, 64 << 20), null, kind);
});

test("the worker: a booted .dol goes through the same flow (its key, its plan, the regions translated)", async (t) => {
  const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const worker = await import(`${workerUrl.href}?aot-dol-test=${Date.now()}`);
  const { dol } = program();
  const file = new Blob([dol]);
  const key = await canonicalDolKey(dol);
  let translations = 0;
  const heap = new Uint8Array(1 << 16);
  let top = 1024;
  const names = new Map();
  const str = (text) => {
    if (!names.has(text)) { heap.set(new TextEncoder().encode(`${text}\0`), top); names.set(text, top); top += (text.length + 8) & ~7; }
    return names.get(text);
  };
  const core = {
    HEAPU8: heap,
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    UTF8ToString: (p) => new TextDecoder().decode(heap.subarray(p, heap.indexOf(0, p))),
    _DolphinWeb_AotKeyParts: (p) => new Uint32Array(heap.buffer, p, 2).set([7, 0]),
    _DolphinWeb_JitHelperName: (i) => (i === 0 ? str("read_u32") : 0),
    _DolphinWeb_JitHelperSignature: (i) => (i === 0 ? str("i32,i32>i32") : 0),
    _DolphinWeb_JitStateLayout: (p) => new Uint32Array(heap.buffer, p, 4).set([0, 4, 8, 1]),
    _DolphinWeb_AotTranslate() { translations++; return 0; }
  };
  worker.setAotFirstLaunchEnabledForTest(true);
  await worker.prepareAotFirstLaunch(file, { kind: "dol", module: core, readDiscKey: () => readDolKeyFromFile(file), coreHash: CORE, cacheStorage: fakeCacheStorage(), storageRoot: () => null });
  assert.equal((await worker.handleAotMessage("validationReadAotProgress")).disc, key, "keyed in the dol namespace");
  await worker.startAotFirstLaunchAfterBoot();
  assert.ok(translations >= 3, `the .dol's functions went to the translator (${translations})`);
  worker.setAotFirstLaunchEnabledForTest(false);
});

// Review of #192: the real path, no injected key reader. The worker reads
// the key from the mounted file by kind (readDolKeyFromFile for a .dol),
// and the plan worker (installAotPlannerWorker, wired in-process) gets
// kind "dol" and plans the .dol alone. A disc mount still reads a disc key.
test("the worker's real path: the dol key read from the mounted file, kind \"dol\" to the plan worker", async (t) => {
  const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const worker = await import(`${workerUrl.href}?aot-dol-real=${Date.now()}`);
  const { installAotPlannerWorker } = await import("../src/aot-plan-worker.js");
  // A plan worker in-process: the real handler, the messages it got.
  const received = [];
  const createWorker = () => {
    const w = { onmessage: null, onerror: null, terminate() {} };
    const scope = { onmessage: null, postMessage: (data) => queueMicrotask(() => w.onmessage?.({ data })) };
    installAotPlannerWorker(scope);
    w.postMessage = (data) => { received.push(data); queueMicrotask(() => scope.onmessage({ data })); };
    return w;
  };
  const { dol } = program();
  const file = new Blob([dol]);
  let translations = 0;
  const heap = new Uint8Array(1 << 16);
  let top = 1024;
  const names = new Map();
  const str = (text) => {
    if (!names.has(text)) { heap.set(new TextEncoder().encode(`${text}\0`), top); names.set(text, top); top += (text.length + 8) & ~7; }
    return names.get(text);
  };
  const core = {
    HEAPU8: heap,
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    UTF8ToString: (p) => new TextDecoder().decode(heap.subarray(p, heap.indexOf(0, p))),
    _DolphinWeb_AotKeyParts: (p) => new Uint32Array(heap.buffer, p, 2).set([7, 0]),
    _DolphinWeb_JitHelperName: (i) => (i === 0 ? str("read_u32") : 0),
    _DolphinWeb_JitHelperSignature: (i) => (i === 0 ? str("i32,i32>i32") : 0),
    _DolphinWeb_JitStateLayout: (p) => new Uint32Array(heap.buffer, p, 4).set([0, 4, 8, 1]),
    _DolphinWeb_AotTranslate() { translations++; return 0; }
  };
  worker.setAotFirstLaunchEnabledForTest(true);
  worker.setAotPlannerWorkerForTest(createWorker);
  t.after(() => worker.setAotPlannerWorkerForTest(null));
  // A disc mount reads a disc key: the .dol's bytes give none.
  worker.setAotMountedFileForTest(file, "disc");
  await worker.prepareAotFirstLaunch(file, { kind: "disc", module: core, coreHash: CORE, cacheStorage: fakeCacheStorage(), storageRoot: () => null });
  assert.equal((await worker.handleAotMessage("validationReadAotProgress")).disc ?? null, null, "no disc key from a .dol");
  // A .dol mount: its key from the file, its plan from the plan worker.
  worker.setAotMountedFileForTest(file, "dol");
  await worker.prepareAotFirstLaunch(file, { kind: "dol", module: core, coreHash: CORE, cacheStorage: fakeCacheStorage(), storageRoot: () => null });
  assert.equal((await worker.handleAotMessage("validationReadAotProgress")).disc, await canonicalDolKey(dol), "read from the mounted file");
  await worker.startAotFirstLaunchAfterBoot();
  assert.deepEqual(received.map((m) => m.kind), ["dol"], "the plan worker got kind dol");
  assert.ok(translations >= 3, `the plan worker's plan reached the translator (${translations})`);
  worker.setAotFirstLaunchEnabledForTest(false);
});

// Review of #323: a remote disc (src/remote-disc.js) reaches the plan worker
// as its descriptor. The fake worker clones what it is posted, as a real
// one does: a Blob-like with functions would throw DataCloneError there.
test("a remote .dol: the descriptor clones to the plan worker, which reads its ranges", async (t) => {
  const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
  const originalSelf = globalThis.self;
  const originalXhr = globalThis.XMLHttpRequest;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  const { dol } = program();
  const url = "http://127.0.0.1:8303/disc/p.dol";
  let ranges = 0;
  globalThis.XMLHttpRequest = class {
    open(method, u) { assert.equal(u, url); }
    setRequestHeader(k, v) { this.range = v; }
    getResponseHeader(k) { return k === "Content-Range" ? this.contentRange : null; }
    send() {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range).map(Number);
      ranges++;
      this.status = 206;
      this.contentRange = `bytes ${a}-${b}/${dol.length}`;
      this.response = dol.slice(a, b + 1).buffer;
    }
  };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf;
    if (originalXhr === undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest = originalXhr;
  });
  const worker = await import(`${workerUrl.href}?aot-remote-dol=${Date.now()}`);
  const { installAotPlannerWorker } = await import("../src/aot-plan-worker.js");
  const received = [];
  const createWorker = () => {
    const w = { onmessage: null, onerror: null, terminate() {} };
    const scope = { onmessage: null, postMessage: (data) => queueMicrotask(() => w.onmessage?.({ data })) };
    installAotPlannerWorker(scope);
    w.postMessage = (data) => { const copy = structuredClone(data); received.push(copy); queueMicrotask(() => scope.onmessage({ data: copy })); };
    return w;
  };
  const heap = new Uint8Array(1 << 16);
  let top = 1024, translations = 0;
  const names = new Map();
  const str = (text) => {
    if (!names.has(text)) { heap.set(new TextEncoder().encode(`${text}\0`), top); names.set(text, top); top += (text.length + 8) & ~7; }
    return names.get(text);
  };
  const core = {
    HEAPU8: heap,
    _malloc: (n) => { const p = top; top += (n + 7) & ~7; return p; },
    _free: () => {},
    UTF8ToString: (p) => new TextDecoder().decode(heap.subarray(p, heap.indexOf(0, p))),
    _DolphinWeb_AotKeyParts: (p) => new Uint32Array(heap.buffer, p, 2).set([7, 0]),
    _DolphinWeb_JitHelperName: (i) => (i === 0 ? str("read_u32") : 0),
    _DolphinWeb_JitHelperSignature: (i) => (i === 0 ? str("i32,i32>i32") : 0),
    _DolphinWeb_JitStateLayout: (p) => new Uint32Array(heap.buffer, p, 4).set([0, 4, 8, 1]),
    _DolphinWeb_AotTranslate() { translations++; return 0; }
  };
  const desc = { remoteDisc: url, name: "p.dol", size: dol.length };
  worker.setAotFirstLaunchEnabledForTest(true);
  worker.setAotPlannerWorkerForTest(createWorker);
  t.after(() => { worker.setAotPlannerWorkerForTest(null); worker.setAotFirstLaunchEnabledForTest(false); });
  worker.setAotMountedFileForTest(desc, "dol");
  await worker.prepareAotFirstLaunch(desc, { kind: "dol", module: core, coreHash: CORE, cacheStorage: fakeCacheStorage(), storageRoot: () => null });
  assert.equal((await worker.handleAotMessage("validationReadAotProgress")).disc, await canonicalDolKey(dol), "the key read by ranges");
  await worker.startAotFirstLaunchAfterBoot();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].file, desc, "the plan worker got the descriptor");
  assert.ok(ranges > 0 && translations >= 3, `${ranges} ranges read, ${translations} translations`);
});

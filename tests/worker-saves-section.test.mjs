// The worker's saves section, run for real against an in-memory FS and a
// fake core: each test is one scenario from the PR #8 review.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { createCoreLifecycle } from "../src/core-lifecycle.js";
import * as memcard from "../src/memcard.js";
import * as store from "../src/user-data-store.js";
import { makeStateFile, tinyStateFile } from "./helpers/save-state-fixture.mjs";

const source = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
const begin = source.indexOf("// Saves: /dolphin-user kept in OPFS");
const end = source.indexOf("async function mountFile(file) {");
assert.ok(begin > 0 && end > begin, "saves section markers");
const section = source.slice(begin, end);

// Emscripten's FS, the subset the section uses.
function memfs() {
  const nodes = new Map([["/", { dir: true }]]);
  let clock = 1;
  const parent = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
  const fail = (code) => Object.assign(new Error(code), { code });
  return {
    nodes,
    mkdir(path) {
      if (nodes.has(path)) throw fail("EEXIST");
      if (!nodes.get(parent(path))?.dir) throw fail("ENOENT");
      nodes.set(path, { dir: true });
    },
    readdir(path) {
      if (!nodes.get(path)?.dir) throw fail("ENOENT");
      const prefix = path === "/" ? "/" : `${path}/`;
      return [".", "..", ...[...nodes.keys()]
        .filter((p) => p.startsWith(prefix) && p !== path && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length))];
    },
    stat(path) {
      const node = nodes.get(path);
      if (!node) throw fail("ENOENT");
      return { mode: node.dir ? 1 : 2, size: node.data?.byteLength ?? 4096, mtime: new Date(node.mtime ?? 0) };
    },
    isDir: (mode) => mode === 1,
    isFile: (mode) => mode === 2,
    analyzePath: (path) => ({ exists: nodes.has(path) }),
    readFile(path) {
      if (!nodes.get(path)?.data) throw fail("ENOENT");
      return nodes.get(path).data.slice();
    },
    writeFile(path, data) {
      if (!nodes.get(parent(path))?.dir) throw fail("ENOENT");
      nodes.set(path, { data: new Uint8Array(data), mtime: clock++ });
    },
    rename(from, to) {
      if (!nodes.has(from)) throw fail("ENOENT");
      nodes.set(to, nodes.get(from));
      nodes.delete(from);
    },
    unlink(path) {
      if (!nodes.has(path)) throw fail("ENOENT");
      nodes.delete(path);
    }
  };
}

function memoryPrimitives() {
  const files = new Map();
  const faults = { failWrites: false, damage: null };
  return {
    files,
    faults,
    list: async () => [...files.keys()],
    read: async (name) => (files.has(name) ? files.get(name).slice() : null),
    write: async (name, bytes) => {
      if (faults.failWrites) throw Object.assign(new Error("QuotaExceededError: the quota has been exceeded"), { name: "QuotaExceededError" });
      files.set(name, bytes.slice());
    },
    move: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    remove: async (name) => {
      files.delete(name);
    }
  };
}

const GAME = { kind: "disc", gameId: "GTST01", region: "NTSC-U" };
const CARD = "/dolphin-user/GC/USA/Card A";

function gci({ name = "save", blocks = 1, fill = 1, game = "GTST" } = {}) {
  const bytes = new Uint8Array(0x40 + blocks * 0x2000).fill(fill);
  bytes.fill(0xff, 0, 0x40);
  bytes.set(new TextEncoder().encode(game), 0);
  bytes.set(new TextEncoder().encode("01"), 4);
  bytes.fill(0, 8, 40);
  bytes.set(new TextEncoder().encode(name), 8);
  bytes[0x36] = 0;
  bytes[0x37] = 0;
  bytes[0x38] = 0;
  bytes[0x39] = blocks;
  return bytes;
}

// A valid state for game `gameId`, told apart by `marker`.
const stateFile = (gameId = "GTST01", marker = [9, 8, 7, 6, 5]) => makeStateFile({ gameId, marker: marker.length < 5 ? [...marker, 0] : marker });

async function worker({ primitives = memoryPrimitives(), lockGranted = true, booted = true, core = {} } = {}) {
  const fs = memfs();
  const statuses = [];
  let generation = 0;
  let nextState = stateFile();
  const fakeCore = {
    getCoreStateName: () => "Running",
    flushMemoryCards: () => 1,
    // SaveToFileSync: the file appears whole a little later.
    saveStateFile: (path) => {
      setTimeout(() => fs.writeFile(path, nextState), 5);
      return 1;
    },
    loadStateFile: () => 1,
    ...core
  };
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    setTimeout: (fn) => setTimeout(fn, 1),
    setInterval: () => 0,
    Date,
    Math,
    Map,
    Set,
    Error,
    String,
    Number,
    Uint8Array,
    Promise,
    USER_DATA_ROOT: store.USER_DATA_ROOT,
    acquireWriterLock: async () => ({ granted: lockGranted, reason: lockGranted ? "" : "another tab is already playing with these saves" }),
    createRecordStore: store.createRecordStore,
    createUserDataMirror: (options) => store.createUserDataMirror({ ...options, sleep: async () => {} }),
    openOpfsPrimitives: async () => primitives,
    createCoreLifecycle,
    ...memcard,
    memcardSaveIdentity: memcard.saveIdentity,
    moduleInstance: { FS: fs },
    api: fakeCore,
    coreBoot: { accepted: booted },
    ppcWasmJitTimingSuspensions: 0,
    ppcWasmJitCorePaused: false,
    resetPpcWasmJitTiming() {},
    postStatus: (message) => statuses.push(message),
    readLastLoadedCheckpoint: () => ({ generation }),
    // The real loadStateFile path, reduced to what the section relies on.
    handleMessage: async (type, payload) => {
      assert.equal(type, "loadStateFile");
      const accepted = fakeCore.loadStateFile(payload.fsPath);
      if (accepted && !fakeCore.rejectLoad) generation += 1;
      return { loaded: accepted === 1, rc: accepted };
    }
  });
  vm.runInContext(
    `${section}
     globalThis.__saves = {
       handleSavesMessage, startUserDataPersistence, ensureUserDataReady, saveStateToSlot, flushUserData,
       coreLifecycle, status: () => ({ ...userDataStatus }),
       boot: (game) => { bootedGame = game; }
     };`,
    context
  );
  const saves = context.__saves;
  saves.boot(GAME);
  return { saves, fs, primitives, statuses, core: fakeCore, setNextState: (bytes) => { nextState = bytes; } };
}

const storedNames = (primitives) => [...primitives.files.keys()].map(decodeURIComponent).sort();

test("P1 single writer: a second tab restores read-only and never writes", async () => {
  const primitives = memoryPrimitives();
  const first = await worker({ primitives });
  await first.saves.startUserDataPersistence();
  await first.saves.handleSavesMessage("importMemcard", { bytes: gci({ name: "one" }) });
  const before = new Map(primitives.files);

  const second = await worker({ primitives, lockGranted: false });
  const status = await second.saves.startUserDataPersistence();
  assert.equal(status.mode, "read-only");
  assert.match(status.reason, /another tab/);
  assert.ok(second.fs.nodes.has(`${CARD}/01-GTST-one.gci`), "the read-only tab still sees the save");
  const saved = await second.saves.saveStateToSlot(1);
  assert.equal(saved.saved, true);
  assert.equal(saved.persisted.persistent, false, "the slot is not reported as stored");
  assert.deepEqual(new Map(primitives.files), before, "nothing written by the second tab");
});

test("P1 restore: a damaged stored save stops the boot instead of starting on a partial card", async () => {
  const primitives = memoryPrimitives();
  const seed = await worker({ primitives });
  await seed.saves.startUserDataPersistence();
  await seed.saves.handleSavesMessage("importMemcard", { bytes: gci({ name: "one" }) });
  await seed.saves.handleSavesMessage("importMemcard", { bytes: gci({ name: "two" }) });
  const victim = [...primitives.files.keys()].find((n) => decodeURIComponent(n).endsWith("two.gci"));
  primitives.files.get(victim)[100] ^= 1;

  const tab = await worker({ primitives, booted: false });
  const status = await tab.saves.startUserDataPersistence();
  assert.equal(status.mode, "failed");
  assert.equal([...tab.fs.nodes.keys()].some((p) => p.endsWith(".gci")), false, "no partial card in MEMFS");
  await assert.rejects(tab.saves.ensureUserDataReady(), /could not be restored.*was not started/s);
  assert.ok(tab.statuses.some((m) => /could not be restored/.test(m)), "the user is told");
});

test("P1 fresh copy: the core's cards are flushed before every copy", async () => {
  const flushes = [];
  const tab = await worker({ core: { flushMemoryCards: () => { flushes.push("flush"); return 1; } } });
  await tab.saves.startUserDataPersistence();
  await tab.saves.flushUserData();
  assert.deepEqual(flushes, ["flush"]);
});

test("P1 .sav import: an invalid state never touches the slot", async () => {
  const tab = await worker();
  await tab.saves.startUserDataPersistence();
  const good = await tab.saves.saveStateToSlot(2);
  const slot = "/dolphin-user/StateSaves/GTST01.s02";
  const before = tab.fs.readFile(slot);
  const stored = new Map(tab.primitives.files);

  // The review's 49 bytes: right game and version, a one-byte payload.
  const tiny = tinyStateFile();
  assert.equal(tiny.byteLength, 49);
  for (const options of [{ slot: 2 }, { slot: 2, load: false }, { slot: 2, load: false, replace: true }, { slot: 3, load: false }]) {
    await assert.rejects(
      tab.saves.handleSavesMessage("importSaveState", { bytes: tiny, ...options }),
      /too small to hold the console's 24 MiB/,
      JSON.stringify(options)
    );
  }
  // A well-formed state the core has not loaded never replaces a saved one.
  await assert.rejects(
    tab.saves.handleSavesMessage("importSaveState", { bytes: stateFile("GTST01", [2, 2, 2, 2, 2]), slot: 2, load: false, replace: true }),
    /slot 2 is in use\. A state replaces a saved one only once the core has loaded it/
  );
  // It may fill an empty slot.
  const unloaded = await tab.saves.handleSavesMessage("importSaveState", { bytes: stateFile("GTST01", [2, 2, 2, 2, 2]), slot: 4, load: false });
  assert.equal(unloaded.loaded, false);
  assert.ok(tab.fs.nodes.has("/dolphin-user/StateSaves/GTST01.s04"));
  const storedNow = new Map(tab.primitives.files);
  // Valid structure, but the core does not load it.
  tab.core.rejectLoad = true;
  await assert.rejects(
    tab.saves.handleSavesMessage("importSaveState", { bytes: stateFile("GTST01", [1, 1, 1, 1]), slot: 2 }),
    /did not load the save state.*slot 2 is unchanged/
  );
  assert.equal(good.saved, true);
  assert.deepEqual(tab.fs.readFile(slot), before);
  assert.deepEqual(new Map(tab.primitives.files), storedNow);
  assert.ok(stored.size < storedNow.size, "only the empty slot was added");
  assert.equal([...tab.fs.nodes.keys()].some((p) => p.includes("/.staging/") && !p.endsWith(".staging")), false, "staging cleaned");

  tab.core.rejectLoad = false;
  const loaded = await tab.saves.handleSavesMessage("importSaveState", { bytes: stateFile("GTST01", [1, 1, 1, 1]), slot: 2 });
  assert.equal(loaded.loaded, true);
  assert.deepEqual(tab.fs.readFile(slot), stateFile("GTST01", [1, 1, 1, 1]));
});

test("P1 .raw import: an oversized or looping card is refused before any allocation", async () => {
  const tab = await worker();
  await tab.saves.startUserDataPersistence();
  await assert.rejects(
    tab.saves.handleSavesMessage("importMemcard", { bytes: new Uint8Array(memcard.MAX_CARD_BYTES + 0x2000) }),
    /more than/
  );
  assert.equal([...tab.fs.nodes.keys()].some((p) => p.endsWith(".gci")), false);
});

test("P1 GCI names: distinct saves never share a file, and replacing is never silent", async () => {
  const tab = await worker();
  await tab.saves.startUserDataPersistence();
  const a = await tab.saves.handleSavesMessage("importMemcard", { bytes: gci({ name: "a/b", fill: 1 }) });
  const b = await tab.saves.handleSavesMessage("importMemcard", { bytes: gci({ name: "a:b", fill: 2 }) });
  assert.notEqual(a.imported[0], b.imported[0]);
  assert.equal(tab.fs.readFile(`${CARD}/${a.imported[0]}`)[0x40], 1);
  assert.equal(tab.fs.readFile(`${CARD}/${b.imported[0]}`)[0x40], 2);

  await assert.rejects(
    tab.saves.handleSavesMessage("importMemcard", { bytes: gci({ name: "a/b", fill: 3 }) }),
    /Already on card A: GTST "a\/b"\. Nothing was imported/
  );
  const replaced = await tab.saves.handleSavesMessage("importMemcard", { bytes: gci({ name: "a/b", fill: 3 }), replace: true });
  assert.deepEqual([...replaced.replaced], [a.imported[0]]);
  assert.equal(tab.fs.readFile(`${CARD}/${a.imported[0]}`)[0x40], 3);
  assert.equal(tab.fs.readFile(`${CARD}/${b.imported[0]}`)[0x40], 2, "the other save is untouched");
  assert.equal(storedNames(tab.primitives).filter((n) => n.endsWith(".gci")).length, 2);
});

test("P2 full quota: stop still stops, and the failure is shown", async () => {
  const primitives = memoryPrimitives();
  let state = "Running";
  const tab = await worker({
    primitives,
    core: {
      getCoreStateName: () => state,
      stopCore: () => {
        state = "Uninitialized";
      }
    }
  });
  await tab.saves.startUserDataPersistence();
  await tab.saves.saveStateToSlot(1);
  tab.fs.writeFile("/dolphin-user/StateSaves/GTST01.s01", stateFile("GTST01", [5, 5, 5, 5]));
  primitives.faults.failWrites = true;
  const result = await tab.saves.coreLifecycle.stop();
  assert.equal(result.state, "Uninitialized");
  assert.match(result.persistError, /quota/);
});

test("P2 Saved only once written and stored: a failed copy says so", async () => {
  const primitives = memoryPrimitives();
  const tab = await worker({ primitives });
  await tab.saves.startUserDataPersistence();
  const ok = await tab.saves.saveStateToSlot(1);
  assert.equal(ok.persisted.persistent, true);
  assert.ok(storedNames(primitives).includes("StateSaves/GTST01.s01"));

  primitives.faults.failWrites = true;
  tab.setNextState(stateFile("GTST01", [4, 4, 4, 4]));
  const notStored = await tab.saves.saveStateToSlot(1);
  assert.equal(notStored.saved, true);
  assert.equal(notStored.persisted.persistent, false);
  assert.match(notStored.persisted.error, /quota/);
  assert.ok(tab.statuses.some((m) => /session only, not stored/.test(m)));

  // A state the core never finishes writing is an error, not "saved".
  primitives.faults.failWrites = false;
  tab.setNextState(stateFile().subarray(0, 40));
  await assert.rejects(tab.saves.saveStateToSlot(3), /save state/i);
  assert.equal(tab.fs.nodes.has("/dolphin-user/StateSaves/GTST01.s03"), false);
});

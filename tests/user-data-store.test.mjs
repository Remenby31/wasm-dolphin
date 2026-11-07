import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireWriterLock,
  createRecordStore,
  createUserDataMirror,
  decodeRecord,
  encodeRecord,
  gciLooksComplete,
  isPersistentUserPath,
  recordName,
  RestoreError
} from "../src/user-data-store.js";

// In-memory primitives. `failWriteAfter` tears the next write after that
// many bytes and throws, like a tab closed in the middle of it; `failMove`
// throws before the move, like a tab closed between write and move.
function memoryPrimitives() {
  const files = new Map();
  const faults = { failWriteAfter: null, failMove: false, failReads: 0, corruptNextWrite: false };
  return {
    files,
    faults,
    async list() {
      return [...files.keys()];
    },
    async read(name) {
      if (faults.failReads > 0) {
        faults.failReads -= 1;
        throw Object.assign(new Error("file is open in another tab"), { name: "NoModificationAllowedError" });
      }
      return files.has(name) ? files.get(name).slice() : null;
    },
    async write(name, bytes) {
      if (faults.failWriteAfter !== null) {
        files.set(name, bytes.slice(0, faults.failWriteAfter));
        faults.failWriteAfter = null;
        throw new Error("tab closed during write");
      }
      const copy = bytes.slice();
      if (faults.corruptNextWrite) {
        faults.corruptNextWrite = false;
        copy[copy.length - 1] ^= 0xff;
      }
      files.set(name, copy);
    },
    async move(from, to) {
      if (faults.failMove) {
        faults.failMove = false;
        throw new Error("tab closed before move");
      }
      if (!files.has(from)) return;
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(name) {
      files.delete(name);
    }
  };
}

const bytes = (...values) => new Uint8Array(values);

// The subset of Emscripten's FS the mirror uses.
function memfs() {
  const nodes = new Map([["/", { dir: true }]]);
  let clock = 1;
  const parent = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
  const fs = {
    nodes,
    mkdir(path) {
      if (nodes.has(path)) throw new Error("EEXIST");
      if (!nodes.get(parent(path))?.dir) throw new Error("ENOENT");
      nodes.set(path, { dir: true });
    },
    readdir(path) {
      if (!nodes.get(path)?.dir) throw new Error("ENOENT");
      const prefix = path === "/" ? "/" : `${path}/`;
      return [".", "..", ...[...nodes.keys()]
        .filter((p) => p.startsWith(prefix) && p !== path && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length))];
    },
    stat(path) {
      const node = nodes.get(path);
      if (!node) throw new Error("ENOENT");
      return { mode: node.dir ? 1 : 2, size: node.data?.byteLength ?? 4096, mtime: new Date(node.mtime ?? 0) };
    },
    isDir: (mode) => mode === 1,
    isFile: (mode) => mode === 2,
    readFile(path) {
      return nodes.get(path).data.slice();
    },
    writeFile(path, data) {
      if (!nodes.get(parent(path))?.dir) throw new Error("ENOENT");
      nodes.set(path, { data: new Uint8Array(data), mtime: clock++ });
    },
    unlink(path) {
      nodes.delete(path);
    },
    mkdirTree(path) {
      let cur = "";
      for (const part of path.split("/").filter(Boolean)) {
        cur += `/${part}`;
        if (!nodes.has(cur)) nodes.set(cur, { dir: true });
      }
    }
  };
  return fs;
}

function gci(blocks, fill = 0xab) {
  const data = new Uint8Array(0x40 + blocks * 0x2000).fill(fill);
  data[0x38] = 0;
  data[0x39] = blocks;
  return data;
}

const nextNames = (prim) => [...prim.files.keys()].filter((n) => n.includes(".next-"));

test("a record round-trips and any damage makes it unreadable", async () => {
  const record = await encodeRecord(7, bytes(1, 2, 3));
  assert.deepEqual(await decodeRecord(record), { generation: 7, payload: bytes(1, 2, 3) });
  const flipped = record.slice();
  flipped[flipped.length - 1] ^= 1;
  assert.equal(await decodeRecord(flipped), null);
  assert.equal(await decodeRecord(record.slice(0, record.length - 1)), null);
  assert.equal(await decodeRecord(bytes(1, 2, 3)), null);
});

test("a write torn by a closed tab leaves the previous version readable", async () => {
  const prim = memoryPrimitives();
  const store = createRecordStore(prim);
  await store.save("card", bytes(1, 1, 1));
  prim.faults.failWriteAfter = 30;
  await assert.rejects(store.save("card", bytes(2, 2, 2)), /tab closed during write/);

  const reopened = createRecordStore(prim);
  assert.deepEqual(await reopened.load("card"), bytes(1, 1, 1));
  assert.deepEqual(nextNames(prim), [], "the torn record is dropped");
  await reopened.save("card", bytes(3));
  assert.deepEqual(await createRecordStore(prim).load("card"), bytes(3));
});

test("a complete write interrupted before its move wins on the next load", async () => {
  const prim = memoryPrimitives();
  const store = createRecordStore(prim);
  await store.save("card", bytes(1));
  prim.faults.failMove = true;
  await assert.rejects(store.save("card", bytes(2)), /before move/);

  const reopened = createRecordStore(prim);
  assert.deepEqual(await reopened.keys(), ["card"]);
  assert.deepEqual(await reopened.load("card"), bytes(2));
  assert.deepEqual([...prim.files.keys()], ["card"], "the pending version was promoted");
  assert.equal(await reopened.save("card", bytes(4)), 3);
});

test("a save is only reported once the copy read back matches", async () => {
  const prim = memoryPrimitives();
  const store = createRecordStore(prim);
  await store.save("card", bytes(1));
  prim.faults.corruptNextWrite = true;
  await assert.rejects(store.save("card", bytes(2)), /read back does not match/);
  assert.deepEqual(await createRecordStore(prim).load("card"), bytes(1));
  assert.deepEqual(nextNames(prim), []);
});

test("concurrent writers never share a staging name", async () => {
  const prim = memoryPrimitives();
  let counter = 0;
  const a = createRecordStore(prim, { nonce: () => `a${counter++}` });
  const b = createRecordStore(prim, { nonce: () => `b${counter++}` });
  prim.faults.failMove = true;
  await assert.rejects(a.save("card", bytes(1)), /before move/);
  prim.faults.failMove = true;
  await assert.rejects(b.save("card", bytes(2)), /before move/);
  assert.equal(nextNames(prim).length, 2, "both pending records exist side by side");
});

test("only one tab gets the writer lock; the other is told why", async () => {
  // The Web Locks semantics this relies on: exclusive, ifAvailable.
  const held = new Set();
  const locks = {
    async request(name, options, callback) {
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      if (held.has(name)) return callback(null);
      held.add(name);
      return callback({ name });
    }
  };
  assert.deepEqual(await acquireWriterLock(locks), { granted: true, reason: "" });
  const second = await acquireWriterLock(locks);
  assert.equal(second.granted, false);
  assert.match(second.reason, /another tab/);
  assert.equal((await acquireWriterLock({})).granted, false);
});

test("a read-only store reads the best record and writes nothing", async () => {
  const prim = memoryPrimitives();
  await createRecordStore(prim).save("card", bytes(1));
  prim.faults.failMove = true;
  await assert.rejects(createRecordStore(prim).save("card", bytes(2)), /before move/);
  const before = [...prim.files.keys()].sort();
  const reader = createRecordStore(prim, { readOnly: true });
  assert.deepEqual(await reader.load("card"), bytes(2));
  assert.deepEqual([...prim.files.keys()].sort(), before);
  await assert.rejects(reader.save("card", bytes(3)), /read-only/);
  await assert.rejects(reader.remove("card"), /read-only/);
});

test("stored entries without a valid copy are an error, not an empty card", async () => {
  const prim = memoryPrimitives();
  await createRecordStore(prim).save("card", bytes(1));
  prim.files.get("card")[48] ^= 1;
  await assert.rejects(createRecordStore(prim).load("card"), /no valid copy among 1 stored/);
});

test("only Dolphin's temporaries and backups are left out", () => {
  assert.equal(isPersistentUserPath("StateSaves/GXXE01.s01"), true);
  assert.equal(isPersistentUserPath("StateSaves/GXXE01.s01.tmp4242"), false);
  assert.equal(isPersistentUserPath("StateSaves/lastState.sav"), false);
  assert.equal(isPersistentUserPath("StateSaves/.staging-1.sav"), false);
  assert.equal(isPersistentUserPath("GC/USA/Card A/01-GM4E-save.gci"), true);
  assert.equal(gciLooksComplete(gci(2)), true);
  assert.equal(gciLooksComplete(gci(2).subarray(0, 0x40 + 0x2000)), false);
});

function setupTree() {
  const fs = memfs();
  fs.mkdirTree("/dolphin-user/GC/USA/Card A");
  fs.mkdirTree("/dolphin-user/StateSaves");
  fs.mkdirTree("/dolphin-user/Cache");
  return fs;
}

test("without a native flush the mirror waits for stable files, skips torn GCIs, drops deleted ones", async () => {
  const prim = memoryPrimitives();
  const fs = setupTree();
  const mirror = createUserDataMirror({ fs, store: createRecordStore(prim) });

  const cardPath = "/dolphin-user/GC/USA/Card A/01-GTST-save.gci";
  fs.writeFile(cardPath, gci(1, 1).subarray(0, 0x40)); // header only: torn
  fs.writeFile("/dolphin-user/Cache/shader.bin", bytes(9));
  fs.writeFile("/dolphin-user/StateSaves/GTST01.s01.tmp7", bytes(5));

  assert.equal(await mirror.sync(), 0, "first sight of a file never copies it");
  assert.equal(await mirror.sync(), 0, "a torn GCI is not copied even once stable");
  assert.equal(mirror.stats.skippedTorn, 1);

  fs.writeFile(cardPath, gci(1, 1));
  fs.writeFile("/dolphin-user/StateSaves/GTST01.s01", bytes(7, 7));
  await mirror.sync();
  assert.equal(await mirror.sync(), 2);
  assert.deepEqual(
    (await createRecordStore(prim).keys()).map(decodeURIComponent),
    ["GC/USA/Card A/01-GTST-save.gci", "StateSaves/GTST01.s01"]
  );

  fs.unlink("/dolphin-user/StateSaves/GTST01.s01");
  fs.writeFile(cardPath, gci(1, 2));
  assert.equal(await mirror.flush(), 2, "flush copies a change without waiting for a second scan");
  assert.equal(prim.files.has(recordName("Cache/shader.bin")), false);
});

test("the core's cards are flushed before each copy, so a save just made is copied at once", async () => {
  const prim = memoryPrimitives();
  const fs = setupTree();
  const cardPath = "/dolphin-user/GC/USA/Card A/01-GTST-save.gci";
  let pending = gci(1, 5);
  const calls = [];
  const mirror = createUserDataMirror({
    fs,
    store: createRecordStore(prim),
    // Dolphin's FlushToFile: what the game wrote reaches MEMFS only now.
    flushNative: () => {
      calls.push("flush");
      if (pending) fs.writeFile(cardPath, pending);
      pending = null;
      return 1;
    }
  });
  assert.equal(await mirror.sync(), 1, "copied on first sight: the flush made it whole");
  assert.deepEqual(calls, ["flush"]);
  assert.equal(mirror.stats.nativeFlushes, 1);
  const stored = await createRecordStore(prim).load(recordName("GC/USA/Card A/01-GTST-save.gci"));
  assert.deepEqual(stored, gci(1, 5));
});

test("a restore with one damaged file restores nothing", async () => {
  const prim = memoryPrimitives();
  const store = createRecordStore(prim);
  await store.save(recordName("GC/USA/Card A/a.gci"), gci(1, 1));
  await store.save(recordName("GC/USA/Card A/b.gci"), gci(1, 2));
  prim.files.get(recordName("GC/USA/Card A/b.gci"))[100] ^= 1;
  const fs = memfs();
  const mirror = createUserDataMirror({ fs, store: createRecordStore(prim), sleep: async () => {} });
  await assert.rejects(mirror.restore(), (error) => error instanceof RestoreError && /b\.gci: no valid copy/.test(error.message));
  assert.equal([...fs.nodes.keys()].some((p) => p.endsWith(".gci")), false, "no file was written into MEMFS");
});

test("a restore retries a file the writer tab holds open, then restores everything", async () => {
  const prim = memoryPrimitives();
  const store = createRecordStore(prim);
  await store.save(recordName("GC/USA/Card A/a.gci"), gci(1, 1));
  await store.save(recordName("StateSaves/A.s01"), bytes(1, 2));
  prim.faults.failReads = 2;
  const fs = memfs();
  const restored = await createUserDataMirror({ fs, store: createRecordStore(prim, { readOnly: true }), sleep: async () => {} }).restore();
  assert.deepEqual(restored, { restored: 2, bytes: 0x40 + 0x2000 + 2 });
  assert.deepEqual(fs.readFile("/dolphin-user/GC/USA/Card A/a.gci"), gci(1, 1));
});

test("a read-only mirror restores but never copies", async () => {
  const prim = memoryPrimitives();
  const fs = setupTree();
  const mirror = createUserDataMirror({ fs, store: createRecordStore(prim, { readOnly: true }), flushNative: () => 1 });
  fs.writeFile("/dolphin-user/StateSaves/A.s01", bytes(1));
  assert.equal(await mirror.flush(), 0);
  assert.equal(prim.files.size, 0);
});

test("a failed copy is reported to its caller and the next one still runs", async () => {
  const prim = memoryPrimitives();
  const fs = setupTree();
  const mirror = createUserDataMirror({ fs, store: createRecordStore(prim) });
  fs.writeFile("/dolphin-user/StateSaves/A.s01", bytes(1));
  prim.write = async () => {
    throw Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" });
  };
  await assert.rejects(mirror.flush(), /quota exceeded/);
  assert.match(mirror.stats.lastError, /quota exceeded/);
  delete prim.write;
});

test("a restored tree is not written back until it changes", async () => {
  const prim = memoryPrimitives();
  const store = createRecordStore(prim);
  await store.save(recordName("StateSaves/A.s01"), bytes(1, 2));
  const fs = memfs();
  const mirror = createUserDataMirror({ fs, store: createRecordStore(prim) });
  await mirror.restore();
  assert.equal(await mirror.flush(), 0);
  assert.equal(await mirror.sync(), 0);
});

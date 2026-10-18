import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordStore,
  createUserDataMirror,
  decodeRecord,
  encodeRecord,
  gciLooksComplete,
  isPersistentUserPath,
  NEXT_SUFFIX,
  recordName
} from "../src/user-data-store.js";

// In-memory primitives. `failWriteAfter` tears the next write after that
// many bytes and throws, like a tab closed in the middle of it; `failMove`
// throws before the move, like a tab closed between write and move.
function memoryPrimitives() {
  const files = new Map();
  const faults = { failWriteAfter: null, failMove: false };
  return {
    files,
    faults,
    async list() {
      return [...files.keys()];
    },
    async read(name) {
      return files.has(name) ? files.get(name).slice() : null;
    },
    async write(name, bytes) {
      if (faults.failWriteAfter !== null) {
        files.set(name, bytes.slice(0, faults.failWriteAfter));
        faults.failWriteAfter = null;
        throw new Error("tab closed during write");
      }
      files.set(name, bytes.slice());
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
  assert.equal(prim.files.has("card" + NEXT_SUFFIX), false, "the torn record is dropped");
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
  // Generations keep growing from the promoted record.
  assert.equal(await reopened.save("card", bytes(4)), 3);
});

test("only Dolphin's temporaries and backups are left out", () => {
  assert.equal(isPersistentUserPath("StateSaves/GM4E01.s01"), true);
  assert.equal(isPersistentUserPath("StateSaves/GM4E01.s01.tmp4242"), false);
  assert.equal(isPersistentUserPath("StateSaves/lastState.sav"), false);
  assert.equal(isPersistentUserPath("GC/USA/Card A/01-GM4E-save.gci"), true);
  assert.equal(gciLooksComplete(gci(2)), true);
  assert.equal(gciLooksComplete(gci(2).subarray(0, 0x40 + 0x2000)), false);
});

test("the mirror copies stable files, skips torn GCIs, drops deleted ones and restores them all", async () => {
  const prim = memoryPrimitives();
  const fs = memfs();
  fs.mkdirTree("/dolphin-user/GC/USA/Card A");
  fs.mkdirTree("/dolphin-user/StateSaves");
  fs.mkdirTree("/dolphin-user/Cache");
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

  const fresh = memfs();
  const restored = await createUserDataMirror({ fs: fresh, store: createRecordStore(prim) }).restore();
  assert.deepEqual(restored, { restored: 1, bytes: 0x40 + 0x2000 });
  assert.deepEqual(fresh.readFile(cardPath), gci(1, 2));
  assert.equal(fresh.nodes.has("/dolphin-user/StateSaves/GTST01.s01"), false);
  assert.equal(prim.files.has(recordName("Cache/shader.bin")), false);
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

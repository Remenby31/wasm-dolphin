// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Keeps Dolphin's user directory (/dolphin-user, a MEMFS tree inside the
// core) across page reloads. The tree stays in MEMFS, where every pthread
// reaches it through Emscripten's proxied syscalls; this module copies the
// parts worth keeping (memory cards, save states) to the Origin Private File
// System and puts them back before the next boot.
//
// Crash safety. Each file is stored as a record: a header with a generation
// number, the payload length and its SHA-256, then the payload. A new
// version is written in full to "<name>.next", flushed, and only then moved
// over "<name>". Reading takes the valid record with the highest
// generation among the two names. If the tab dies while "<name>.next" is
// being written, its hash does not match and the previous version wins; if
// it dies after the write but before the move, the complete new version
// wins. A card is never read back half written.
//
// Torn sources. Dolphin writes a GCI save with several write() calls from
// its flush thread, so a scan can land between two of them. A file is only
// copied once two consecutive scans saw the same size and mtime, and a GCI
// file must also be as long as its own directory entry says.

export const USER_DATA_ROOT = "/dolphin-user";
export const USER_DATA_INCLUDE = Object.freeze(["GC", "StateSaves"]);
export const RECORD_MAGIC = "SLNUSR01";
export const RECORD_HEADER_BYTES = 48;
export const NEXT_SUFFIX = ".next";

const MAGIC_BYTES = new TextEncoder().encode(RECORD_MAGIC);
const GCI_HEADER_BYTES = 0x40;
const GCI_BLOCK_BYTES = 0x2000;

export async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

export async function encodeRecord(generation, payload) {
  const record = new Uint8Array(RECORD_HEADER_BYTES + payload.byteLength);
  const view = new DataView(record.buffer);
  record.set(MAGIC_BYTES, 0);
  view.setUint32(8, generation >>> 0, true);
  view.setUint32(12, payload.byteLength >>> 0, true);
  record.set(await sha256(payload), 16);
  record.set(payload, RECORD_HEADER_BYTES);
  return record;
}

// The payload and generation of a record, or null when it is truncated,
// foreign or does not match its hash.
export async function decodeRecord(record) {
  if (!record || record.byteLength < RECORD_HEADER_BYTES) return null;
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (record[i] !== MAGIC_BYTES[i]) return null;
  }
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const generation = view.getUint32(8, true);
  const length = view.getUint32(12, true);
  if (record.byteLength !== RECORD_HEADER_BYTES + length) return null;
  const payload = record.subarray(RECORD_HEADER_BYTES);
  const digest = await sha256(payload);
  for (let i = 0; i < 32; i += 1) {
    if (digest[i] !== record[16 + i]) return null;
  }
  return { generation, payload };
}

// Flat names: OPFS entries cannot contain "/".
export function recordName(path) {
  return encodeURIComponent(path);
}

export function pathFromRecordName(name) {
  return decodeURIComponent(name);
}

// Records on top of five primitives: list() -> names, read(name) -> bytes
// or null, write(name, bytes) (durable when it resolves), move(from, to)
// (replaces `to`), remove(name). The OPFS implementation is below; tests use
// one in memory that can fail half way.
export function createRecordStore(primitives) {
  const generations = new Map();

  async function readBest(name) {
    const [current, next] = await Promise.all([
      primitives.read(name).then(decodeRecord),
      primitives.read(name + NEXT_SUFFIX).then(decodeRecord)
    ]);
    if (next && (!current || next.generation > current.generation)) {
      return { ...next, from: "next" };
    }
    return current ? { ...current, from: "current" } : null;
  }

  return {
    async keys() {
      const names = new Set();
      for (const name of await primitives.list()) {
        names.add(name.endsWith(NEXT_SUFFIX) ? name.slice(0, -NEXT_SUFFIX.length) : name);
      }
      return [...names].sort();
    },

    async load(name) {
      const best = await readBest(name);
      if (!best) {
        generations.delete(name);
        return null;
      }
      generations.set(name, best.generation);
      // Finish an interrupted save, or drop a torn one, so the next write
      // starts from a single valid record.
      if (best.from === "next") {
        await primitives.move(name + NEXT_SUFFIX, name);
      } else {
        await primitives.remove(name + NEXT_SUFFIX);
      }
      return best.payload;
    },

    async save(name, payload) {
      let generation = generations.get(name);
      if (generation === undefined) generation = (await readBest(name))?.generation ?? 0;
      generation += 1;
      await primitives.write(name + NEXT_SUFFIX, await encodeRecord(generation, payload));
      await primitives.move(name + NEXT_SUFFIX, name);
      generations.set(name, generation);
      return generation;
    },

    async remove(name) {
      await primitives.remove(name);
      await primitives.remove(name + NEXT_SUFFIX);
      generations.delete(name);
    }
  };
}

// OPFS primitives with synchronous access handles, which only exist in a
// dedicated worker: write -> truncate, write, flush, close.
export async function openOpfsPrimitives(directoryName = "dolphin-user-v1") {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== "function") {
    throw new Error("Origin Private File System is unavailable in this context");
  }
  const root = await storage.getDirectory();
  const dir = await root.getDirectoryHandle(directoryName, { create: true });

  async function fileHandle(name, create) {
    try {
      return await dir.getFileHandle(name, { create });
    } catch (error) {
      if (!create && error?.name === "NotFoundError") return null;
      throw error;
    }
  }

  return {
    async list() {
      const names = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "file") names.push(name);
      }
      return names;
    },
    async read(name) {
      const handle = await fileHandle(name, false);
      if (!handle) return null;
      const access = await handle.createSyncAccessHandle();
      try {
        const bytes = new Uint8Array(access.getSize());
        access.read(bytes, { at: 0 });
        return bytes;
      } finally {
        access.close();
      }
    },
    async write(name, bytes) {
      const handle = await fileHandle(name, true);
      const access = await handle.createSyncAccessHandle();
      try {
        access.truncate(0);
        let written = 0;
        while (written < bytes.byteLength) {
          written += access.write(bytes.subarray(written), { at: written });
        }
        access.flush();
      } finally {
        access.close();
      }
    },
    async move(from, to) {
      const handle = await fileHandle(from, false);
      if (!handle) return;
      try {
        await handle.move(dir, to);
      } catch (error) {
        // Older engines refuse to move onto an existing entry. The record
        // stays readable under `from` until the move lands, so removing
        // `to` first loses nothing.
        if (error?.name !== "InvalidModificationError" && error?.name !== "NoModificationAllowedError") {
          throw error;
        }
        await dir.removeEntry(to).catch(() => {});
        await handle.move(dir, to);
      }
    },
    async remove(name) {
      await dir.removeEntry(name).catch((error) => {
        if (error?.name !== "NotFoundError") throw error;
      });
    }
  };
}

// Dolphin's own temporaries and backups, never worth a copy: save-state
// temp files ("x.s01.tmp1234"), the undo backup, DTM movies.
export function isPersistentUserPath(relativePath) {
  const base = relativePath.split("/").pop() ?? "";
  if (/\.tmp\d*$/.test(base)) return false;
  if (base.startsWith("lastState.sav")) return false;
  if (base.endsWith(".dtm")) return false;
  return true;
}

// A GCI file is complete when it holds the blocks its entry announces.
export function gciLooksComplete(bytes) {
  if (bytes.byteLength < GCI_HEADER_BYTES) return false;
  const blockCount = (bytes[0x38] << 8) | bytes[0x39];
  return bytes.byteLength === GCI_HEADER_BYTES + blockCount * GCI_BLOCK_BYTES;
}

export function createUserDataMirror({
  fs,
  store,
  root = USER_DATA_ROOT,
  include = USER_DATA_INCLUDE,
  log = () => {}
}) {
  // Persisted signature per relative path: size and mtime of the MEMFS file
  // the stored record was taken from.
  const persisted = new Map();
  // What the previous scan saw, to require two identical scans in a row.
  let previousScan = new Map();
  let chain = Promise.resolve();
  const stats = { restored: 0, written: 0, removed: 0, skippedTorn: 0, bytesWritten: 0, lastError: "" };

  function mkdirTree(dir) {
    let current = "";
    for (const part of dir.split("/").filter(Boolean)) {
      current += `/${part}`;
      try {
        fs.mkdir(current);
      } catch {
        // Already there.
      }
    }
  }

  function walk(relativeDir, out) {
    let entries;
    try {
      entries = fs.readdir(`${root}/${relativeDir}`);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "." || entry === "..") continue;
      const relative = `${relativeDir}/${entry}`;
      const stat = fs.stat(`${root}/${relative}`);
      if (fs.isDir(stat.mode)) {
        walk(relative, out);
      } else if (fs.isFile(stat.mode) && isPersistentUserPath(relative)) {
        out.set(relative, `${stat.size}:${stat.mtime instanceof Date ? stat.mtime.getTime() : stat.mtime}`);
      }
    }
  }

  function scan() {
    const seen = new Map();
    for (const dir of include) walk(dir, seen);
    return seen;
  }

  async function persist({ force }) {
    const current = scan();
    let changed = 0;
    for (const [relative, signature] of current) {
      if (persisted.get(relative) === signature) continue;
      if (!force && previousScan.get(relative) !== signature) continue;
      const bytes = fs.readFile(`${root}/${relative}`);
      if (relative.toLowerCase().endsWith(".gci") && !gciLooksComplete(bytes)) {
        stats.skippedTorn += 1;
        continue;
      }
      await store.save(recordName(relative), bytes);
      persisted.set(relative, signature);
      stats.written += 1;
      stats.bytesWritten += bytes.byteLength;
      changed += 1;
    }
    for (const relative of [...persisted.keys()]) {
      if (current.has(relative)) continue;
      await store.remove(recordName(relative));
      persisted.delete(relative);
      stats.removed += 1;
      changed += 1;
    }
    previousScan = current;
    return changed;
  }

  function serialized(task) {
    const run = chain.then(task, task);
    chain = run.catch((error) => {
      stats.lastError = String(error?.message || error);
      log(`[user-data] ${stats.lastError}`);
    });
    return run;
  }

  return {
    stats,
    // Copy every stored file back into MEMFS. Call before the core boots:
    // Dolphin reads the GCI folder once, when the memory card is inserted.
    restore: () =>
      serialized(async () => {
        let restored = 0;
        let bytes = 0;
        for (const name of await store.keys()) {
          const relative = pathFromRecordName(name);
          if (!include.some((dir) => relative.startsWith(`${dir}/`)) || !isPersistentUserPath(relative)) {
            continue;
          }
          const payload = await store.load(name);
          if (!payload) continue;
          const path = `${root}/${relative}`;
          mkdirTree(path.slice(0, path.lastIndexOf("/")));
          fs.writeFile(path, payload);
          restored += 1;
          bytes += payload.byteLength;
        }
        const now = scan();
        for (const [relative, signature] of now) persisted.set(relative, signature);
        previousScan = now;
        stats.restored = restored;
        return { restored, bytes };
      }),
    // Periodic: copy files that stopped changing, drop deleted ones.
    sync: () => serialized(() => persist({ force: false })),
    // Before pause/stop/hide: copy everything that differs now.
    flush: () => serialized(() => persist({ force: true })),
    list() {
      return [...scan().keys()].sort();
    }
  };
}

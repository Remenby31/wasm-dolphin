// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Keeps Dolphin's user directory (/dolphin-user, a MEMFS tree inside the
// core) across page reloads. The tree stays in MEMFS, where every pthread
// reaches it through Emscripten's proxied syscalls; this module copies the
// parts worth keeping (memory cards, save states) to the Origin Private File
// System and puts them back before the next boot.
//
// One writer. Every tab of the origin shares one OPFS directory, so the
// worker that holds the Web Lock WRITER_LOCK_NAME is the only one that
// writes. A second tab restores the saves and plays, read-only, and says so.
//
// Crash safety. Each file is stored as a record: a header with a generation
// number, the payload length and its SHA-256, then the payload. A new
// version is written in full under a fresh "<name>.next-<nonce>", read back
// and checked, and only then moved over "<name>". Reading takes the valid
// record with the highest generation among "<name>" and its ".next-*"
// siblings. A tab closed during the write leaves a record that fails its
// hash and loses to the previous version; closed between write and move, it
// leaves a complete record that wins. A card is never read back half
// written.
//
// All or nothing. A restore reads and checks every stored file before it
// writes any of them into MEMFS: a file that exists but has no valid copy
// fails the whole restore, so a game never boots on a card with saves
// missing (it would treat them as absent and could overwrite them).
//
// Fresh copies. Before each copy the core is asked to write its memory
// cards out (FlushMemoryCards); without that, a save the game has just made
// reaches MEMFS only when Dolphin's flush thread gets to it, up to a second
// later. A core without the export falls back to copying a file once two
// consecutive scans saw the same size and mtime.

export const USER_DATA_ROOT = "/dolphin-user";
export const USER_DATA_INCLUDE = Object.freeze(["GC", "StateSaves"]);
export const WRITER_LOCK_NAME = "wasm-dolphin.user-data.writer.v1";
export const RECORD_MAGIC = "SLNUSR01";
export const RECORD_HEADER_BYTES = 48;
export const NEXT_INFIX = ".next-";

const MAGIC_BYTES = new TextEncoder().encode(RECORD_MAGIC);
const GCI_HEADER_BYTES = 0x40;
const GCI_BLOCK_BYTES = 0x2000;
const NEXT_PATTERN = /\.next-[0-9a-z]+$/;

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

function defaultNonce() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36)).join("");
}

// Records on top of five primitives: list() -> names, read(name) -> bytes
// or null, write(name, bytes) (durable when it resolves), move(from, to)
// (replaces `to`), remove(name). The OPFS implementation is below; tests use
// one in memory that can fail half way. A read-only store never writes,
// moves or removes: it only reads the best record.
export function createRecordStore(primitives, { readOnly = false, nonce = defaultNonce } = {}) {
  const generations = new Map();

  async function candidates(name) {
    const names = (await primitives.list()).filter(
      (entry) => entry === name || (entry.startsWith(name + NEXT_INFIX) && NEXT_PATTERN.test(entry))
    );
    const records = [];
    for (const entry of names) {
      const record = await decodeRecord(await primitives.read(entry));
      records.push({ entry, record });
    }
    return records;
  }

  function best(records) {
    let winner = null;
    for (const { entry, record } of records) {
      if (record && (!winner || record.generation > winner.generation)) {
        winner = { entry, ...record };
      }
    }
    return winner;
  }

  function refuseWrites(action) {
    if (readOnly) throw new Error(`${action}: saves are read-only in this tab`);
  }

  return {
    readOnly,
    async keys() {
      const names = new Set();
      for (const entry of await primitives.list()) {
        names.add(NEXT_PATTERN.test(entry) ? entry.replace(NEXT_PATTERN, "") : entry);
      }
      return [...names].sort();
    },

    // The best payload stored under `name`, or null when nothing is stored.
    // Throws when entries exist but none of them is a valid record: that is
    // damage, and must not read as "no save".
    async load(name) {
      const records = await candidates(name);
      if (records.length === 0) {
        generations.delete(name);
        return null;
      }
      const winner = best(records);
      if (!winner) throw new Error(`${pathFromRecordName(name)}: no valid copy among ${records.length} stored`);
      generations.set(name, winner.generation);
      if (!readOnly) {
        // Finish an interrupted save, drop torn or superseded ones.
        if (winner.entry !== name) await primitives.move(winner.entry, name);
        for (const { entry } of records) {
          if (entry !== winner.entry && entry !== name) await primitives.remove(entry);
        }
      }
      return winner.payload;
    },

    // Resolves once the new version is stored, read back and checked.
    async save(name, payload) {
      refuseWrites("save");
      let generation = generations.get(name);
      if (generation === undefined) generation = best(await candidates(name))?.generation ?? 0;
      generation += 1;
      const next = `${name}${NEXT_INFIX}${nonce()}`;
      const record = await encodeRecord(generation, payload);
      await primitives.write(next, record);
      const written = await decodeRecord(await primitives.read(next));
      if (!written || written.generation !== generation) {
        await primitives.remove(next).catch(() => {});
        throw new Error(`${pathFromRecordName(name)}: the copy read back does not match what was written`);
      }
      await primitives.move(next, name);
      generations.set(name, generation);
      return generation;
    },

    async remove(name) {
      refuseWrites("remove");
      for (const { entry } of await candidates(name)) await primitives.remove(entry);
      generations.delete(name);
    }
  };
}

// OPFS primitives. Writes go through synchronous access handles, which only
// exist in a dedicated worker: truncate, write, flush, close. Reads take a
// File snapshot instead, so a read-only tab never opens a handle that would
// block the writer.
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
      try {
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (error) {
        if (error?.name === "NotFoundError") return null;
        throw error;
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
        // stays readable under `from` until the move lands, and a reader
        // takes the best of both, so removing `to` first loses nothing.
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

// The exclusive writer lock, held until the worker goes away. Resolves to
// { granted } at once: a second tab is not queued behind the first.
export async function acquireWriterLock(locks = globalThis.navigator?.locks, name = WRITER_LOCK_NAME) {
  if (typeof locks?.request !== "function") {
    return { granted: false, reason: "Web Locks are unavailable, so this tab cannot know it is the only writer" };
  }
  return new Promise((resolve, reject) => {
    locks
      .request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve({ granted: false, reason: "another tab is already playing with these saves" });
          return undefined;
        }
        resolve({ granted: true, reason: "" });
        return new Promise(() => {});
      })
      .catch(reject);
  });
}

// Dolphin's own temporaries and backups, never worth a copy: save-state
// temp files ("x.s01.tmp1234"), the undo backup, DTM movies, and the
// worker's own staging names.
export function isPersistentUserPath(relativePath) {
  const base = relativePath.split("/").pop() ?? "";
  if (/\.tmp\d*$/.test(base)) return false;
  if (base.startsWith("lastState.sav")) return false;
  if (base.endsWith(".dtm")) return false;
  if (base.startsWith(".staging")) return false;
  return true;
}

// A GCI file is complete when it holds the blocks its entry announces.
export function gciLooksComplete(bytes) {
  if (bytes.byteLength < GCI_HEADER_BYTES) return false;
  const blockCount = (bytes[0x38] << 8) | bytes[0x39];
  return bytes.byteLength === GCI_HEADER_BYTES + blockCount * GCI_BLOCK_BYTES;
}

export class RestoreError extends Error {
  constructor(message, failures) {
    super(message);
    this.name = "RestoreError";
    this.failures = failures;
  }
}

export function createUserDataMirror({
  fs,
  store,
  root = USER_DATA_ROOT,
  include = USER_DATA_INCLUDE,
  // () => number: cards flushed (>= 0), or a negative/absent result when the
  // core cannot flush now (then the two-scan rule applies).
  flushNative = null,
  restoreAttempts = 3,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {}
}) {
  // Persisted signature per relative path: size and mtime of the MEMFS file
  // the stored record was taken from.
  const persisted = new Map();
  // What the previous scan saw, to require two identical scans in a row.
  let previousScan = new Map();
  let chain = Promise.resolve();
  const stats = {
    restored: 0,
    written: 0,
    removed: 0,
    skippedTorn: 0,
    bytesWritten: 0,
    nativeFlushes: 0,
    lastError: ""
  };

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

  function nativeFlush() {
    if (!flushNative) return false;
    const flushed = flushNative();
    if (typeof flushed === "number" && flushed >= 0) {
      stats.nativeFlushes += 1;
      return true;
    }
    return false;
  }

  async function persist({ force }) {
    if (store.readOnly) return 0;
    // The core's cards first, so the scan sees what the game wrote.
    const fresh = nativeFlush() || force;
    const current = scan();
    let changed = 0;
    for (const [relative, signature] of current) {
      if (persisted.get(relative) === signature) continue;
      if (!fresh && previousScan.get(relative) !== signature) continue;
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
    stats.lastError = "";
    return changed;
  }

  // Every task runs after the previous one; its error goes to its caller
  // and into stats.lastError, and does not poison the next task.
  function serialized(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => {},
      (error) => {
        stats.lastError = String(error?.message || error);
        log(`[user-data] ${stats.lastError}`);
      }
    );
    return run;
  }

  async function readAll() {
    const staged = [];
    const failures = [];
    for (const name of await store.keys()) {
      const relative = pathFromRecordName(name);
      if (!include.some((dir) => relative.startsWith(`${dir}/`)) || !isPersistentUserPath(relative)) {
        continue;
      }
      try {
        const payload = await store.load(name);
        if (payload) staged.push({ relative, payload });
      } catch (error) {
        failures.push(`${relative}: ${error?.message || error}`);
      }
    }
    return { staged, failures };
  }

  return {
    stats,
    // Copy every stored file back into MEMFS, or none of them. Call before
    // the core boots: Dolphin reads the GCI folder when the card goes in.
    // Transient failures (the writer tab moving a record while this one
    // reads it) are retried; damage is not.
    restore: () =>
      serialized(async () => {
        let result = null;
        for (let attempt = 1; attempt <= restoreAttempts; attempt += 1) {
          try {
            result = await readAll();
          } catch (error) {
            result = { staged: [], failures: [String(error?.message || error)] };
          }
          if (result.failures.length === 0) break;
          if (attempt < restoreAttempts) await sleep(100 * attempt);
        }
        if (result.failures.length) {
          throw new RestoreError(
            `Saves could not be restored (${result.failures.length} file(s)): ${result.failures.join("; ")}`,
            result.failures
          );
        }
        let bytes = 0;
        for (const { relative, payload } of result.staged) {
          const path = `${root}/${relative}`;
          mkdirTree(path.slice(0, path.lastIndexOf("/")));
          fs.writeFile(path, payload);
          bytes += payload.byteLength;
        }
        const now = scan();
        for (const [relative, signature] of now) persisted.set(relative, signature);
        previousScan = now;
        stats.restored = result.staged.length;
        return { restored: result.staged.length, bytes };
      }),
    // Periodic: copy files that changed, drop deleted ones.
    sync: () => serialized(() => persist({ force: false })),
    // Before pause/stop/hide and after a save: copy everything that differs
    // now. Resolves once every copy is stored and checked.
    flush: () => serialized(() => persist({ force: true })),
    list() {
      return [...scan().keys()].sort();
    }
  };
}

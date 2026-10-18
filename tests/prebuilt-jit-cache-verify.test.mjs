// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// A prebuilt JIT cache is either usable with the core it ships next to, or
// rejected with a reason: never silently ignored (issue #18).
import assert from "node:assert/strict";
import test from "node:test";
import { encodePrebuiltCache, verifyPrebuiltCache } from "../src/prebuilt-jit-cache-format.js";
import { JIT_CACHE_ENTRY_KEY_SCHEMA, canonicalCoreFingerprint, canonicalWasmBlockKey } from "../src/jit-cache-identity.js";

const CORE = "ab".repeat(32);
// (func (param i32) (result i32) local.get 0) exported as "f", and the same
// body leaving an extra value on the stack (rejected by the engine).
const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00];
const valid = Uint8Array.from([...header, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x20, 0x00, 0x0b]);
const invalid = Uint8Array.from([...header, 0x0a, 0x08, 0x01, 0x06, 0x00, 0x20, 0x00, 0x20, 0x00, 0x0b]);

async function cache(modules, { fingerprint = canonicalCoreFingerprint(CORE), version } = {}) {
  const entries = new Map();
  for (const bytes of modules) entries.set(await canonicalWasmBlockKey(bytes), bytes);
  const out = encodePrebuiltCache({ fingerprint, entryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA, entries });
  if (version !== undefined) new DataView(out.buffer).setUint32(8, version, true);
  return out;
}

test("a v2 cache built for this core with valid modules is usable", async () => {
  assert.equal(WebAssembly.validate(valid), true);
  assert.deepEqual(await verifyPrebuiltCache(await cache([valid]), CORE),
    { ok: true, reason: "ok", entries: 1, invalidModules: 0 });
});

test("legacy versions, other cores, forged keys and rejected modules are refused with a reason", async () => {
  const v1 = await verifyPrebuiltCache(await cache([valid], { version: 1 }), CORE);
  assert.equal(v1.ok, false);
  assert.match(v1.reason, /unsupported version 1/);

  const stale = await verifyPrebuiltCache(await cache([valid], { fingerprint: canonicalCoreFingerprint("cd".repeat(32)) }), CORE);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /does not match the core/);

  const forged = await cache([valid]);
  forged[forged.length - 2] ^= 1; // change the module, keep its claimed key
  assert.match((await verifyPrebuiltCache(forged, CORE)).reason, /does not match its bytes/);

  assert.equal(WebAssembly.validate(invalid), false);
  const broken = await verifyPrebuiltCache(await cache([valid, invalid]), CORE);
  assert.deepEqual([broken.ok, broken.invalidModules], [false, 1]);
});

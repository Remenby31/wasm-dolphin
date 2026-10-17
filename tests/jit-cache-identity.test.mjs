import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

import {
  JIT_CACHE_ENTRY_KEY_SCHEMA,
  canonicalCoreFingerprint,
  canonicalWasmBlockKey,
  classifyJitCacheIdentity,
  verifyCanonicalWasmBlockKey
} from "../src/jit-cache-identity.js";
import {
  PREBUILT_CACHE_VERSION,
  decodePrebuiltCache,
  encodePrebuiltCache
} from "../src/prebuilt-jit-cache-format.js";

const COLLISION_A = Uint8Array.from(Buffer.from(
  "0061736d0100000001060160017f017f03020100070501016600000a0601040020000b000a01782c9404ceec77a6cc",
  "hex"
));
const COLLISION_B = Uint8Array.from(Buffer.from(
  "0061736d0100000001060160017f017f03020100070501016600000a09010700200041016a0b000a0178cc6a4395e14e48fb",
  "hex"
));

function legacyFnvKey(bytes) {
  let h = 2166136261 >>> 0;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 16777619);
  }
  return ((h ^ bytes.byteLength) >>> 0).toString(16);
}

test("valid behavior-changing WASM modules collide under the legacy key but not SHA-256", async () => {
  assert.equal(legacyFnvKey(COLLISION_A), "5d30b9e6");
  assert.equal(legacyFnvKey(COLLISION_B), "5d30b9e6");

  const a = await WebAssembly.instantiate(COLLISION_A);
  const b = await WebAssembly.instantiate(COLLISION_B);
  assert.equal(a.instance.exports.f(5), 5);
  assert.equal(b.instance.exports.f(5), 6);

  const keyA = await canonicalWasmBlockKey(COLLISION_A);
  const keyB = await canonicalWasmBlockKey(COLLISION_B);
  assert.match(keyA, /^wasm-block-sha256-v1:[0-9a-f]{64}$/);
  assert.notEqual(keyA, keyB);
  assert.equal(await verifyCanonicalWasmBlockKey(keyA, COLLISION_A), true);
  assert.equal(await verifyCanonicalWasmBlockKey(keyA, COLLISION_B), false);
  assert.equal(await verifyCanonicalWasmBlockKey("5d30b9e6", COLLISION_A), false);
});

test("core fingerprint is the exact verified SHA-256 with a versioned domain", () => {
  const sha = "ab".repeat(32);
  assert.equal(canonicalCoreFingerprint(sha), `dolphin-core-sha256-v1:${sha}`);
  assert.throws(() => canonicalCoreFingerprint("ab12"), /SHA-256/i);
});

test("cache identity fails closed for missing, stale, or legacy metadata", () => {
  const currentFingerprint = canonicalCoreFingerprint("11".repeat(32));
  assert.deepEqual(
    classifyJitCacheIdentity({
      storedFingerprint: currentFingerprint,
      storedEntryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA,
      currentFingerprint
    }),
    { reset: false, reason: "match" }
  );
  for (const metadata of [
    {},
    { storedFingerprint: currentFingerprint },
    { storedEntryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA },
    { storedFingerprint: "legacy:123", storedEntryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA },
    { storedFingerprint: currentFingerprint, storedEntryKeySchema: "fnv32-v1" }
  ]) {
    assert.equal(classifyJitCacheIdentity({ ...metadata, currentFingerprint }).reset, true);
  }
});

test("prebuilt v2 carries the key schema and rejects truncation or legacy versions", async () => {
  const fingerprint = canonicalCoreFingerprint("22".repeat(32));
  const key = await canonicalWasmBlockKey(COLLISION_A);
  const blob = encodePrebuiltCache({
    fingerprint,
    entryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA,
    entries: new Map([[key, COLLISION_A]])
  });
  const decoded = decodePrebuiltCache(blob);
  assert.equal(PREBUILT_CACHE_VERSION, 2);
  assert.equal(decoded.fingerprint, fingerprint);
  assert.equal(decoded.entryKeySchema, JIT_CACHE_ENTRY_KEY_SCHEMA);
  assert.equal(decoded.entries[0].hash, key);
  assert.deepEqual(decoded.entries[0].bytes, COLLISION_A);

  assert.throws(() => decodePrebuiltCache(blob.subarray(0, blob.byteLength - 1)), /truncated/i);
  const legacy = blob.slice();
  new DataView(legacy.buffer).setUint32(8, 1, true);
  assert.throws(() => decodePrebuiltCache(legacy), /unsupported version 1/);
});

test("worker source locks v3 migration and reconcile-before-seed ordering", async () => {
  const source = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(source, /DOLPHIN_JIT_IDB_VERSION\s*=\s*3/);
  assert.match(source, /DOLPHIN_JIT_ENTRY_KEY_SCHEMA_KEY\s*=\s*"entryKeySchema"/);
  assert.match(source, /event\.oldVersion\s*<\s*3[\s\S]{0,400}deleteObjectStore\(DOLPHIN_JIT_IDB_STORE\)/);
  const reconcile = source.indexOf("await reconcileJitCacheWithBuild(buildFingerprint)");
  const seed = source.indexOf("await maybeSeedIdbFromPrebuiltCache(coreUrl, buildFingerprint)");
  assert.ok(reconcile >= 0 && seed > reconcile, "reconcile must fail closed before prebuilt seed");
  assert.match(source, /verifyCanonicalWasmBlockKey\(String\(key\), buf\)/);
  assert.match(source, /verifyCanonicalWasmBlockKey\(String\(data\.hash\), bytes\)/);
});

sourceContractTest("native compile path supplies the same canonical SHA-256 key domain", async () => {
  const source = await readFile(
    new URL(
      "../vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /#include <mbedtls\/sha256\.h>/);
  assert.match(source, /mbedtls_sha256_ret\(bytes\.data\(\), bytes\.size\(\), digest\.data\(\), 0\)/);
  assert.match(source, /prefix\s*=\s*"wasm-block-sha256-v1:"/);
  assert.match(source, /cacheKey\s*=\s*UTF8ToString\(cache_key_ptr\)/);
  assert.doesNotMatch(source, /cacheKey\s*=\s*h\.toString\(16\)/);
});

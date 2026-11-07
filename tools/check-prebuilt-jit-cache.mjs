// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Fails when cores/dolphin/prebuilt-jit-cache.bin exists but the worker
// would not use it with the committed core (wrong version, stale fingerprint,
// mismatched keys, modules the engine rejects). No file is fine: the cache is
// an optional, locally built asset.
//   node tools/check-prebuilt-jit-cache.mjs [file] [--core-sha256 <hex>]
import { existsSync, readFileSync } from "node:fs";
import { verifyPrebuiltCache } from "../src/prebuilt-jit-cache-format.js";
import { DEFAULT_UPSTREAM_CORE_SHA256 } from "../src/default-core.js";

const args = process.argv.slice(2);
const shaIndex = args.indexOf("--core-sha256");
const coreSha256 = shaIndex >= 0 ? args[shaIndex + 1] : DEFAULT_UPSTREAM_CORE_SHA256;
const file = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--core-sha256") ??
  "cores/dolphin/prebuilt-jit-cache.bin";

if (!existsSync(file)) {
  console.log(`prebuilt JIT cache: none at ${file} (optional)`);
  process.exit(0);
}
const result = await verifyPrebuiltCache(readFileSync(file), coreSha256);
if (!result.ok) {
  console.error(`prebuilt JIT cache ${file} is unusable with core ${coreSha256}: ${result.reason}`);
  console.error("Rebuild it (npm run build:prebuilt-cache) or delete it.");
  process.exit(1);
}
console.log(`prebuilt JIT cache: ${result.entries} verified modules for core ${coreSha256}`);

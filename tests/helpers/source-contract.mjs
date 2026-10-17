// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Source-contract tests read the patched Dolphin tree under vendor/ (C++ text,
// CMake flags, or a native harness compiled against it). They are not unit
// tests: a fresh clone has no vendor/ until `npm run fetch:dolphin && npm run
// patch:upstream`, and the unit suite must stay green without it.
//
// Every such test is declared through sourceContractTest(). That does two things:
//   - the name carries SOURCE_CONTRACT_TAG, so `npm test` excludes them by
//     pattern and `npm run test:contract` selects exactly them;
//   - without vendor/ the test is skipped with a reason, never silently passed.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

export const SOURCE_CONTRACT_TAG = "source-contract:";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const vendorSourceRoot = join(root, "vendor/dolphin/Source/Core");
export const hasVendorSource = existsSync(vendorSourceRoot);

const missingReason = "requires vendor/dolphin; run `npm run fetch:dolphin && npm run patch:upstream`";

/** node:test's test(), tagged as a source contract and skipped without vendor/. */
export function sourceContractTest(name, options, fn) {
  if (typeof options === "function") {
    fn = options;
    options = {};
  }
  const skip = hasVendorSource ? (options.skip ?? false) : missingReason;
  return test(`${SOURCE_CONTRACT_TAG} ${name}`, { ...options, skip }, fn);
}

/**
 * Read a file at module scope that only source-contract tests use. Returns ""
 * when vendor/ is absent so the unit tests sharing the file can still load.
 */
export function readVendorFileSync(path) {
  return hasVendorSource ? readFileSync(path, "utf8") : "";
}

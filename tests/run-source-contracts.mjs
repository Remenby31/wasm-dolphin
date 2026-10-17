// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Runs only the source-contract tests (see helpers/source-contract.mjs). Unlike
// `npm test`, a missing vendor/ tree is a hard failure here: asking for the
// contracts and getting a wall of skips would look like a pass.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_CONTRACT_TAG, hasVendorSource, vendorSourceRoot } from "./helpers/source-contract.mjs";

if (!hasVendorSource) {
  console.error(`source-contract tests need ${vendorSourceRoot}`);
  console.error("Run `npm run fetch:dolphin && npm run patch:upstream` first.");
  process.exit(1);
}

const directory = import.meta.dirname;
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(directory, name));
const pattern = `^${SOURCE_CONTRACT_TAG} `;
const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, ...files], {
  stdio: "inherit"
});
process.exit(result.status ?? 1);

// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A pull request's core build regenerates the ABI manifest before its tests:
// tools/check-abi-source-drift.mjs fails the job when the committed SOURCE
// entries differ from the regenerated ones (#304 left src/core-host.js stale
// and main went red after the merge).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { driftMessage, sourceDrift } from "../tools/check-abi-source-drift.mjs";

const manifest = JSON.parse(readFileSync(new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url), "utf8"));
const clone = (m) => JSON.parse(JSON.stringify(m));

test("identical sources: no drift; artifact changes (a rebuilt core) are not a drift", () => {
  const rebuilt = clone(manifest);
  for (const a of rebuilt.artifacts ?? []) { a.size += 1; a.sha256 = "0".repeat(64); }
  assert.deepEqual(sourceDrift(manifest, rebuilt), []);
  assert.equal(driftMessage([]), null);
});

test("a changed, added or removed source is a drift, and the message says what to run", () => {
  const current = clone(manifest);
  const host = current.contractSources.find((s) => s.path === "src/core-host.js");
  host.size += 569;
  current.contractSources.push({ path: "src/new.js", hashMode: "lf-normalized", size: 1, sha256: "1".repeat(64) });
  const removed = current.contractSources.shift();
  const drift = sourceDrift(manifest, current);
  assert.deepEqual(drift.map((d) => d.change).sort(), ["added", "changed", "removed"]);
  assert.ok(drift.some((d) => d.path === "src/core-host.js" && d.change === "changed"));
  assert.ok(drift.some((d) => d.path === removed.path && d.change === "removed"));
  assert.match(driftMessage(drift), /npm run update:core-abi/);
});

test("the core build runs the check in pull requests, after the install", () => {
  const yml = readFileSync(new URL("../.github/workflows/core-build.yml", import.meta.url), "utf8");
  const at = yml.indexOf("node tools/check-abi-source-drift.mjs --ref HEAD");
  assert.ok(at > yml.indexOf("The installed core is the build of these sources"));
  assert.ok(yml.indexOf("- name: npm test", at) > at, "before the tests of the same job");
  assert.match(yml.slice(yml.lastIndexOf("- name:", at), at), /if: env\.PR == 'true'/);
});

#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The CI bench's check on a lever's PR core (bench.yml candidate_core_run):
//
//   node harness/remote/core-compat.mjs <artifact dir> <sha256> [<tree>]
//
// The artifact is core-build.yml's core-<sha256> (dolphin-core-upstream.*,
// core.lock.json, dolphin-core-abi-v1.json). Served with ?coreid on this
// tree, it runs under this tree's JavaScript, so it must be: the .wasm its
// name says, and the same binary interface as the tree's committed core
// (the ABI manifest's moduleExports, runtimeMethods and memoryContract).
// Exit 1 with the reasons otherwise.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The ABI fields read off a built core, less the two that name the core.
export const COMPAT_FIELDS = ["moduleExports", "runtimeMethods", "memoryContract", "memoryContractStatus"];

const canonical = (v) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);

export function coreCompat({ wasm, name, artifactAbi, treeAbi }) {
  const why = [];
  const sha = createHash("sha256").update(wasm).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(name ?? "")) why.push(`not a sha256: ${name}`);
  else if (sha !== name) why.push(`the .wasm hashes to ${sha}, not ${name}`);
  if (artifactAbi?.coreId && artifactAbi.coreId !== `sha256:${sha}`) why.push(`the artifact's ABI manifest describes ${artifactAbi.coreId}`);
  for (const f of COMPAT_FIELDS) {
    if (canonical(artifactAbi?.[f]) !== canonical(treeAbi?.[f])) why.push(`${f} differs from the tree's core`);
  }
  return why;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, name, tree = "."] = process.argv.slice(2);
  if (!dir || !name) throw new Error("usage: core-compat.mjs <artifact dir> <sha256> [<tree>]");
  const why = coreCompat({
    wasm: readFileSync(path.join(dir, "dolphin-core-upstream.wasm")), name,
    artifactAbi: JSON.parse(readFileSync(path.join(dir, "dolphin-core-abi-v1.json"), "utf8")),
    treeAbi: JSON.parse(readFileSync(path.join(tree, "provenance", "dolphin-core-abi-v1.json"), "utf8"))
  });
  if (why.length) {
    console.error(`core ${name}: not servable on this tree:\n  ${why.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`core ${name}: the .wasm its name says, same binary interface as this tree's core`);
}

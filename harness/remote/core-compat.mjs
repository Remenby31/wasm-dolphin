#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The CI bench's check on a lever's PR core (bench.yml candidate_core_run):
//
//   node harness/remote/core-compat.mjs <artifact dir> <sha256> [<tree>]
//
// The artifact is core-build.yml's core-<sha256> (dolphin-core-upstream.wasm,
// .js, .build.json, core.lock.json, dolphin-core-abi-v1.json). Served with
// ?coreid on this tree, the candidate runs this tree's application code with
// the artifact's own core: its .wasm and the Emscripten glue (.js) built with
// it (the two only work as a pair). Before that, all bound to the bytes:
//   - the .wasm hashes to its name; the build record and the ABI manifest
//     both name that core (coreId mandatory), and the build record holds the
//     .wasm's and the glue's hashes (the glue LF-normalized, as built);
//   - the module exports are recomputed from that glue with this tree's own
//     tool (publicModuleExports), not taken from the manifest, and must be
//     this tree's core's; runtimeMethods and memoryContract come from the
//     manifest (bound to the core by its coreId) and must be this tree's.
// Exit 1 with the reasons otherwise.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { publicModuleExports } from "../../tools/dolphin-provenance.mjs";

// The manifest's fields checked as they stand (bound by coreId).
export const MANIFEST_FIELDS = ["runtimeMethods", "memoryContract", "memoryContractStatus"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (v) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);

export function coreCompat({ wasm, glue, name, buildInfo, artifactAbi, treeAbi, exportsOf = publicModuleExports }) {
  const why = [];
  const sha = sha256(wasm);
  if (!/^[0-9a-f]{64}$/.test(name ?? "")) why.push(`not a sha256: ${name}`);
  else if (sha !== name) why.push(`the .wasm hashes to ${sha}, not ${name}`);
  const core = `sha256:${sha}`;
  if (artifactAbi?.coreId !== core) why.push(`the ABI manifest names ${artifactAbi?.coreId ?? "no core"}, not ${core}`);
  if (buildInfo?.coreId !== core) why.push(`the build record names ${buildInfo?.coreId ?? "no core"}, not ${core}`);
  if (buildInfo?.artifacts?.wasm?.sha256 !== sha) why.push("the build record holds another .wasm");
  const glueText = Buffer.from(String(glue ?? "").replaceAll("\r\n", "\n"));
  if (buildInfo?.artifacts?.js?.sha256 !== sha256(glueText)) why.push("the glue (.js) is not the one the build record holds");
  let exports = null;
  try { exports = exportsOf(String(glue ?? "")); } catch (error) { why.push(`no module exports in the glue: ${error.message}`); }
  if (exports && canonical(exports) !== canonical(treeAbi?.moduleExports)) why.push("moduleExports (from the glue) differ from the tree's core");
  for (const f of MANIFEST_FIELDS) {
    if (canonical(artifactAbi?.[f]) !== canonical(treeAbi?.[f])) why.push(`${f} differs from the tree's core`);
  }
  return why;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, name, tree = "."] = process.argv.slice(2);
  if (!dir || !name) throw new Error("usage: core-compat.mjs <artifact dir> <sha256> [<tree>]");
  const read = (f) => readFileSync(path.join(dir, f));
  const why = coreCompat({
    wasm: read("dolphin-core-upstream.wasm"), glue: read("dolphin-core-upstream.js").toString("utf8"), name,
    buildInfo: JSON.parse(read("dolphin-core-upstream.build.json").toString("utf8")),
    artifactAbi: JSON.parse(read("dolphin-core-abi-v1.json").toString("utf8")),
    treeAbi: JSON.parse(readFileSync(path.join(tree, "provenance", "dolphin-core-abi-v1.json"), "utf8"))
  });
  if (why.length) {
    console.error(`core ${name}: not servable on this tree:\n  ${why.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`core ${name}: the .wasm and the glue its build record holds, module exports (from that glue), runtime methods and memory contract as this tree's core`);
}

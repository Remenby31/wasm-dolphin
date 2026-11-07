#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A pull request's core build runs update-core-abi --write before the tests,
// so they check a regenerated manifest and a stale committed one goes
// unnoticed until main checks it (#304 changed src/core-host.js without it and
// main went red). This compares the committed manifest's SOURCE entries
// (contractSources) with the regenerated ones and fails on any difference;
// the artifact entries may change with the rebuilt core.
//   node tools/check-abi-source-drift.mjs [--committed <file> | --ref HEAD] [--current provenance/dolphin-core-abi-v1.json]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const MANIFEST = "provenance/dolphin-core-abi-v1.json";

// The source entries that differ, by path: changed, added or removed.
export function sourceDrift(committed, current) {
  const byPath = (m) => new Map((m.contractSources ?? []).map((s) => [s.path, `${s.size}:${s.sha256}:${s.hashMode}`]));
  const a = byPath(committed), b = byPath(current);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths.filter((p) => a.get(p) !== b.get(p)).map((p) => ({ path: p, change: !a.has(p) ? "added" : !b.has(p) ? "removed" : "changed" }));
}

export function driftMessage(drift) {
  if (!drift.length) return null;
  return `${MANIFEST} is stale for ${drift.length} source(s): ${drift.map((d) => `${d.path} (${d.change})`).join(", ")}.\n` +
    `Run \`npm run update:core-abi\` and commit ${MANIFEST} with the change.`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { committed: { type: "string" }, ref: { type: "string", default: "HEAD" }, current: { type: "string", default: MANIFEST } } });
  const committedText = values.committed ? readFileSync(values.committed, "utf8") : execFileSync("git", ["show", `${values.ref}:${MANIFEST}`], { encoding: "utf8" });
  const message = driftMessage(sourceDrift(JSON.parse(committedText), JSON.parse(readFileSync(values.current, "utf8"))));
  if (message) {
    console.error(`::error file=${MANIFEST}::${message.replace(/\n/g, " ")}`);
    console.error(message);
    process.exit(1);
  }
  console.log(`${MANIFEST}: committed source entries match the regenerated ones`);
}

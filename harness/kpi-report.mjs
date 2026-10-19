#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The program's KPI table from the latest results (lib/kpi.mjs), as
// Markdown and JSON in measures/kpi/ (outside the repo: the race results
// come from a local-only disc). Reads only; launches nothing.
//
//   node harness/kpi-report.mjs [--from dir]… [--no-worktrees]
//     [--manual measures/kpi/manual.json] [--out measures/kpi] [--print]
//
// Default sources: ../measures (local-only probes write there), this tree's
// harness/results, and the harness/results of the sibling worktrees (the
// agents' fuzz and gate runs). Each source is read four levels deep for
// summary.json, gate.json and fuzz.json, classified by content. manual.json holds what no probe
// measures yet: { "<kpi id>": { "value": …, "source": "…", "at": "…", "note": "…" } }.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { REPO_ROOT } from "./lib/browser.mjs";
import { classify, kpiMarkdown, kpiTable } from "./lib/kpi.mjs";

const RESULT_FILES = new Set(["summary.json", "gate.json", "fuzz.json"]);
const PROGRAM_ROOT = path.resolve(REPO_ROOT, "..");

// Result files under `root`, up to `depth` directory levels below it.
export function findResults(root, depth = 4) {
  const out = [];
  const walk = (dir, left) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && RESULT_FILES.has(e.name)) out.push(p);
      else if (e.isDirectory() && left > 0 && !e.name.startsWith(".") && e.name !== "node_modules") walk(p, left - 1);
    }
  };
  walk(root, depth);
  return out;
}

function defaultSources() {
  const dirs = [path.join(PROGRAM_ROOT, "measures"), path.join(REPO_ROOT, "harness", "results")];
  for (const e of readdirSync(PROGRAM_ROOT, { withFileTypes: true })) {
    const results = path.join(PROGRAM_ROOT, e.name, "harness", "results");
    if (e.isDirectory() && existsSync(results) && !dirs.includes(results)) dirs.push(results);
  }
  return dirs;
}

export function loadResults(dirs) {
  const results = [];
  for (const file of [...new Set(dirs.flatMap((d) => findResults(d)))]) {
    let json;
    try { json = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    const kind = classify(json, file);
    if (kind) results.push({ kind, json, file: path.relative(PROGRAM_ROOT, file), mtimeMs: statSync(file).mtimeMs });
  }
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string", multiple: true, default: [] }, "no-worktrees": { type: "boolean", default: false },
      manual: { type: "string", default: path.join(PROGRAM_ROOT, "measures", "kpi", "manual.json") },
      out: { type: "string", default: path.join(PROGRAM_ROOT, "measures", "kpi") }, print: { type: "boolean", default: false }
    }
  });
  const dirs = values.from.length ? values.from.map((d) => path.resolve(d))
    : values["no-worktrees"] ? [path.join(PROGRAM_ROOT, "measures"), path.join(REPO_ROOT, "harness", "results")] : defaultSources();
  const results = loadResults(dirs);
  const manual = existsSync(values.manual) ? JSON.parse(readFileSync(values.manual, "utf8")) : {};
  const rows = kpiTable(results, manual);
  const at = new Date().toISOString();
  let uptime = null;
  try { uptime = execFileSync("uptime", { encoding: "utf8" }).trim(); } catch {}
  const md = kpiMarkdown(rows, { at, uptime });
  mkdirSync(values.out, { recursive: true });
  const stamp = at.replace(/[:.]/g, "-").slice(0, 19);
  const json = JSON.stringify({ at, uptime, sources: dirs.map((d) => path.relative(PROGRAM_ROOT, d)), scanned: results.length, rows }, null, 1) + "\n";
  for (const name of [`kpi-${stamp}`, "latest"]) {
    writeFileSync(path.join(values.out, `${name}.md`), md + "\n");
    writeFileSync(path.join(values.out, `${name}.json`), json);
  }
  console.log(values.print ? md : `[kpi-report] ${rows.filter((r) => r.status === "OK").length} OK, ${rows.filter((r) => r.status === "KO").length} KO, ${rows.filter((r) => r.status === "n/a").length} n/a over ${results.length} results -> ${path.join(values.out, "latest.md")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

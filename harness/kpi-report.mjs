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
//     [--candidate race-perf/summary.json [--candidate-label name]]
//
// Default sources: ../measures (local-only probes write there), this tree's
// harness/results, and the harness/results of the sibling worktrees (the
// agents' fuzz and gate runs, archived under ../measures/worktree-archive-*
// once a worktree is removed). Each source is read six levels deep for
// summary.json, gate.json and fuzz.json, classified by content. Only results
// measured on a clean commit of origin/main's first-parent history count
// (lib/kpi.mjs); fetch origin first for an up-to-date trunk. manual.json
// holds what no probe measures yet:
// { "<kpi id>": { "value": <number>, "source": "…", "at": "…", "note": "…" } }.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { REPO_ROOT } from "./lib/browser.mjs";
import { candidateColumn, classify, kpiMarkdown, kpiTable } from "./lib/kpi.mjs";

const RESULT_FILES = new Set(["summary.json", "gate.json", "fuzz.json"]);
const PROGRAM_ROOT = path.resolve(REPO_ROOT, "..");

// Result files under `root`, up to `depth` directory levels below it.
// Six levels: the archived worktree results add two to a run's own
// (measures/worktree-archive-<date>/<wt>/results/<run>/baseline/fuzz.json).
export function findResults(root, depth = 6) {
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

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

// What a result needs from the files next to it to say what it measured:
// race-perf's run*.json (older summaries have no `served`), the gate's
// candidate/summary.json.
function extraOf(kind, json, file) {
  const dir = path.dirname(file);
  if (kind === "race-perf" && !json.served) {
    let names = [];
    try { names = readdirSync(dir).filter((n) => /^run\d+\.json$/.test(n)); } catch {}
    return { runs: names.map((n) => readJson(path.join(dir, n))).filter(Boolean) };
  }
  if (kind === "gate") return { candidate: readJson(path.join(dir, "candidate", "summary.json")) };
  return null;
}

// A source given as a symbolic link (a worktree whose harness/results was
// moved to build.noindex, out of Spotlight's way) is read through it; links
// below a source are not followed (no loop). The same file reached twice
// (the link and its target both given as sources) counts once.
const realPath = (p) => { try { return realpathSync(p); } catch { return p; } };

export function loadResults(dirs, { root = PROGRAM_ROOT } = {}) {
  const results = [];
  const byReal = new Map();
  for (const file of dirs.flatMap((d) => findResults(d))) if (!byReal.has(realPath(file))) byReal.set(realPath(file), file);
  for (const file of byReal.values()) {
    const json = readJson(file);
    const kind = classify(json, file);
    if (kind) results.push({ kind, json, file: path.relative(root, file), mtimeMs: statSync(file).mtimeMs, extra: extraOf(kind, json, file) });
  }
  return results;
}

// Commits of origin/main's first-parent history: the trunk results may name.
export function trunkCommits(repo = REPO_ROOT, ref = "origin/main") {
  return new Set(execFileSync("git", ["-C", repo, "rev-list", "--first-parent", ref], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean));
}

// The candidate column: --candidate <race-perf summary.json> [--candidate-label],
// else measures/kpi/candidate.json { "summary": "<path from the program root>",
// "label": "…" }, kept so a refresh shows the same candidate. Null without one.
export function readCandidate(values, file = path.join(PROGRAM_ROOT, "measures", "kpi", "candidate.json")) {
  let spec = values.candidate ? { summary: values.candidate, label: values["candidate-label"] } : readJson(file);
  if (!spec?.summary) return null;
  const summary = path.resolve(PROGRAM_ROOT, spec.summary);
  // A summary that is gone or unreadable leaves the column out, with the reason.
  const json = readJson(summary);
  if (!json) return { error: `${spec.summary}: missing or unreadable` };
  if (classify(json, summary) !== "race-perf") return { error: `${spec.summary}: not a race-perf summary` };
  let mtimeMs = 0;
  try { mtimeMs = statSync(summary).mtimeMs; } catch {} // removed since it was read: the result's own date is kept
  return candidateColumn({ kind: "race-perf", json, file: path.relative(PROGRAM_ROOT, summary), mtimeMs, extra: extraOf("race-perf", json, summary) }, { label: spec.label ?? null });
}

// manual.json, or { error } when it is there but unreadable (the rows say so).
export function readManual(file) {
  if (!existsSync(file)) return {};
  try {
    const m = JSON.parse(readFileSync(file, "utf8"));
    return m && typeof m === "object" && !Array.isArray(m) ? m : { error: `${path.basename(file)} : un objet est attendu` };
  } catch (e) {
    return { error: `${path.basename(file)} illisible (${String(e.message).slice(0, 80)})` };
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string", multiple: true, default: [] }, "no-worktrees": { type: "boolean", default: false },
      manual: { type: "string", default: path.join(PROGRAM_ROOT, "measures", "kpi", "manual.json") },
      candidate: { type: "string" }, "candidate-label": { type: "string" },
      out: { type: "string", default: path.join(PROGRAM_ROOT, "measures", "kpi") }, print: { type: "boolean", default: false }
    }
  });
  const dirs = values.from.length ? values.from.map((d) => path.resolve(d))
    : values["no-worktrees"] ? [path.join(PROGRAM_ROOT, "measures"), path.join(REPO_ROOT, "harness", "results")] : defaultSources();
  const results = loadResults(dirs);
  const manual = readManual(values.manual);
  const trunk = trunkCommits();
  const rows = kpiTable(results, manual, { trunk });
  const at = new Date().toISOString();
  let uptime = null;
  try { uptime = execFileSync("uptime", { encoding: "utf8" }).trim(); } catch {}
  const candidate = readCandidate(values);
  const md = kpiMarkdown(rows, { at, uptime, candidate: candidate?.error ? null : candidate });
  if (candidate?.error) console.warn(`[kpi-report] candidate column left out: ${candidate.error}`);
  mkdirSync(values.out, { recursive: true });
  const stamp = at.replace(/[:.]/g, "-").slice(0, 19);
  const json = JSON.stringify({ at, uptime, sources: dirs.map((d) => path.relative(PROGRAM_ROOT, d)), trunk: { ref: "origin/main", head: [...trunk][0] ?? null }, scanned: results.length, rows, candidate }, null, 1) + "\n";
  for (const name of [`kpi-${stamp}`, "latest"]) {
    writeFileSync(path.join(values.out, `${name}.md`), md + "\n");
    writeFileSync(path.join(values.out, `${name}.json`), json);
  }
  console.log(values.print ? md : `[kpi-report] ${rows.filter((r) => r.status === "OK").length} OK, ${rows.filter((r) => r.status === "KO").length} KO, ${rows.filter((r) => r.status === "n/a").length} n/a over ${results.length} results -> ${path.join(values.out, "latest.md")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

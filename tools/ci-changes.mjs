// Does a pull request need its own core build? CI skips the 10-20 minute
// core build when a pull request changes nothing the core is built from, and
// tests the pull request against main's committed core instead.
//
//   node tools/ci-changes.mjs --base <ref> [--head <ref>]
//
// Prints one changed path per line with its classification, and writes
// core=true|false to $GITHUB_OUTPUT. Errs on the side of building: anything
// under a build input, a lock, the workflow, or any tool not explicitly listed
// as unrelated to the build counts.
// CI backs this up with `core:status --require-current` on the fast path, which
// fails if the committed core is not the build of the pull request's sources.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Paths whose change can alter the core, its build, or how CI checks it.
// Everything under tools/ counts, unless listed below as a tool that never
// takes part in building, verifying or publishing the core: a new tool is a
// core input until someone decides otherwise.
export const CORE_INPUT_PATTERNS = Object.freeze([
  /^core\//,
  /^patches\//,
  /^cores\//,
  /^\.github\//,
  /^provenance\/(?!dolphin-core-abi-v1\.json$)/,
  /^tools\//
]);

// Measurement, profiling, harness and dev-server tools: they read a built core
// or the browser, never produce or check one.
export const NON_BUILD_TOOLS = Object.freeze([
  /^tools\/_(probe|run)-[\w-]+\.mjs$/,
  /^tools\/[\w-]+\.ps1$/,
  /^tools\/perf-configs\//,
  /^tools\/(benchmark-url|boot-matrix|cpu-profile-analyze|cpu-profile-capture|jit-diagnostics-analyze|jit-split-analyze|menu-progress-validate|perf-ab|perf-artifacts|perf-regression-gate|reap-stale-browsers|score-blockmerge-ab|serve|validate-wgpu-scheduling-screening|validate-wgpu-ubo-screening|validate-wgpu-upload-attribution|wgsl-hlsl-corpus|windows-process-affinity)\.mjs$/
]);

const isCoreInput = (path) =>
  CORE_INPUT_PATTERNS.some((pattern) => pattern.test(path)) &&
  !NON_BUILD_TOOLS.some((pattern) => pattern.test(path));

export function needsCoreBuild(paths) {
  const inputs = paths.filter(isCoreInput);
  return { core: inputs.length > 0, inputs };
}

function changedPaths(base, head) {
  const mergeBase = spawnSync("git", ["merge-base", base, head], { cwd: root, encoding: "utf8" });
  if (mergeBase.status !== 0) throw new Error(`no merge base between ${base} and ${head}`);
  const diff = spawnSync("git", ["diff", "--name-only", "-z", mergeBase.stdout.trim(), head],
    { cwd: root, encoding: "utf8" });
  if (diff.status !== 0) throw new Error("git diff failed");
  return diff.stdout.split("\0").filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  try {
    const base = option("--base");
    if (!base) throw new Error("usage: ci-changes.mjs --base <ref> [--head <ref>]");
    const paths = changedPaths(base, option("--head", "HEAD"));
    const { core, inputs } = needsCoreBuild(paths);
    for (const path of paths) console.log(`${inputs.includes(path) ? "core " : "other"} ${path}`);
    console.log(core ? `Core build needed (${inputs.length} core input(s) changed).`
      : "No core input changed: testing against main's committed core.");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `core=${core}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

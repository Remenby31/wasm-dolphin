// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
let root = directory;
while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
assert.ok(existsSync(join(root, "package.json")), "repository root exists");
const assets = join(directory, "native/static-exit-links");
const sourceDirectory = join(root, "vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter");

const compiler = process.env.CXX || (process.platform === "win32"
  ? join(process.env.USERPROFILE ?? "", "emsdk/upstream/bin/clang++.exe")
  : "clang++");
const compilerProbe = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 10000 });
const pythonCandidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
const emsdk = process.env.EMSDK || join(process.env.USERPROFILE ?? "", "emsdk");
const emsdkPythonDirectory = join(emsdk, "python");
if (process.platform === "win32" && existsSync(emsdkPythonDirectory)) {
  for (const entry of readdirSync(emsdkPythonDirectory, { withFileTypes: true })) {
    const executable = join(emsdkPythonDirectory, entry.name, "python.exe");
    if (entry.isDirectory() && existsSync(executable)) pythonCandidates.push(executable);
  }
}
const python = pythonCandidates.find((candidate) => {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10000 });
  return probe.status === 0 && /^Python 3\./.test((probe.stdout + probe.stderr).trim());
});
const nativeSkip = !existsSync(join(sourceDirectory, "CachedInterpreter.cpp"))
  ? "patched Dolphin vendor sources are unavailable; 49 native groups were not run"
  : compilerProbe.status !== 0
    ? "native clang++/CXX toolchain is unavailable; 49 native groups were not run"
    : !python
      ? "existing Python 3/emsdk runtime is unavailable; 49 native groups were not run"
      : false;

sourceContractTest("actual promoted static-exit links preserve native behavior across all 49 groups", {
  skip: nativeSkip,
  timeout: 600000,
}, async (t) => {
  // Missing new source in an existing vendor checkout is an error, not a reason
  // to silently fall back to private experiment files or skip regression coverage.
  assert.ok(existsSync(join(sourceDirectory, "CachedInterpreterLink.h")), "promoted link header exists");
  const temporaryRoot = resolve(tmpdir());
  const work = mkdtempSync(join(temporaryRoot, "wasm-dolphin-static-links-"));
  try {
    const run = spawnSync(python, [join(assets, "run.py"), "--root", root, "--work", work, "--compiler", compiler], {
      cwd: root, encoding: "utf8", timeout: 570000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(run.status, 0, [run.error?.message, run.stderr, run.stdout].filter(Boolean).join("\n"));
    const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
    assert.equal(result.source, sourceDirectory);
    assert.equal(result.passingGroups, 49);
    assert.equal(result.referenceMode, "explicit macro-0 view of actual promoted vendor source");
    assert.notEqual(result.referenceViewSha256, result.candidateViewSha256,
      "original/candidate differential must not compare the enabled source against itself");
    const manifest = JSON.parse(await readFile(join(assets, "cases.json"), "utf8"));
    for (const phase of result.phases) {
      assert.deepEqual([...phase.groups].sort(), [...manifest[phase.phase]].sort());
      for (const name of phase.groups) await t.test(`${phase.phase}: ${name}`, () => {});
    }
    t.diagnostic(`Vendor source ${result.sourceSha256}; header ${result.headerSha256}; reference is the explicit macro-0 view.`);
  } finally {
    assert.equal(dirname(resolve(work)), temporaryRoot, "cleanup stays in the temporary directory");
    assert.ok(basename(work).startsWith("wasm-dolphin-static-links-"));
    rmSync(work, { recursive: true, force: true });
  }
});

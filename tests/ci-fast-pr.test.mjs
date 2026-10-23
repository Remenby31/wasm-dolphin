import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ccacheEnvironment, resetVendor } from "../tools/build-core-repro.mjs";
import { needsCoreBuild } from "../tools/ci-changes.mjs";
import { loadWasmToolchainLock } from "../tools/wasm-toolchain.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github/workflows/core-build.yml"), "utf8");
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  const next = workflow.slice(start + 1).search(/\n  [a-z-]+:\n/);
  return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
};

test("pull requests that touch no core input skip the core build", () => {
  for (const paths of [
    ["src/app.js", "tests/app.test.mjs", "docs/README.md"],
    ["harness/run.mjs", "README.md", "package.json"],
    // Contract hashes follow src/; the binary fields are guarded separately.
    ["src/upstream-worker-adapter.js", "provenance/dolphin-core-abi-v1.json"],
    ["tools/serve.mjs", "tools/perf-ab.mjs", "tools/_run-jitsplit-on.mjs", "tools/ab-fmh.ps1", "tools/wgsl-hlsl-corpus.mjs",
      "tools/perf-configs/mkwii.json"]
  ]) {
    assert.deepEqual(needsCoreBuild(paths), { core: false, inputs: [] }, paths.join(" "));
  }
});

test("anything the core is built from, or CI itself, needs the core build", () => {
  for (const path of [
    "core/upstream/dolphin_web_discio.cpp",
    "patches/dolphin-wasm/snapshot/0072-x.patch",
    "provenance/dolphin-source.lock.json",
    "provenance/dolphin-vendor-snapshot-v1.json",
    "provenance/wasm-toolchain.lock.json",
    "tools/naga-spirv-wgsl/Cargo.lock",
    "tools/toolchain/Dockerfile",
    "tools/configure-upstream-wasm.mjs",
    "tools/build-core-repro.mjs",
    "tools/core-build-info.mjs",
    "tools/jit-cache-prejs.js",
    "tools/ci-changes.mjs",
    ".github/workflows/core-build.yml",
    "cores/dolphin/core.lock.json"
  ]) {
    const result = needsCoreBuild(["src/app.js", path]);
    assert.equal(result.core, true, path);
    assert.deepEqual(result.inputs, [path]);
  }
});

test("a tool nobody classified counts as a core input", () => {
  for (const path of ["tools/new-helper.mjs", "tools/sub/dir/thing.js", "tools/hooks/pre-commit",
    "tools/xfb-fastpaths-parity.cpp", "tools/update-dolphin-provenance.mjs", "tools/check-prebuilt-jit-cache.mjs"]) {
    assert.equal(needsCoreBuild([path]).core, true, path);
  }
});

test("ccache entries are keyed on the pinned toolchain, not on em++", () => {
  const lock = loadWasmToolchainLock();
  const binary = path.join(root, ".tools/ccache/ccache");
  if (!existsSync(binary) && !process.env.WASM_TOOLCHAIN_DIR) {
    assert.throws(() => ccacheEnvironment(lock, {}), /toolchain:bootstrap/);
    return;
  }
  const env = ccacheEnvironment(lock, {});
  assert.match(env.CCACHE_COMPILERCHECK, new RegExp(`^string:${lock.emscripten.version}-${lock.emscripten.compilerCommit}-${lock.posix.emscriptenTreeSha256}-`));
  // CCACHE_BASEDIR would rewrite paths -ffile-prefix-map relies on, and
  // change the core's bytes.
  assert.ok(!("CCACHE_BASEDIR" in env));
  assert.equal(env.CCACHE_NOHASHDIR, "1");
  assert.equal(env.CCACHE_DIR, path.join(root, "build/ccache"));
});

test("the pinned ccache archives are hash-locked for every macOS/Linux platform", () => {
  const { ccache, platforms } = loadWasmToolchainLock().posix;
  assert.match(ccache.version, /^\d+\.\d+(\.\d+)?$/);
  for (const platform of Object.keys(platforms)) {
    assert.match(ccache.archives[platform]?.sha256 ?? "", /^[0-9a-f]{64}$/, platform);
    assert.match(ccache.archives[platform].name, new RegExp(`^ccache-${ccache.version.replaceAll(".", "\\.")}-`));
  }
});

test("--reset-vendor discards changes and untracked files in the Dolphin tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reset-vendor-"));
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: dir }).status, 0, args.join(" "));
  try {
    git("init", "-q");
    writeFileSync(path.join(dir, "a.cpp"), "pristine\n");
    git("add", "a.cpp");
    git("-c", "user.email=t@x", "-c", "user.name=t", "commit", "-q", "-m", "base");
    writeFileSync(path.join(dir, "a.cpp"), "old patch series\n");
    writeFileSync(path.join(dir, "b.cpp"), "file an old patch added\n");
    resetVendor(dir);
    assert.equal(readFileSync(path.join(dir, "a.cpp"), "utf8"), "pristine\n");
    assert.ok(!existsSync(path.join(dir, "b.cpp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fast path only runs on main's core when that core is current", () => {
  const changes = job("changes");
  assert.match(changes, /core-artifacts\.mjs status --require-current[\s\S]*core=true[\s\S]*ci-changes\.mjs/);
  const fast = job("fast-tests");
  assert.match(fast, /if: needs\.changes\.outputs\.core != 'true'/);
  assert.match(fast, /status --require-current/);
  for (const step of ["npm run check", "npm test", "npm run test:contract"]) assert.ok(fast.includes(`run: ${step}`), step);
  assert.doesNotMatch(fast, /docker|--ccache/);
});

test("main keeps every guarantee; pull requests only read caches", () => {
  const build = job("build");
  // main: ccache build from a clean tree, then a reference build with no
  // cache that must match it; only then are the caches saved (a cache that
  // changes the bytes is never kept), then the incremental check.
  const order = ["--ccache --clean", "Reference build, with no cache", "Save ccache", "Save the CMake tree",
    "Save the Emscripten cache and Naga target", "Incremental rebuild must match"]
    .map((marker) => build.indexOf(marker));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), JSON.stringify(order));
  assert.match(build, /rm -rf "\$REPRO\/em-cache" "\$REPRO\/naga-target"[\s\S]*--docker --bind-mounts --clean --jobs[\s\S]*test "\$reference" = "\$CACHED_SHA256"/);
  // Every cache write is on main only.
  for (const save of build.split("\n      - ").filter((step) => step.includes("actions/cache/save"))) {
    assert.match(save, /if: env\.PR != 'true'/);
  }
  // The GPL archive is built on main and rebuilt from alone, on main only.
  assert.match(job("rebuild-from-source-archive"), /if: github\.event_name != 'pull_request'/);
  assert.match(job("prepare-core-commit"), /needs: \[build, rebuild-from-source-archive, fetch-run-core\]/);
  // Tests always run on the core this job installed.
  assert.ok(build.indexOf("status --require-current") < build.indexOf("run: npm test"));
});

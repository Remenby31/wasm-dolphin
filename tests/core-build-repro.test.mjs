import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildIdentity, glueFacts, installCore, installRefusal, INSTALLED_FILES, resetStaleBuildTree, stampBuildTree
} from "../tools/build-core-repro.mjs";
import { readFileSync, existsSync } from "node:fs";
import { rustRemapFlags, scmGitShim, sourcePathFlags, vendoredCargoArgs } from "../tools/toolchain/path-maps.mjs";
import { spawnSync } from "node:child_process";
import { compareCoreBuildInfo } from "../tools/compare-core-builds.mjs";
import { emscriptenTreeSha256, loadWasmToolchainLock, toolchainEnvironmentOverrides } from "../tools/wasm-toolchain.mjs";

test("a macOS and a Linux build compare equal on the declared and host-independent toolchain", () => {
  const build = (platform, clangSha256) => ({
    source: { upstreamCommit: "a" },
    toolchain: {
      lockSha256: "lock",
      observed: { platform, emscriptenTreeSha256: "tree", rustcCommit: "r", hashes: { clangSha256 } }
    },
    configure: { nagaLibrarySha256: "n", wasmCompileFlags: "f", cmakeCacheSha256: platform },
    artifacts: {
      js: { sha256: "js" },
      wasm: { sha256: "wasm" },
      wasmSections: [{ id: 10, size: 1, sha256: "code" }, { id: 11, size: 1, sha256: "data" }]
    }
  });
  const report = compareCoreBuildInfo(build("darwin-arm64", "mac"), build("linux-x64", "linux"));
  assert.equal(report.reproducible, true);
  assert.equal(report.observedToolchain.emscriptenTreeSha256.equal, true);
  assert.deepEqual(report.configure, { nagaLibrarySha256: true, wasmCompileFlags: true, cmakeCacheSha256: false });
});

test("parity report reads the filesystem registry and runtime methods from the glue", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "core-glue-"));
  try {
    const glue = path.join(directory, "core.js");
    writeFileSync(glue,
      'FS.filesystems={MEMFS};Module["FS"]=FS;Module["WORKERFS"]=WORKERFS;Module["_Boot"]=_Boot;');
    assert.deepEqual(glueFacts(glue), {
      filesystems: ["MEMFS"],
      runtimeMethods: ["FS", "WORKERFS"],
      exports: ["_Boot"]
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Emscripten tree digest depends on content and relative paths only", () => {
  const make = (base) => {
    mkdirSync(path.join(base, "src/lib"), { recursive: true });
    mkdirSync(path.join(base, "tools/__pycache__"), { recursive: true });
    writeFileSync(path.join(base, "emcc.py"), "emcc");
    writeFileSync(path.join(base, "src/lib/libfs.js"), "FS");
    writeFileSync(path.join(base, "tools/__pycache__/link.pyc"), String(Math.random()));
  };
  const left = mkdtempSync(path.join(tmpdir(), "em-left-"));
  const right = mkdtempSync(path.join(tmpdir(), "em-right-"));
  try {
    make(left);
    make(right);
    assert.equal(emscriptenTreeSha256(left).sha256, emscriptenTreeSha256(right).sha256);
    assert.equal(emscriptenTreeSha256(left).files, 2);
    writeFileSync(path.join(right, "src/lib/libfs.js"), "FS,WORKERFS");
    assert.notEqual(emscriptenTreeSha256(left).sha256, emscriptenTreeSha256(right).sha256);
  } finally {
    rmSync(left, { recursive: true, force: true });
    rmSync(right, { recursive: true, force: true });
  }
});

test("every macOS/Linux platform in the toolchain lock pins the same tool set", () => {
  const lock = loadWasmToolchainLock();
  assert.match(lock.posix.emsdk.commit, /^[0-9a-f]{40}$/);
  assert.equal(lock.posix.emsdk.commit, lock.emscripten.emsdkCommit);
  assert.match(lock.posix.emscriptenTreeSha256, /^[0-9a-f]{64}$/);
  assert.match(lock.posix.rust.toolchain, /^nightly-\d{4}-\d{2}-\d{2}$/);
  const keys = ["clangSha256", "wasmLdSha256", "wasmOptSha256", "rustcSha256", "cargoSha256", "cmakeSha256", "ninjaSha256"];
  assert.ok(Object.keys(lock.posix.platforms).length > 0);
  for (const [platform, hashes] of Object.entries(lock.posix.platforms)) {
    assert.deepEqual(Object.keys(hashes).sort(), [...keys].sort(), platform);
    for (const value of Object.values(hashes)) assert.match(value, /^[0-9a-f]{64}$/, platform);
  }
});

test("checkout and build paths are mapped, except those CMake flags cannot carry", () => {
  assert.deepEqual(sourcePathFlags({ root: "/src/wd", buildDir: "/src/wd/build/x" }),
    { flags: ["-ffile-prefix-map=/src/wd=/wasm-dolphin"], unmapped: [] });
  assert.deepEqual(sourcePathFlags({ root: "C:\\wd", buildDir: "D:\\out" }).flags, [
    "-ffile-prefix-map=C:/wd=/wasm-dolphin",
    "-ffile-prefix-map=D:/out=/wasm-dolphin/build/dolphin-wasm"
  ]);
  // A Windows build directory with a space used to work; it must still build.
  const spaced = sourcePathFlags({ root: "C:\\wd", buildDir: "C:\\build output\\dolphin" });
  assert.deepEqual(spaced.flags, ["-ffile-prefix-map=C:/wd=/wasm-dolphin"]);
  assert.deepEqual(spaced.unmapped, ["C:\\build output\\dolphin"]);
});

test("vendored crates map onto the registry's virtual root, after the checkout mapping", () => {
  const flags = rustRemapFlags({
    cargoHome: "/home/u/.cargo", registryDirs: ["/home/u/.cargo/registry/src/mirror-1"],
    rustSrc: "/rs", rustcCommit: "abc", root: "/wd", vendoredCrates: "/wd/tools/naga-spirv-wgsl/vendor"
  });
  assert.deepEqual(flags, [
    "--remap-path-prefix=/home/u/.cargo=/cargo",
    "--remap-path-prefix=/home/u/.cargo/registry/src/mirror-1=/cargo/registry/src/crates.io",
    "--remap-path-prefix=/rs=/rustc/abc",
    "--remap-path-prefix=/wd=/wasm-dolphin",
    "--remap-path-prefix=/wd/tools/naga-spirv-wgsl/vendor=/cargo/registry/src/crates.io"
  ]);
  assert.deepEqual(vendoredCargoArgs("/v").slice(0, 2), ["--offline", "--config"]);
});

test("variables that redirect emcc or cargo are refused, cache relocation is not", () => {
  assert.deepEqual(toolchainEnvironmentOverrides({
    EM_BINARYEN_ROOT: "/elsewhere", RUSTFLAGS: "-C x", CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER: "ld",
    EM_CACHE: "/c", CARGO_TARGET_DIR: "/t", CARGO_HOME: "/h", EMCC_CFLAGS: "", PATH: "/bin"
  }), ["CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER", "EM_BINARYEN_ROOT", "RUSTFLAGS"]);
});

test("a CMake tree built from another checkout or patch series is emptied", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cmake-tree-"));
  try {
    const a = buildIdentity({ checkout: "/a", sourceLockSha256: "s", toolchainLockSha256: "t" });
    const b = buildIdentity({ checkout: "/b", sourceLockSha256: "s", toolchainLockSha256: "t" });
    const a2 = buildIdentity({ checkout: "/a", sourceLockSha256: "s2", toolchainLockSha256: "t" });
    assert.notEqual(a.key, b.key);
    assert.notEqual(a.key, a2.key);
    writeFileSync(path.join(dir, "core.o"), "objects of a");
    stampBuildTree(dir, a);
    assert.equal(resetStaleBuildTree(dir, a), false);
    assert.ok(existsSync(path.join(dir, "core.o")));
    assert.equal(resetStaleBuildTree(dir, b), true);
    assert.ok(!existsSync(path.join(dir, "core.o")));
    writeFileSync(path.join(dir, "core.o"), "unstamped");
    assert.equal(resetStaleBuildTree(dir, a), true, "an unstamped tree is not trusted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function installFixture() {
  const base = mkdtempSync(path.join(tmpdir(), "install-"));
  const out = path.join(base, "out");
  mkdirSync(out);
  for (const file of INSTALLED_FILES) {
    mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    writeFileSync(path.join(base, file), `old ${file}`);
  }
  for (const name of ["dolphin-core-upstream.js", "dolphin-core-upstream.wasm", "dolphin-core-upstream.build.json"]) {
    writeFileSync(path.join(out, name), `new ${name}`);
  }
  return { base, out };
}

test("a failed install restores every file it touched", () => {
  const { base, out } = installFixture();
  try {
    assert.throws(() => installCore({
      root: base,
      outputDir: out,
      validate: () => {
        writeFileSync(path.join(base, "provenance/dolphin-core-abi-v1.json"), "half-written");
        throw new Error("ABI rejected");
      }
    }), /rolled back.*ABI rejected/);
    for (const file of INSTALLED_FILES) {
      assert.equal(readFileSync(path.join(base, file), "utf8"), `old ${file}`, file);
      assert.ok(!existsSync(path.join(base, `${file}.install-tmp`)));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a validated install replaces the core artifacts", () => {
  const { base, out } = installFixture();
  try {
    installCore({ root: base, outputDir: out, validate: () => {} });
    assert.equal(readFileSync(path.join(base, "cores/dolphin/dolphin-core-upstream.wasm"), "utf8"),
      "new dolphin-core-upstream.wasm");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("install refuses a core that loses exports, runtime methods or WORKERFS", () => {
  const parity = (glue) => ({ glue: {
    exports: { onlyCommitted: [], onlyRebuilt: [] },
    runtimeMethods: { onlyCommitted: [], onlyRebuilt: [] },
    runtimeMethodsRebuilt: ["FS", "WORKERFS"],
    filesystems: { committed: ["MEMFS"], rebuilt: ["MEMFS"] },
    ...glue
  } });
  assert.equal(installRefusal(parity({})), null);
  assert.match(installRefusal(parity({ exports: { onlyCommitted: ["_Boot"], onlyRebuilt: [] } })), /_Boot/);
  assert.match(installRefusal(parity({ runtimeMethods: { onlyCommitted: ["PThread"], onlyRebuilt: [] } })), /PThread/);
  assert.match(installRefusal(parity({ runtimeMethodsRebuilt: ["FS"] })), /WORKERFS/);
});

test("the scmrev git shim answers like git on the locked, patched checkout", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scm-shim-"));
  try {
    const shim = path.join(dir, "git.sh");
    const commit = "e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1";
    writeFileSync(shim, scmGitShim(commit), { mode: 0o755 });
    const ask = (...args) => spawnSync(shim, args, { encoding: "utf8" });
    assert.equal(ask("rev-parse", "HEAD").stdout.trim(), commit);
    assert.equal(ask("describe", "--always", "--long", "--dirty").stdout.trim(), "e22551eae1-dirty");
    assert.equal(ask("rev-parse", "--abbrev-ref", "HEAD").stdout.trim(), "HEAD");
    assert.equal(ask("rev-list", "--count", "HEAD", "^master").stdout.trim(), "0");
    assert.notEqual(ask("describe", "--exact-match", "HEAD").status, 0, "no tag, like git");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

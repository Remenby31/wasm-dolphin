import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { glueFacts } from "../tools/build-core-repro.mjs";
import { compareCoreBuildInfo } from "../tools/compare-core-builds.mjs";
import { emscriptenTreeSha256, loadWasmToolchainLock } from "../tools/wasm-toolchain.mjs";

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

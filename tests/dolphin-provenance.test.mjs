import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyPinnedPatches,
  assertExactCommit,
  classifyLockedCheckout,
  fetchPinnedDolphin,
  fetchPinnedExternalRepositories,
  fileRecord,
  gitBlobSha,
  loadSourceLock,
  patchSeriesDigest,
  REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS,
  sha256Bytes,
  validateVendorSnapshotManifest,
  verifyCoreAbiManifest,
  verifyDolphinProvenance,
  verifyExternalRepositories,
  verifyPatchSeries
} from "../tools/dolphin-provenance.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitBuffer(cwd, ...args) {
  return execFileSync("git", args, { cwd });
}

function initializeRepository(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "provenance-test@example.invalid");
  git(directory, "config", "user.name", "Provenance Test");
  git(directory, "config", "core.autocrlf", "false");
}

function commitFile(directory, name, contents, message) {
  writeFileSync(join(directory, name), contents);
  git(directory, "add", name);
  git(directory, "commit", "--quiet", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function writeMinimalLock(root, { repository, commit }) {
  const patchPath = "patches/dolphin-wasm/test.patch";
  const absolutePatch = join(root, patchPath);
  mkdirSync(dirname(absolutePatch), { recursive: true });
  writeFileSync(absolutePatch, "diff --git a/a b/a\n");
  const patch = {
    order: 1,
    cwd: ".",
    path: patchPath,
    hashMode: "lf-normalized",
    ...fileRecord(patchPath, root, "lf-normalized")
  };
  const lock = {
    schemaVersion: 1,
    upstream: { repository, commit },
    repositories: { ".": { commit } },
    patches: [patch]
  };
  lock.patchSeriesSha256 = patchSeriesDigest(lock.patches);
  mkdirSync(join(root, "provenance"), { recursive: true });
  writeFileSync(join(root, "provenance/dolphin-source.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const snapshot = {
    schemaVersion: 1,
    normalization: "git-blob-lf",
    root: {
      baseCommit: commit,
      resultTree: git(repository, "rev-parse", `${commit}^{tree}`),
      changedPathCount: 0,
      records: []
    },
    submodules: []
  };
  snapshot.contentSha256 = sha256Bytes(JSON.stringify({
    root: snapshot.root,
    submodules: snapshot.submodules
  }));
  writeFileSync(
    join(root, "provenance/dolphin-vendor-snapshot-v1.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
}

function treeEntry(directory, revision, path) {
  const output = git(directory, "ls-tree", revision, "--", path);
  if (!output) {
    return null;
  }
  const match = output.match(/^(\d{6})\s+blob\s+([0-9a-f]{40})\t/);
  assert.ok(match, `expected blob entry for ${path}`);
  return { mode: match[1], blob: match[2] };
}

function stagedRecord(directory, baseCommit, path, status) {
  const staged = git(directory, "ls-files", "--stage", "--", path);
  const match = staged.match(/^(\d{6}) ([0-9a-f]{40}) \d\t/);
  assert.ok(match, `expected staged entry for ${path}`);
  const bytes = gitBuffer(directory, "cat-file", "blob", match[2]);
  const base = treeEntry(directory, baseCommit, path);
  return {
    path,
    status,
    mode: match[1],
    baseBlob: base?.blob ?? null,
    resultBlob: gitBlobSha(bytes),
    size: bytes.length,
    sha256: sha256Bytes(bytes)
  };
}

function snapshotDigest(snapshot) {
  return sha256Bytes(JSON.stringify({ root: snapshot.root, submodules: snapshot.submodules }));
}

function createLockedPatchFixture() {
  const root = mkdtempSync(join(tmpdir(), "dolphin-apply-"));
  const dolphin = join(root, "vendor/dolphin");
  const submodule = join(dolphin, "deps/sub");
  initializeRepository(dolphin);
  initializeRepository(submodule);
  const submoduleBase = commitFile(submodule, "sub.txt", "sub base\n", "sub base");

  writeFileSync(join(dolphin, ".gitignore"), "");
  writeFileSync(join(dolphin, "root.txt"), "root base\n");
  git(dolphin, "add", ".gitignore", "root.txt");
  git(dolphin, "update-index", "--add", "--cacheinfo", `160000,${submoduleBase},deps/sub`);
  git(dolphin, "commit", "--quiet", "-m", "root base");
  const rootBase = git(dolphin, "rev-parse", "HEAD");

  writeFileSync(join(submodule, "sub.txt"), "sub snapshot\n");
  git(submodule, "add", "sub.txt");
  const submoduleRecord = stagedRecord(submodule, submoduleBase, "sub.txt", "M");
  const submoduleTree = git(submodule, "write-tree");
  const submodulePatch = execFileSync(
    "git",
    ["diff", "--cached", "--binary", submoduleBase],
    { cwd: submodule, encoding: "utf8" }
  );
  git(submodule, "reset", "--hard", "--quiet", submoduleBase);

  writeFileSync(join(dolphin, "root.txt"), "root snapshot\n");
  writeFileSync(join(dolphin, "added.txt"), "added snapshot\n");
  git(dolphin, "add", "root.txt", "added.txt");
  const rootRecords = [
    stagedRecord(dolphin, rootBase, "added.txt", "A"),
    stagedRecord(dolphin, rootBase, "root.txt", "M")
  ];
  const rootTree = git(dolphin, "write-tree");
  const rootPatch = execFileSync(
    "git",
    ["diff", "--cached", "--binary", rootBase],
    { cwd: dolphin, encoding: "utf8" }
  );
  git(dolphin, "reset", "--hard", "--quiet", rootBase);

  const rootPatchPath = "patches/dolphin-wasm/snapshot/root.patch";
  const submodulePatchPath = "patches/dolphin-wasm/submodules/sub.patch";
  mkdirSync(dirname(join(root, rootPatchPath)), { recursive: true });
  mkdirSync(dirname(join(root, submodulePatchPath)), { recursive: true });
  writeFileSync(join(root, rootPatchPath), rootPatch);
  writeFileSync(join(root, submodulePatchPath), submodulePatch);
  const patches = [
    {
      order: 1,
      cwd: ".",
      hashMode: "lf-normalized",
      ...fileRecord(rootPatchPath, root, "lf-normalized")
    },
    {
      order: 2,
      cwd: "deps/sub",
      hashMode: "lf-normalized",
      ...fileRecord(submodulePatchPath, root, "lf-normalized")
    }
  ];
  const lock = {
    schemaVersion: 1,
    upstream: { repository: dolphin, commit: rootBase },
    repositories: {
      ".": { commit: rootBase },
      "deps/sub": { commit: submoduleBase }
    },
    patches,
    patchSeriesSha256: patchSeriesDigest(patches)
  };
  const snapshot = {
    schemaVersion: 1,
    normalization: "git-blob-lf",
    root: {
      baseCommit: rootBase,
      resultTree: rootTree,
      changedPathCount: rootRecords.length,
      records: rootRecords
    },
    submodules: [{
      cwd: "deps/sub",
      baseCommit: submoduleBase,
      resultTree: submoduleTree,
      records: [submoduleRecord]
    }]
  };
  snapshot.contentSha256 = snapshotDigest(snapshot);
  mkdirSync(join(root, "provenance"), { recursive: true });
  writeFileSync(join(root, "provenance/dolphin-source.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(
    join(root, "provenance/dolphin-vendor-snapshot-v1.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
  return { root, dolphin, submodule, snapshot };
}

function createDependentLockedPatchFixture() {
  const root = mkdtempSync(join(tmpdir(), "dolphin-dependent-apply-"));
  const dolphin = join(root, "vendor/dolphin");
  initializeRepository(dolphin);
  const baseCommit = commitFile(dolphin, "chain.txt", "base\n", "base");

  writeFileSync(join(dolphin, "chain.txt"), "base\nfirst\n");
  const firstPatch = execFileSync(
    "git",
    ["diff", "--binary", baseCommit, "--", "chain.txt"],
    { cwd: dolphin, encoding: "utf8" }
  );
  git(dolphin, "add", "chain.txt");

  writeFileSync(join(dolphin, "chain.txt"), "base\nfirst\nsecond\n");
  const secondPatch = execFileSync(
    "git",
    ["diff", "--binary", "--", "chain.txt"],
    { cwd: dolphin, encoding: "utf8" }
  );
  git(dolphin, "add", "chain.txt");
  const rootRecord = stagedRecord(dolphin, baseCommit, "chain.txt", "M");
  const resultTree = git(dolphin, "write-tree");
  git(dolphin, "reset", "--hard", "--quiet", baseCommit);

  const firstPatchPath = "patches/dolphin-wasm/dependent/01-first.patch";
  const secondPatchPath = "patches/dolphin-wasm/dependent/02-second.patch";
  mkdirSync(dirname(join(root, firstPatchPath)), { recursive: true });
  writeFileSync(join(root, firstPatchPath), firstPatch);
  writeFileSync(join(root, secondPatchPath), secondPatch);
  const patches = [firstPatchPath, secondPatchPath].map((path, index) => ({
    order: index + 1,
    cwd: ".",
    hashMode: "lf-normalized",
    ...fileRecord(path, root, "lf-normalized")
  }));
  const lock = {
    schemaVersion: 1,
    upstream: { repository: dolphin, commit: baseCommit },
    repositories: { ".": { commit: baseCommit } },
    patches,
    patchSeriesSha256: patchSeriesDigest(patches)
  };
  const snapshot = {
    schemaVersion: 1,
    normalization: "git-blob-lf",
    root: {
      baseCommit,
      resultTree,
      changedPathCount: 1,
      records: [rootRecord]
    },
    submodules: []
  };
  snapshot.contentSha256 = snapshotDigest(snapshot);
  const manifestPath = join(root, "provenance/dolphin-vendor-snapshot-v1.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(join(root, "provenance/dolphin-source.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return { root, dolphin, baseCommit, manifestPath, snapshot };
}

test("committed Dolphin provenance and ABI manifests verify", () => {
  const result = verifyDolphinProvenance(projectRoot);
  assert.equal(result.upstreamCommit, "e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1");
  assert.equal(result.patches.count, loadSourceLock(projectRoot).patches.length);
  assert.equal(Object.keys(result.externalRepositories).length, 2);
  // Tracks the patch series: 110 before the investigation diagnostics were
  // stripped out of 0059, which left TextureCacheBase.cpp untouched by any
  // patch, then 109. The cached-interpreter JIT patches added four paths no
  // earlier patch touched -- CachedInterpreterBlockCache.cpp/.h,
  // CachedInterpreterLink.h and WasmDeferredCompileQueue.h -- taking it to
  // 113. The exact-floating-point JIT patch (0071) also fixes the interpreter's
  // FPCC update in Interpreter_FloatingPoint.cpp: 114. 0072 hooks state loads
  // in JitInterface.cpp (the JIT warmup restarts from the loaded field): 115.
  // The GPU-sync diagnostics (0080) add WasmGpuSyncDiag.h and touch
  // PixelEngine.cpp/.h: 118. 0070 (memory card flush on request) adds three:
  // GCMemcardBase.h, GCMemcardDirectory.h and EXI_DeviceMemoryCard.h, so 121.
  // 0081 (deterministic clock and CoreTiming trace) adds WasmDetTrace.h and
  // the first changes to EXI.cpp and EXI_DeviceIPL.cpp: 124. The region
  // translator (0075) reads guest code through a hook in PPCAnalyst.cpp/.h: 126.
  // 0091 (no wasm code under the MMU) adds a test setter to System.h: 127.
  // 0099 (AX HLE timing) is the first patch to touch DSPHLE.cpp: 128.
  // 0098 (GPU thread spin budget) touches BlockingLoop.h and Fifo.h: 130.
  // 0113 (headroom counters) adds WasmHeadroom.h and the first changes to
  // BPStructs.cpp and AsyncRequests.h: 133. 0092 (bounded FIFO logs) is the
  // first patch to touch FifoDataFile.cpp and FifoPlayer.cpp: 135. 0121 (FPRF
  // follows the setting in every tier) is the first to touch PowerPC.h and
  // PowerPC.cpp: 137.
  // 0106 (static GameCube RAM views) touches Memmap.cpp/.h and DSP.cpp: 140.
  // 0150 (pacing switches) is the first patch to touch Present.cpp: 141.
  // 0162 (present cadence counters) adds WasmPresentCadence.h: 142.
  // 0164 (EFB sync counters) is the first to touch TextureCacheBase.cpp: 143.
  // 0186 (mixer queue depth, read-only) is the first to touch Mixer.h: 144.
  // 0196 (no per-game fast paths) rewords two upstream comments that named
  // a game, in FileMonitor.cpp and TMEM.cpp: 146.
  // 0211 (a late XFB shows the last picture) is the first to touch Present.h: 147.
  // Update deliberately when the series changes what it modifies.
  assert.equal(result.vendorSnapshot.rootPaths, 147);
  assert.equal(result.vendorSnapshot.submodulePaths, 2);
  assert.equal(result.core.abiVersion, 1);
  assert.equal(result.core.memoryContract.jsGlue.initialPages, 24576);
  assert.equal(result.core.memoryContract.activePatchSeries.initialPages, 24576);
  const coreAbi = JSON.parse(
    readFileSync(join(projectRoot, "provenance/dolphin-core-abi-v1.json"), "utf8")
  );
  assert.ok(
    coreAbi.contractSources.some(
      (source) => source.path === "src/wgpu-pass-package-projection.js"
    ),
    "pass-package projection must remain covered by the core ABI contract"
  );
  assert.ok(
    coreAbi.contractSources.some(
      (source) => source.path === "src/wgpu-ownership-trace.js"
    ),
    "ownership trace decoder must remain covered by the core ABI contract"
  );
  for (const path of [
    "src/incremental-sha256.js",
    "src/jit-cache-identity.js",
    "src/wgpu-consumer-reset-attestation.js",
    "src/wgpu-legacy-semantic-decoder.js",
    "src/wgpu-mapped-staging-pool.js",
    "src/wgpu-ownership-command-correlator.js",
    "src/wgpu-resource-generation-tracker.js",
    "src/wgpu-semantic-digest.js",
    "src/wgpu-semantic-parity-sink.js",
    "src/wgpu-semantic-runtime.js",
    "src/wgpu-semantic-v2-decoder.js",
    "src/wgpu-ubo-compute-projection.js",
    "src/wgpu-ubo-compute-codec.js",
    "src/wgpu-ubo-compute-reconstruction.js",
    "src/wgpu-upload-run-projection.js",
  ]) {
    assert.ok(
      coreAbi.contractSources.some((source) => source.path === path),
      `${path} must remain covered by the core ABI contract`
    );
  }
});

test("vendor snapshot manifest rejects changed per-path evidence", () => {
  const lock = loadSourceLock(projectRoot);
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, "provenance/dolphin-vendor-snapshot-v1.json"), "utf8")
  );
  manifest.root.records[0].sha256 = "0".repeat(64);
  assert.throws(() => validateVendorSnapshotManifest(manifest, lock), /content digest mismatch/);
});

test("patch verification rejects changed content and ordering", () => {
  const lock = structuredClone(loadSourceLock(projectRoot));
  lock.patches[0].sha256 = "0".repeat(64);
  lock.patchSeriesSha256 = patchSeriesDigest(lock.patches);
  assert.throws(() => verifyPatchSeries(projectRoot, lock), /SHA-256 mismatch/);

  const reordered = structuredClone(loadSourceLock(projectRoot));
  reordered.patches[0].order = 2;
  assert.throws(() => verifyPatchSeries(projectRoot, reordered), /order must be contiguous/);
});

test("LF-normalized hashes are stable across Windows and Unix checkouts", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-eol-"));
  writeFileSync(join(root, "unix.js"), "first\nsecond\n");
  writeFileSync(join(root, "windows.js"), "first\r\nsecond\r\n");
  const unix = fileRecord("unix.js", root, "lf-normalized");
  const windows = fileRecord("windows.js", root, "lf-normalized");
  assert.equal(windows.size, unix.size);
  assert.equal(windows.sha256, unix.sha256);
  assert.notEqual(fileRecord("windows.js", root).sha256, fileRecord("unix.js", root).sha256);
});

test("ABI verification rejects an artifact hash mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-abi-"));
  const manifest = JSON.parse(readFileSync(join(projectRoot, "provenance/dolphin-core-abi-v1.json"), "utf8"));
  manifest.artifacts[1].sha256 = "0".repeat(64);
  const manifestPath = join(root, "tampered-abi.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyCoreAbiManifest(projectRoot, manifestPath), /SHA-256 mismatch/);
});

test("ABI verification rejects mutations to every declared contract", () => {
  const original = JSON.parse(
    readFileSync(join(projectRoot, "provenance/dolphin-core-abi-v1.json"), "utf8")
  );
  const mutations = [
    [(manifest) => { manifest.upstreamCommit = "0".repeat(40); }, /upstream commit/],
    [(manifest) => { manifest.runtimeMethods.pop(); }, /runtime methods/],
    [(manifest) => { manifest.workerProtocol.requestTypes.pop(); }, /Worker protocol fields/],
    [(manifest) => { manifest.memoryContractStatus = "mismatch"; }, /memory-contract status/],
    [
      (manifest) => {
        manifest.moduleExports = manifest.moduleExports.filter(
          (name) => name !== REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS[0]
        );
        manifest.sourceOnlyExportsPendingRebuild =
          manifest.sourceOnlyExportsPendingRebuild.filter(
            (name) => name !== REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS[0]
          );
      },
      /Generated core Module exports do not match ABI v1/
    ]
  ];
  const temporary = mkdtempSync(join(tmpdir(), "dolphin-abi-contract-"));
  for (const [mutate, pattern] of mutations) {
    const manifest = structuredClone(original);
    mutate(manifest);
    const manifestPath = join(temporary, `${Math.random()}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verifyCoreAbiManifest(projectRoot, manifestPath), pattern);
  }
});

test("ABI verification rejects mapped staging source drift", () => {
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, "provenance/dolphin-core-abi-v1.json"), "utf8")
  );
  const stagingSource = manifest.contractSources.find(
    (source) => source.path === "src/wgpu-mapped-staging-pool.js"
  );
  assert.ok(stagingSource, "mapped staging must be declared as an ABI contract source");
  stagingSource.sha256 = "0".repeat(64);
  const temporary = mkdtempSync(join(tmpdir(), "dolphin-abi-staging-"));
  const manifestPath = join(temporary, "tampered-staging.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(
    () => verifyCoreAbiManifest(projectRoot, manifestPath),
    /SHA-256 mismatch/
  );
});

test("locked patches replay exactly, are idempotent, and reject every third checkout state", () => {
  const fixture = createLockedPatchFixture();
  const hiddenIndexCases = [
    {
      directory: fixture.dolphin,
      path: ".gitignore",
      set: "--assume-unchanged",
      clear: "--no-assume-unchanged",
      expected: /assume-unchanged/,
      dirty: "hidden-root-assume.tmp\n",
      restore: ""
    },
    {
      directory: fixture.dolphin,
      path: ".gitignore",
      set: "--skip-worktree",
      clear: "--no-skip-worktree",
      expected: /skip-worktree\/sparse/,
      dirty: "hidden-root-skip.tmp\n",
      restore: ""
    },
    {
      directory: fixture.submodule,
      path: "sub.txt",
      set: "--assume-unchanged",
      clear: "--no-assume-unchanged",
      expected: /assume-unchanged/,
      dirty: "hidden submodule assume\n",
      restore: "sub base\n"
    },
    {
      directory: fixture.submodule,
      path: "sub.txt",
      set: "--skip-worktree",
      clear: "--no-skip-worktree",
      expected: /skip-worktree\/sparse/,
      dirty: "hidden submodule skip\n",
      restore: "sub base\n"
    }
  ];
  for (const item of hiddenIndexCases) {
    git(item.directory, "update-index", item.set, "--", item.path);
    writeFileSync(join(item.directory, item.path), item.dirty);
    try {
      assert.throws(
        () => applyPinnedPatches({ root: fixture.root, dolphinDir: fixture.dolphin }),
        item.expected
      );
    } finally {
      git(item.directory, "update-index", item.clear, "--", item.path);
      writeFileSync(join(item.directory, item.path), item.restore);
    }
    assert.match(git(item.directory, "ls-files", "-v", "--", item.path), /^H /);
    assert.match(git(item.directory, "ls-files", "-t", "--", item.path), /^H /);
  }
  const intentPath = join(fixture.dolphin, "intent-to-add.tmp");
  writeFileSync(intentPath, "intent\n");
  git(fixture.dolphin, "add", "--intent-to-add", "--", "intent-to-add.tmp");
  try {
    assert.throws(
      () => applyPinnedPatches({ root: fixture.root, dolphinDir: fixture.dolphin }),
      /intent-to-add/
    );
  } finally {
    git(fixture.dolphin, "reset", "--", "intent-to-add.tmp");
    rmSync(intentPath);
  }
  assert.equal(classifyLockedCheckout(fixture.dolphin, fixture.root).state, "pristine");
  const replay = applyPinnedPatches({ root: fixture.root, dolphinDir: fixture.dolphin });
  assert.equal(replay.status, "applied");
  assert.equal(replay.resultTree, fixture.snapshot.root.resultTree);
  const applied = classifyLockedCheckout(fixture.dolphin, fixture.root);
  assert.equal(applied.state, "snapshot");
  assert.equal(applied.rootTree, fixture.snapshot.root.resultTree);
  assert.equal(
    applied.submoduleTrees["deps/sub"],
    fixture.snapshot.submodules[0].resultTree
  );
  const idempotent = applyPinnedPatches({ root: fixture.root, dolphinDir: fixture.dolphin });
  assert.equal(idempotent.status, "already-applied");
  assert.equal(idempotent.resultTree, fixture.snapshot.root.resultTree);

  writeFileSync(join(fixture.dolphin, ".gitignore"), "hostile-sentinel.tmp\n");
  writeFileSync(join(fixture.dolphin, "hostile-sentinel.tmp"), "must not survive validation\n");
  assert.throws(
    () => applyPinnedPatches({ root: fixture.root, dolphinDir: fixture.dolphin }),
    /checkout status does not match.*\.gitignore/s
  );
  writeFileSync(join(fixture.dolphin, ".gitignore"), "");
  rmSync(join(fixture.dolphin, "hostile-sentinel.tmp"));

  writeFileSync(join(fixture.submodule, "extra.tmp"), "extra\n");
  assert.throws(
    () => classifyLockedCheckout(fixture.dolphin, fixture.root),
    /deps\/sub checkout status.*extra\.tmp/s
  );
  rmSync(join(fixture.submodule, "extra.tmp"));

  const manifestPath = join(fixture.root, "provenance/dolphin-vendor-snapshot-v1.json");
  const badTree = structuredClone(fixture.snapshot);
  badTree.root.resultTree = "0".repeat(40);
  badTree.contentSha256 = snapshotDigest(badTree);
  writeFileSync(manifestPath, `${JSON.stringify(badTree, null, 2)}\n`);
  assert.throws(
    () => classifyLockedCheckout(fixture.dolphin, fixture.root),
    /virtual result tree mismatch/
  );

  const badSubmoduleTree = structuredClone(fixture.snapshot);
  badSubmoduleTree.submodules[0].resultTree = "0".repeat(40);
  badSubmoduleTree.contentSha256 = snapshotDigest(badSubmoduleTree);
  writeFileSync(manifestPath, `${JSON.stringify(badSubmoduleTree, null, 2)}\n`);
  assert.throws(
    () => classifyLockedCheckout(fixture.dolphin, fixture.root),
    /deps\/sub virtual result tree mismatch/
  );

  writeFileSync(manifestPath, `${JSON.stringify(fixture.snapshot, null, 2)}\n`);
  writeFileSync(join(fixture.dolphin, "root.txt"), "tampered snapshot\n");
  assert.throws(
    () => classifyLockedCheckout(fixture.dolphin, fixture.root),
    /result blob mismatch/
  );
});

test("locked patch replay applies dependent patches in order and rolls back failed attestation", () => {
  const fixture = createDependentLockedPatchFixture();
  try {
    const replay = applyPinnedPatches({ root: fixture.root, dolphinDir: fixture.dolphin });
    assert.equal(replay.status, "applied");
    assert.equal(replay.resultTree, fixture.snapshot.root.resultTree);
    assert.equal(readFileSync(join(fixture.dolphin, "chain.txt"), "utf8"), "base\nfirst\nsecond\n");

    git(fixture.dolphin, "reset", "--hard", "--quiet", fixture.baseCommit);
    const rejectedSnapshot = structuredClone(fixture.snapshot);
    rejectedSnapshot.root.resultTree = git(fixture.dolphin, "rev-parse", `${fixture.baseCommit}^{tree}`);
    rejectedSnapshot.contentSha256 = snapshotDigest(rejectedSnapshot);
    writeFileSync(fixture.manifestPath, `${JSON.stringify(rejectedSnapshot, null, 2)}\n`);

    assert.throws(
      () => applyPinnedPatches({ root: fixture.root, dolphinDir: fixture.dolphin }),
      /virtual result tree mismatch/
    );
    assert.equal(git(fixture.dolphin, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal(readFileSync(join(fixture.dolphin, "chain.txt"), "utf8"), "base\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pinned fetch ignores a moved default branch and checks out the locked commit", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-fetch-"));
  const origin = join(root, "origin");
  initializeRepository(origin);
  writeFileSync(join(origin, ".gitignore"), "");
  writeFileSync(join(origin, "source.txt"), "pinned\n");
  git(origin, "add", ".gitignore", "source.txt");
  git(origin, "commit", "--quiet", "-m", "pinned");
  const pinned = git(origin, "rev-parse", "HEAD");
  const moved = commitFile(origin, "source.txt", "moved\n", "moved");
  assert.notEqual(pinned, moved);

  const harness = join(root, "harness");
  mkdirSync(harness);
  writeMinimalLock(harness, { repository: origin, commit: pinned });
  const destination = join(harness, "vendor/dolphin");
  const result = fetchPinnedDolphin({
    root: harness,
    destination,
    repository: origin,
    updateSubmodules: false
  });
  assert.equal(result.commit, pinned);
  assert.equal(git(destination, "rev-parse", "HEAD"), pinned);
  assert.equal(readFileSync(join(destination, "source.txt"), "utf8").trim(), "pinned");
  assert.throws(() => assertExactCommit(pinned, moved), /commit mismatch/);

  git(destination, "update-index", "--assume-unchanged", "--", ".gitignore");
  writeFileSync(join(destination, ".gitignore"), "hidden-fetch.tmp\n");
  try {
    assert.throws(
      () => fetchPinnedDolphin({
        root: harness,
        destination,
        repository: origin,
        updateSubmodules: false
      }),
      /Nonstandard Git index flags.*assume-unchanged/s
    );
  } finally {
    git(destination, "update-index", "--no-assume-unchanged", "--", ".gitignore");
    writeFileSync(join(destination, ".gitignore"), "");
  }
  assert.match(git(destination, "ls-files", "-v", "--", ".gitignore"), /^H /);

  writeFileSync(join(destination, ".gitignore"), "hostile-sentinel.tmp\n");
  writeFileSync(join(destination, "hostile-sentinel.tmp"), "hidden extra\n");
  assert.throws(
    () => fetchPinnedDolphin({
      root: harness,
      destination,
      repository: origin,
      updateSubmodules: false
    }),
    /checkout status does not match.*\.gitignore/s
  );
  assert.equal(git(destination, "rev-parse", "HEAD"), pinned);

  const beforeSwitch = join(harness, "vendor/before-switch");
  git(harness, "clone", "--quiet", origin, beforeSwitch);
  writeFileSync(join(beforeSwitch, "untracked-before-switch.tmp"), "extra\n");
  assert.throws(
    () => fetchPinnedDolphin({
      root: harness,
      destination: beforeSwitch,
      repository: origin,
      updateSubmodules: false
    }),
    /Refusing non-pristine Dolphin checkout/
  );
  assert.equal(git(beforeSwitch, "rev-parse", "HEAD"), moved);
});

test("pinned external source repositories are fetched and fail closed on drift", () => {
  const root = mkdtempSync(join(tmpdir(), "dolphin-external-fetch-"));
  const origin = join(root, "tool.git");
  initializeRepository(origin);
  const pinned = commitFile(origin, "tool.txt", "pinned tool\n", "pinned tool");

  const harness = join(root, "harness");
  const upstream = join(root, "upstream");
  initializeRepository(upstream);
  const upstreamCommit = commitFile(upstream, ".gitignore", "", "upstream");
  writeMinimalLock(harness, { repository: upstream, commit: upstreamCommit });
  const lockPath = join(harness, "provenance/dolphin-source.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.externalRepositories = {
    "External/tool": {
      repository: pathToFileURL(origin).href,
      commit: pinned
    }
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const dolphin = join(harness, "vendor/dolphin");
  mkdirSync(dolphin, { recursive: true });
  const fetched = fetchPinnedExternalRepositories(dolphin, loadSourceLock(harness));
  assert.equal(git(join(dolphin, "External/tool"), "rev-parse", "HEAD"), pinned);
  assert.match(fetched["External/tool"], /^[0-9a-f]{40}$/);

  writeFileSync(join(dolphin, "External/tool/drift.tmp"), "drift\n");
  assert.throws(
    () => verifyExternalRepositories(dolphin, loadSourceLock(harness)),
    /checkout status.*drift\.tmp/s
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABI_PATH, CORE_BINARY_FILES, CORE_DERIVED_FILES, coreArtifactChanges, coreStatus, fetchCore, publishPlan,
  resolvePinConflict, restoreCoreFromBase, stagedCoreArtifactChanges
} from "../tools/core-artifacts.mjs";
import { CORE_LOCK_PATH, formatCoreLock } from "../tools/core-lock.mjs";
import { DEFAULT_UPSTREAM_CORE_SHA256 } from "../src/upstream-worker-protocol.js";

const PROTOCOL_PATH = "src/upstream-worker-protocol.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// A miniature repository with the core-derived files, where "a core" is a
// distinct .wasm byte string.
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "core-artifacts-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  const write = (relative, content) => {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    writeFileSync(path.join(dir, relative), content);
  };
  const installCore = (wasm, exports) => {
    const hash = sha256(wasm);
    write(CORE_BINARY_FILES[0], `// glue for ${wasm}\n`);
    write(CORE_BINARY_FILES[1], wasm);
    write(CORE_BINARY_FILES[2], JSON.stringify({ coreId: `sha256:${hash}` }, null, 2));
    write(CORE_LOCK_PATH, formatCoreLock(hash));
    if (!existsSync(path.join(dir, PROTOCOL_PATH))) write(PROTOCOL_PATH, "export const other = 1;\n");
    const abi = existsSync(path.join(dir, ABI_PATH))
      ? JSON.parse(readFileSync(path.join(dir, ABI_PATH), "utf8"))
      : { schemaVersion: 1, contractSources: [{ path: PROTOCOL_PATH, size: 0, sha256: "" }], workerProtocol: { a: 1 } };
    Object.assign(abi, { coreId: `sha256:${hash}`, artifacts: [{ sha256: hash }], moduleExports: exports,
      runtimeMethods: ["FS"], memoryContract: { pages: 1 }, memoryContractStatus: "ok" });
    write(ABI_PATH, JSON.stringify(abi, null, 2));
    return hash;
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, write, installCore, commit };
}

test("a branch that rebuilds the core is flagged; one that only changes sources is not", async () => {
  const f = fixture();
  try {
    f.installCore("core-A", ["_Boot"]);
    f.commit("main core A");
    f.git("checkout", "-q", "-b", "sources-only");
    f.write("core/upstream/shim.cpp", "int x;");
    f.commit("change sources");
    assert.deepEqual(await coreArtifactChanges({ base: "main", cwd: f.dir }), []);

    f.git("checkout", "-q", "-b", "with-binary");
    f.installCore("core-B", ["_Boot", "_SetPadState"]);
    f.commit("rebuild the core");
    const changes = await coreArtifactChanges({ base: "main", cwd: f.dir });
    assert.ok(changes.includes("cores/dolphin/dolphin-core-upstream.wasm"));
    assert.ok(changes.includes(CORE_LOCK_PATH));
    assert.ok(changes.includes(`${ABI_PATH} (moduleExports)`));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a branch that started before main's newer core is not flagged for it", async () => {
  const f = fixture();
  try {
    f.installCore("core-A", ["_Boot"]);
    f.commit("core A");
    f.git("checkout", "-q", "-b", "feature");
    f.write("core/upstream/shim.cpp", "int x;");
    f.commit("sources");
    f.git("checkout", "-q", "main");
    f.installCore("core-C", ["_Boot"]);
    f.commit("CI commits core C");
    f.git("checkout", "-q", "feature");
    assert.deepEqual(await coreArtifactChanges({ base: "main", cwd: f.dir }), [], "still core A, untouched");
    await restoreCoreFromBase({ base: "main", cwd: f.dir });
    f.commit("take main's core");
    assert.deepEqual(await coreArtifactChanges({ base: "main", cwd: f.dir }), [], "main's current core is allowed");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("restore drops the branch's core but keeps its new exports as pending rebuild", async () => {
  const f = fixture();
  try {
    const mainHash = f.installCore("core-A", ["_Boot"]);
    f.commit("core A");
    f.git("checkout", "-q", "-b", "pads");
    f.installCore("core-B", ["_Boot", "_SetPadState"]);
    f.write(PROTOCOL_PATH, readFileSync(path.join(f.dir, PROTOCOL_PATH), "utf8").replace("other = 1", "other = 2"));
    f.commit("pads, with a rebuilt core");

    const result = await restoreCoreFromBase({ base: "main", cwd: f.dir });
    assert.deepEqual(result.pendingExports, ["_SetPadState"]);
    for (const file of CORE_DERIVED_FILES) {
      assert.equal(f.git("diff", "--quiet", "main", "--", file), "", file);
    }
    assert.equal(JSON.parse(readFileSync(path.join(f.dir, CORE_LOCK_PATH), "utf8")).sha256, mainHash);
    const protocol = readFileSync(path.join(f.dir, PROTOCOL_PATH), "utf8");
    assert.match(protocol, /other = 2/, "the branch's own source change stays");
    const abi = JSON.parse(readFileSync(path.join(f.dir, ABI_PATH), "utf8"));
    assert.deepEqual(abi.moduleExports, ["_Boot"]);
    assert.equal(abi.contractSources[0].sha256, sha256(protocol), "contract hashes follow the restored file");
    f.commit("restore");
    assert.deepEqual(await coreArtifactChanges({ base: "main", cwd: f.dir }), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a branch from before core.lock.json migrates in one merge with core:restore", async () => {
  const f = fixture();
  try {
    // main before the scheme: the pin is a JavaScript declaration.
    const oldPin = (hash) => `export const DEFAULT_UPSTREAM_CORE_SHA256 = "${hash}";\nexport const other = 1;\n`;
    f.installCore("core-A", ["_Boot"]);
    f.write(PROTOCOL_PATH, oldPin(sha256("core-A")));
    f.commit("old main");
    // A feature branch rebuilds the core and changes the ABI's sources.
    f.git("checkout", "-q", "-b", "feature");
    f.installCore("core-B", ["_Boot", "_New"]);
    f.write(PROTOCOL_PATH, oldPin(sha256("core-B")));
    f.write("src/feature.js", "export const feature = 1;\n");
    const abi = JSON.parse(readFileSync(path.join(f.dir, ABI_PATH), "utf8"));
    abi.workerProtocol = { a: 2 };
    f.write(ABI_PATH, JSON.stringify(abi, null, 2));
    f.commit("feature with its own core");
    // main adopts the scheme and gets a newer core.
    f.git("checkout", "-q", "main");
    const mainHash = f.installCore("core-C", ["_Boot"]);
    f.write(PROTOCOL_PATH, '// comment\nimport coreLock from "../cores/dolphin/core.lock.json" with { type: "json" };\n' +
      "export const DEFAULT_UPSTREAM_CORE_SHA256 = coreLock.sha256;\nexport const other = 1;\n");
    f.commit("main: core.lock.json");

    f.git("checkout", "-q", "feature");
    spawnSync("git", ["merge", "-q", "main"], { cwd: f.dir });  // conflicts expected
    const result = await restoreCoreFromBase({ base: "main", cwd: f.dir });
    assert.deepEqual(result.pendingExports, ["_New"]);
    assert.equal(f.git("diff", "--name-only", "--diff-filter=U"), "", "every conflict is resolved");
    f.git("commit", "-q", "--no-edit");
    assert.deepEqual(await coreArtifactChanges({ base: "main", cwd: f.dir }), []);
    const merged = JSON.parse(readFileSync(path.join(f.dir, ABI_PATH), "utf8"));
    assert.deepEqual(merged.workerProtocol, { a: 2 }, "the branch's source-side ABI change is kept");
    assert.equal(merged.coreId, `sha256:${mainHash}`);
    assert.match(readFileSync(path.join(f.dir, PROTOCOL_PATH), "utf8"), /coreLock\.sha256/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("only the pin hunk is resolved; any other protocol conflict is left to the user", () => {
  const pin = `export const DEFAULT_UPSTREAM_CORE_SHA256 = "${"a".repeat(64)}";\n`;
  const lock = 'import coreLock from "../cores/dolphin/core.lock.json" with { type: "json" };\n';
  const resolved = resolvePinConflict(`x\n<<<<<<< HEAD\n${pin}=======\n${lock}>>>>>>> main\ny\n`);
  assert.equal(resolved, `x\n${lock}y\n`);
  const other = `<<<<<<< HEAD\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> main\n`;
  assert.equal(resolvePinConflict(other), other);
  const mixed = `<<<<<<< HEAD\n${pin}export const a = 1;\n=======\n${lock}>>>>>>> main\n`;
  assert.equal(resolvePinConflict(mixed), mixed, "a hunk with more than the pin is not touched");
});

test("the pre-commit check sees a staged core, not an unstaged one", async () => {
  const f = fixture();
  try {
    f.installCore("core-A", ["_Boot"]);
    f.commit("core A");
    f.installCore("core-B", ["_Boot"]);
    assert.deepEqual(await stagedCoreArtifactChanges({ cwd: f.dir }), []);
    f.git("add", CORE_BINARY_FILES[1]);
    assert.deepEqual(await stagedCoreArtifactChanges({ cwd: f.dir }), [CORE_BINARY_FILES[1]]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("any core main ever carried can be fetched by hash from history", async () => {
  const f = fixture();
  try {
    const old = f.installCore("core-A", ["_Boot"]);
    f.commit("core A");
    f.installCore("core-C", ["_Boot"]);
    f.commit("core C");
    const result = fetchCore(old, { cwd: f.dir });
    assert.match(result.source, /^git /);
    assert.equal(readFileSync(path.join(result.destination, "dolphin-core-upstream.wasm"), "utf8"), "core-A");
    assert.equal(fetchCore(old, { cwd: f.dir }).source, "local candidate");
    assert.throws(() => fetchCore("0".repeat(64), { cwd: f.dir }), /is not in/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// Whether this checkout's committed core is current is not asserted here: on a
// branch that changes the C++ it is not, by design. CI checks it after
// installing the core it built, and before committing a core on main.
test("status: a copy of a current core is current, and a changed shim makes it stale", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "core-status-"));
  try {
    for (const relative of [
      ...CORE_DERIVED_FILES, ABI_PATH, "core/upstream", "tools/jit-cache-prejs.js",
      "provenance/dolphin-source.lock.json", "provenance/dolphin-vendor-snapshot-v1.json",
      "provenance/wasm-toolchain.lock.json", "tools/naga-spirv-wgsl/Cargo.lock"
    ]) {
      cpSync(path.join(repoRoot, relative), path.join(dir, relative), { recursive: true });
    }
    const before = await coreStatus(dir);
    writeFileSync(path.join(dir, "core/upstream/dolphin_web_discio.cpp"), "// edited\n", { flag: "a" });
    const status = await coreStatus(dir);
    assert.equal(status.current, false);
    assert.deepEqual(status.reasons.filter((reason) => !before.reasons.includes(reason)),
      ["source.localInputsSha256 differs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default core hash is data: the module exports core.lock.json, and tools never parse JavaScript", async () => {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, CORE_LOCK_PATH), "utf8"));
  assert.deepEqual(Object.keys(lock).sort(), ["schemaVersion", "sha256"]);
  assert.equal(DEFAULT_UPSTREAM_CORE_SHA256, lock.sha256);
  // No tool reads or writes the pin through JavaScript. (core:restore
  // recognises the old declaration only inside a merge-conflict hunk, to
  // migrate a branch; see the next tests.)
  for (const tool of ["tools/update-core-abi.mjs", "tools/core-lock.mjs"]) {
    assert.doesNotMatch(readFileSync(path.join(repoRoot, tool), "utf8"), /DEFAULT_UPSTREAM_CORE_SHA256/, tool);
  }
  for (const tool of ["tools/core-artifacts.mjs", "tools/update-core-abi.mjs", "tools/core-lock.mjs"]) {
    assert.doesNotMatch(readFileSync(path.join(repoRoot, tool), "utf8"), /import\(`data:|\beval\(|new Function/, tool);
  }
  assert.ok(!existsSync(path.join(repoRoot, "tools/core-pin.mjs")));
  // A malformed lock makes the core not current instead of being guessed at.
  const dir = mkdtempSync(path.join(tmpdir(), "lock-"));
  try {
    for (const relative of [...CORE_DERIVED_FILES, ABI_PATH, "core/upstream", "tools/jit-cache-prejs.js",
      "provenance/dolphin-source.lock.json", "provenance/dolphin-vendor-snapshot-v1.json",
      "provenance/wasm-toolchain.lock.json", "tools/naga-spirv-wgsl/Cargo.lock"]) {
      cpSync(path.join(repoRoot, relative), path.join(dir, relative), { recursive: true });
    }
    writeFileSync(path.join(dir, CORE_LOCK_PATH), JSON.stringify({ schemaVersion: 1, sha256: lock.sha256, note: "x" }));
    assert.ok((await coreStatus(dir)).reasons.some((reason) => reason.includes("core.lock.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function publishFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "publish-"));
  const artifact = path.join(dir, "artifact");
  mkdirSync(artifact);
  for (const file of CORE_DERIVED_FILES) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), "committed");
    writeFileSync(path.join(artifact, path.basename(file)), "built");
  }
  writeFileSync(path.join(artifact, "dolphin-core-upstream.build.json"), "{}");
  return { dir, artifact };
}

test("publishing decides on content, and refuses a build of other sources before installing anything", async () => {
  const { dir, artifact } = publishFixture();
  try {
    const commits = [];
    const identity = { same: true };
    const run = (statusFor) => publishPlan({
      artifactDir: artifact, cwd: dir,
      status: async (cwd) => statusFor(readFileSync(path.join(cwd, CORE_BINARY_FILES[1]), "utf8")),
      identityDifferences: () => (identity.same ? [] : ["source.patchSeriesSha256 differs"]),
      regenerate: () => {
        // A core that HEAD's sources no longer accept makes update-core-abi
        // throw; that must never be reached when the sources differ.
        if (!identity.same) throw new Error("regenerate ran on a core built from other sources");
      },
      commit: (message) => commits.push(message)
    });
    const buildRecord = path.join(dir, CORE_BINARY_FILES[2]);
    const committedOn = (platform) => writeFileSync(buildRecord, JSON.stringify({ toolchain: { observed: { platform } } }));
    committedOn("linux-x64");
    const none = await run(() => ({ current: true, coreId: "sha256:committed" }));
    assert.equal(none.action, "none");
    assert.equal(none.coreId, "sha256:committed");
    assert.equal(commits.length, 0);
    committedOn("linux-x64");

    identity.same = false;
    const handedOver = await run(() => ({ current: false, reasons: ["stale"] }));
    assert.equal(handedOver.action, "dispatch");
    assert.deepEqual(handedOver.reasons, ["source.patchSeriesSha256 differs"]);
    assert.equal(readFileSync(path.join(dir, CORE_BINARY_FILES[1]), "utf8"), "committed", "nothing installed");

    identity.same = true;
    const committed = await run((wasm) => ({ current: wasm === "built", coreId: "sha256:built", reasons: [] }));
    assert.equal(committed.action, "commit");
    assert.equal(committed.coreId, "sha256:built");
    assert.equal(commits.length, 1);

    for (const file of CORE_DERIVED_FILES) writeFileSync(path.join(dir, file), "committed");
    await assert.rejects(run(() => ({ current: false, reasons: ["abi"] })), /not current/,
      "an inconsistency after install fails loudly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a current core built on another platform is replaced by CI's build of the same sources", async () => {
  const { dir, artifact } = publishFixture();
  try {
    writeFileSync(path.join(dir, CORE_BINARY_FILES[2]),
      JSON.stringify({ toolchain: { observed: { platform: "darwin-arm64" } } }));
    const commits = [];
    const plan = await publishPlan({
      artifactDir: artifact, cwd: dir,
      // The darwin core is the build of the sources; so is CI's.
      status: async () => ({ current: true, coreId: "sha256:x", reasons: [] }),
      identityDifferences: () => [], regenerate: () => {}, commit: (message) => commits.push(message)
    });
    assert.equal(plan.action, "commit");
    assert.match(plan.reason, /darwin-arm64 build of the same sources with the linux-x64 build/);
    assert.equal(readFileSync(path.join(dir, CORE_BINARY_FILES[1]), "utf8"), "built");
    assert.equal(commits.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish-plan writes one validated JSON plan and fails without one", () => {
  const cli = (args) => spawnSync(process.execPath, [path.join(repoRoot, "tools/core-artifacts.mjs"), "publish-plan", ...args],
    { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(cli(["--artifact", "/nonexistent"]).status, 0, "--out is required");
  const out = path.join(mkdtempSync(path.join(tmpdir(), "plan-")), "plan.json");
  // With a current linux-x64 core committed, the plan is "none" without
  // reading the artifact. Otherwise (a core built elsewhere) it needs the
  // artifact, which does not exist here: planning fails and writes nothing.
  const result = cli(["--artifact", "/nonexistent", "--out", out]);
  if (result.status === 0) {
    const plan = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(plan.action, "none");
    assert.match(plan.coreId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.stdout, "", "stdout carries nothing besides the plan file");
  } else {
    assert.ok(!existsSync(out), "no plan is written when planning fails");
  }
});

// The privileged step, run for real: its shell, against a local bare
// repository standing in for GitHub, with gh replaced by a recorder.
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/core-build.yml"), "utf8");
function pushStepScript() {
  const start = workflow.indexOf("      - name: Push the core commit");
  const body = workflow.slice(workflow.indexOf("        run: |\n", start) + "        run: |\n".length);
  const lines = [];
  for (const line of body.split("\n")) {
    if (line.trim() && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

function pushFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "push-core-"));
  const sh = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  sh(dir, "init", "-q", "--bare", "-b", "main", remote);
  sh(dir, "init", "-q", "-b", "main", work);
  sh(work, "config", "user.email", "t@example.invalid");
  sh(work, "config", "user.name", "t");
  const write = (relative, content) => {
    mkdirSync(path.dirname(path.join(work, relative)), { recursive: true });
    writeFileSync(path.join(work, relative), content);
  };
  write("src/app.js", "1");
  for (const file of [...CORE_DERIVED_FILES, ABI_PATH]) write(file, "old");
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "main");
  sh(work, "push", "-q", `file://${remote}`, "main");
  const base = sh(work, "rev-parse", "HEAD");
  const publish = path.join(dir, "publish");
  mkdirSync(publish);
  const prepare = (files, action = "commit", { modes = {}, bundleRefs = [`${base}..HEAD`] } = {}) => {
    for (const [relative, content] of Object.entries(files)) write(relative, content);
    sh(work, "add", "-A");
    for (const [relative, mode] of Object.entries(modes)) {
      const blob = sh(work, "hash-object", "-w", path.join(work, relative));
      sh(work, "update-index", "--cacheinfo", `${mode},${blob},${relative}`);
    }
    sh(work, "commit", "-q", "-m", "core");
    sh(work, "bundle", "create", path.join(publish, "core.bundle"), ...bundleRefs);
    writeFileSync(path.join(publish, "plan.json"), JSON.stringify({ schemaVersion: 1, action }));
  };
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${path.join(dir, "gh.log")}"\n`, { mode: 0o755 });
  // A hook a hostile earlier step might have planted in the global config.
  const hooks = path.join(dir, "hooks");
  mkdirSync(hooks);
  writeFileSync(path.join(hooks, "pre-push"), `#!/bin/sh\ntouch "${path.join(dir, "hook-ran")}"\n`, { mode: 0o755 });
  writeFileSync(path.join(dir, "gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
  const run = ({ action = "commit", attempt = 0, sha }) => spawnSync("bash", ["-c", pushStepScript()], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"),
      ACTION: action, BASE: base, SHA256: sha, ATTEMPT: String(attempt), PUBLISH: publish,
      REMOTE: `file://${remote}`, TOKEN: "dummy-token", GITHUB_REPOSITORY: "o/r" }
  });
  const ghCalls = () => (existsSync(path.join(dir, "gh.log")) ? readFileSync(path.join(dir, "gh.log"), "utf8") : "");
  const remoteHead = () => sh(remote, "rev-parse", "main");
  return { dir, base, work, sh, write, prepare, run, ghCalls, remoteHead, remote };
}

test("push-core pushes a valid core commit with hooks off, and nothing else", () => {
  const f = pushFixture();
  try {
    const hash = sha256("new core");
    f.prepare({ [CORE_BINARY_FILES[1]]: "new core", [CORE_LOCK_PATH]: formatCoreLock(hash) });
    const ok = f.run({ sha: hash });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.equal(f.remoteHead(), f.sh(f.work, "rev-parse", "HEAD"));
    assert.ok(!existsSync(path.join(f.dir, "hook-ran")), "no hook ran with the token");
    assert.equal(f.ghCalls(), "");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("push-core refuses a bundle that touches other files or carries another core", () => {
  for (const [files, sha] of [
    [{ [CORE_BINARY_FILES[1]]: "new core", [CORE_LOCK_PATH]: formatCoreLock(sha256("new core")), "src/app.js": "2" },
      sha256("new core")],
    [{ [CORE_BINARY_FILES[1]]: "new core", [CORE_LOCK_PATH]: formatCoreLock(sha256("other")) }, sha256("new core")],
    [{ [CORE_BINARY_FILES[1]]: "new core", [CORE_LOCK_PATH]: formatCoreLock(sha256("new core")) }, sha256("other")]
  ]) {
    const f = pushFixture();
    try {
      const before = f.remoteHead();
      f.prepare(files);
      assert.notEqual(f.run({ sha }).status, 0);
      assert.equal(f.remoteHead(), before, "nothing pushed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("push-core refuses core files that are not plain 100644 blobs", () => {
  const files = { [CORE_BINARY_FILES[1]]: "new core", [CORE_LOCK_PATH]: formatCoreLock(sha256("new core")) };
  for (const modes of [
    { [CORE_BINARY_FILES[0]]: "100755" },
    { [CORE_BINARY_FILES[2]]: "120000" },
    { [ABI_PATH]: "160000" }
  ]) {
    const f = pushFixture();
    try {
      const before = f.remoteHead();
      f.prepare(files, "commit", { modes });
      assert.notEqual(f.run({ sha: sha256("new core") }).status, 0, JSON.stringify(modes));
      assert.equal(f.remoteHead(), before, "nothing pushed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("push-core refuses a missing bundle or one with other refs than HEAD", () => {
  const files = { [CORE_BINARY_FILES[1]]: "new core", [CORE_LOCK_PATH]: formatCoreLock(sha256("new core")) };
  for (const variant of ["missing", "extra-ref", "branch-only"]) {
    const f = pushFixture();
    try {
      const before = f.remoteHead();
      if (variant === "extra-ref") {
        // A second ref with content of its own: an empty range would be
        // dropped by git bundle create and prove nothing.
        f.sh(f.work, "checkout", "-q", "-b", "smuggled");
        f.sh(f.work, "commit", "-q", "--allow-empty", "-m", "smuggled");
        f.sh(f.work, "checkout", "-q", "main");
        f.prepare(files, "commit", { bundleRefs: [`${f.base}..HEAD`, `${f.base}..smuggled`] });
      } else if (variant === "branch-only") {
        f.prepare(files, "commit", { bundleRefs: [`${f.base}..main`] });
      } else {
        f.prepare(files);
        rmSync(path.join(f.dir, "publish/core.bundle"));
      }
      const result = f.run({ sha: sha256("new core") });
      assert.notEqual(result.status, 0, variant);
      assert.equal(f.remoteHead(), before, `${variant}: nothing pushed`);
      assert.equal(f.ghCalls(), "", `${variant}: no hand-over either`);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("push-core hands over when main moved or sources changed, at most 3 times", () => {
  const f = pushFixture();
  try {
    const hash = sha256("new core");
    f.prepare({ [CORE_BINARY_FILES[1]]: "new core", [CORE_LOCK_PATH]: formatCoreLock(hash) });
    // main moves after the commit was prepared.
    const other = path.join(f.dir, "other");
    f.sh(f.dir, "clone", "-q", `file://${f.remote}`, other);
    f.sh(other, "-c", "user.email=t@x", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "moved");
    f.sh(other, "push", "-q", "origin", "main");
    const moved = f.run({ sha: hash, attempt: 1 });
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(f.ghCalls(), /workflow run core-build\.yml .*--ref main -f attempt=2/);

    // A plan that disagrees with the job's input is refused, not acted on.
    assert.notEqual(f.run({ sha: hash, action: "dispatch", attempt: 2 }).status, 0);
    assert.doesNotMatch(f.ghCalls(), /attempt=3/);
    writeFileSync(path.join(f.dir, "publish/plan.json"), JSON.stringify({ schemaVersion: 1, action: "dispatch" }));
    const sources = f.run({ sha: hash, action: "dispatch", attempt: 2 });
    assert.equal(sources.status, 0, sources.stderr);
    assert.match(f.ghCalls(), /attempt=3/);

    const exhausted = f.run({ sha: hash, action: "dispatch", attempt: 3 });
    assert.notEqual(exhausted.status, 0, "the fourth hand-over fails the job instead");
    assert.doesNotMatch(f.ghCalls(), /attempt=4/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("main's runs build main's tip, queue, and keep the token out of every job that runs repository code", () => {
  assert.doesNotMatch(workflow, /head_commit\.author|github\.event\.commits/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  rebuild-from-source-archive:")),
    /ref: \$\{\{ github\.ref == 'refs\/heads\/main' && 'refs\/heads\/main' \|\| '' \}\}/);
  const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/);
  for (const job of jobs) {
    const writes = /contents: write|actions: write/.test(job);
    const name = job.split(":")[0].trim();
    if (name === "push-core") {
      assert.ok(writes);
      assert.doesNotMatch(job, /actions\/checkout|node |npm /, "push-core runs no repository code");
      assert.match(job, /core\.hooksPath=\/dev\/null/);
      assert.match(job, /set -euo pipefail/);
    } else {
      assert.ok(!writes, `${name} must not be able to write`);
    }
  }
  const prepare = jobs.find((job) => job.startsWith("prepare-core-commit:"));
  assert.match(prepare, /set -euo pipefail/);
  assert.match(prepare, /jq -er '\.action/);
  assert.doesNotMatch(prepare, /github\.token|secrets\./);
});

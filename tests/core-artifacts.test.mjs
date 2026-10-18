import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABI_PATH, CORE_BINARY_FILES, coreArtifactChanges, coreStatus, fetchCore, PROTOCOL_PATH, publishPlan,
  restoreCoreFromBase, stagedCoreArtifactChanges
} from "../tools/core-artifacts.mjs";
import { evaluatedCoreHash, pinnedCoreHash, withPinnedCoreHash } from "../tools/core-pin.mjs";

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
    const protocol = existsSync(path.join(dir, PROTOCOL_PATH))
      ? readFileSync(path.join(dir, PROTOCOL_PATH), "utf8")
      : 'export const DEFAULT_UPSTREAM_CORE_SHA256 = "";\nexport const other = 1;\n';
    write(PROTOCOL_PATH, protocol.replace(/(DEFAULT_UPSTREAM_CORE_SHA256 = ")[0-9a-f]*(")/, `$1${hash}$2`));
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
    assert.ok(changes.includes(`${PROTOCOL_PATH} (DEFAULT_UPSTREAM_CORE_SHA256)`));
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
    for (const file of CORE_BINARY_FILES) {
      assert.equal(f.git("diff", "--quiet", "main", "--", file), "", file);
    }
    const protocol = readFileSync(path.join(f.dir, PROTOCOL_PATH), "utf8");
    assert.match(protocol, new RegExp(mainHash), "pinned hash is main's");
    assert.match(protocol, /other = 2/, "the branch's own protocol change stays");
    const abi = JSON.parse(readFileSync(path.join(f.dir, ABI_PATH), "utf8"));
    assert.deepEqual(abi.moduleExports, ["_Boot"]);
    assert.equal(abi.contractSources[0].sha256, sha256(protocol), "contract hashes follow the restored file");
    f.commit("restore");
    assert.deepEqual(await coreArtifactChanges({ base: "main", cwd: f.dir }), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
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
      ...CORE_BINARY_FILES, ABI_PATH, PROTOCOL_PATH, "core/upstream", "tools/jit-cache-prejs.js",
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

test("the core pin is read from the module's export, not from a comment that looks like it", async () => {
  const real = "a".repeat(64);
  const decoy = "b".repeat(64);
  const source = `// export const DEFAULT_UPSTREAM_CORE_SHA256 = "${decoy}";\n` +
    `/* DEFAULT_UPSTREAM_CORE_SHA256 = "${decoy}"; */\n` +
    `export const DEFAULT_UPSTREAM_CORE_SHA256 = "${real}";\n`;
  assert.equal(await evaluatedCoreHash(source), real);
  assert.equal(await pinnedCoreHash(source), real);
  const updated = await withPinnedCoreHash(source, "c".repeat(64));
  assert.equal(await evaluatedCoreHash(updated), "c".repeat(64));
  assert.ok(updated.includes(`// export const DEFAULT_UPSTREAM_CORE_SHA256 = "${decoy}";`), "the comment is left alone");

  // A declaration hidden in a block comment, at the start of a line, is refused.
  const ambiguous = `/*\nexport const DEFAULT_UPSTREAM_CORE_SHA256 = "${decoy}";\n*/\n` +
    `export const DEFAULT_UPSTREAM_CORE_SHA256 = "${real}";\n`;
  await assert.rejects(pinnedCoreHash(ambiguous), /exactly one/);
  await assert.rejects(withPinnedCoreHash(ambiguous, "c".repeat(64)), /exactly one/);
});

test("the guard sees through a branch that hides its pin change behind a comment", async () => {
  const f = fixture();
  try {
    f.installCore("core-A", ["_Boot"]);
    f.commit("core A");
    f.git("checkout", "-q", "-b", "sneaky");
    const protocol = path.join(f.dir, PROTOCOL_PATH);
    const mainPin = sha256("core-A");
    // Comment carries main's value; the real export is changed.
    writeFileSync(protocol, `// export const DEFAULT_UPSTREAM_CORE_SHA256 = "${mainPin}";\n` +
      readFileSync(protocol, "utf8").replace(mainPin, "d".repeat(64)));
    f.commit("pin the next build");
    assert.ok((await coreArtifactChanges({ base: "main", cwd: f.dir }))
      .includes(`${PROTOCOL_PATH} (DEFAULT_UPSTREAM_CORE_SHA256)`));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("publishing on main decides on content: nothing, commit, or a new run for HEAD", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "publish-"));
  try {
    const artifact = path.join(dir, "artifact");
    mkdirSync(artifact);
    for (const file of CORE_BINARY_FILES) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), "committed");
      writeFileSync(path.join(artifact, path.basename(file)), "built");
    }
    const commits = [];
    const run = (statusFor) => publishPlan({
      artifactDir: artifact, cwd: dir,
      status: async (cwd) => statusFor(readFileSync(path.join(cwd, CORE_BINARY_FILES[1]), "utf8")),
      regenerate: () => {}, commit: (message) => commits.push(message)
    });
    // HEAD's committed core is already current: whatever this run built, nothing to do.
    assert.deepEqual(await run(() => ({ current: true })), { action: "none" });
    assert.equal(readFileSync(path.join(dir, CORE_BINARY_FILES[1]), "utf8"), "committed");
    // The built core is the build of HEAD's sources: commit it.
    const committed = await run((wasm) => ({ current: wasm === "built", coreId: "sha256:built", reasons: [] }));
    assert.equal(committed.action, "commit");
    assert.equal(commits.length, 1);
    // HEAD moved to other sources: leave the tree alone and ask for a new run.
    for (const file of CORE_BINARY_FILES) writeFileSync(path.join(dir, file), "committed");
    const handedOver = await run(() => ({ current: false, reasons: ["source.patchSeriesSha256 differs"] }));
    assert.equal(handedOver.action, "dispatch");
    assert.equal(commits.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main's publishing never keys on a commit author, and runs on main queue instead of cancelling", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/core-build.yml"), "utf8");
  assert.doesNotMatch(workflow, /head_commit\.author|github\.event\.commits/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  const job = workflow.slice(workflow.indexOf("  commit-core:"));
  assert.match(job, /github\.event_name == 'workflow_dispatch'/, "dispatched runs for main's HEAD must publish");
  assert.match(job, /ref: main/, "publishing targets main's current HEAD");
  assert.match(job, /gh workflow run core-build\.yml/, "a rejected push hands over to a new run");
  // The write token appears in one step only.
  assert.equal(job.match(/github\.token/g).length, 2);
  assert.equal(job.split("\n      - ").filter((step) => step.includes("github.token")).length, 1);
});

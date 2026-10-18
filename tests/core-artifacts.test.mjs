import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABI_PATH, CORE_BINARY_FILES, coreArtifactChanges, coreStatus, fetchCore, PROTOCOL_PATH,
  restoreCoreFromBase, stagedCoreArtifactChanges
} from "../tools/core-artifacts.mjs";

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

test("a branch that rebuilds the core is flagged; one that only changes sources is not", () => {
  const f = fixture();
  try {
    f.installCore("core-A", ["_Boot"]);
    f.commit("main core A");
    f.git("checkout", "-q", "-b", "sources-only");
    f.write("core/upstream/shim.cpp", "int x;");
    f.commit("change sources");
    assert.deepEqual(coreArtifactChanges({ base: "main", cwd: f.dir }), []);

    f.git("checkout", "-q", "-b", "with-binary");
    f.installCore("core-B", ["_Boot", "_SetPadState"]);
    f.commit("rebuild the core");
    const changes = coreArtifactChanges({ base: "main", cwd: f.dir });
    assert.ok(changes.includes("cores/dolphin/dolphin-core-upstream.wasm"));
    assert.ok(changes.includes(`${PROTOCOL_PATH} (DEFAULT_UPSTREAM_CORE_SHA256)`));
    assert.ok(changes.includes(`${ABI_PATH} (moduleExports)`));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a branch that started before main's newer core is not flagged for it", () => {
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
    assert.deepEqual(coreArtifactChanges({ base: "main", cwd: f.dir }), [], "still core A, untouched");
    restoreCoreFromBase({ base: "main", cwd: f.dir });
    f.commit("take main's core");
    assert.deepEqual(coreArtifactChanges({ base: "main", cwd: f.dir }), [], "main's current core is allowed");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("restore drops the branch's core but keeps its new exports as pending rebuild", () => {
  const f = fixture();
  try {
    const mainHash = f.installCore("core-A", ["_Boot"]);
    f.commit("core A");
    f.git("checkout", "-q", "-b", "pads");
    f.installCore("core-B", ["_Boot", "_SetPadState"]);
    f.write(PROTOCOL_PATH, readFileSync(path.join(f.dir, PROTOCOL_PATH), "utf8").replace("other = 1", "other = 2"));
    f.commit("pads, with a rebuilt core");

    const result = restoreCoreFromBase({ base: "main", cwd: f.dir });
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
    assert.deepEqual(coreArtifactChanges({ base: "main", cwd: f.dir }), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the pre-commit check sees a staged core, not an unstaged one", () => {
  const f = fixture();
  try {
    f.installCore("core-A", ["_Boot"]);
    f.commit("core A");
    f.installCore("core-B", ["_Boot"]);
    assert.deepEqual(stagedCoreArtifactChanges({ cwd: f.dir }), []);
    f.git("add", CORE_BINARY_FILES[1]);
    assert.deepEqual(stagedCoreArtifactChanges({ cwd: f.dir }), [CORE_BINARY_FILES[1]]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("any core main ever carried can be fetched by hash from history", () => {
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
test("status: a copy of a current core is current, and a changed shim makes it stale", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "core-status-"));
  try {
    for (const relative of [
      ...CORE_BINARY_FILES, ABI_PATH, PROTOCOL_PATH, "core/upstream", "tools/jit-cache-prejs.js",
      "provenance/dolphin-source.lock.json", "provenance/dolphin-vendor-snapshot-v1.json",
      "provenance/wasm-toolchain.lock.json", "tools/naga-spirv-wgsl/Cargo.lock"
    ]) {
      cpSync(path.join(repoRoot, relative), path.join(dir, relative), { recursive: true });
    }
    const before = coreStatus(dir);
    writeFileSync(path.join(dir, "core/upstream/dolphin_web_discio.cpp"), "// edited\n", { flag: "a" });
    const status = coreStatus(dir);
    assert.equal(status.current, false);
    assert.deepEqual(status.reasons.filter((reason) => !before.reasons.includes(reason)),
      ["source.localInputsSha256 differs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

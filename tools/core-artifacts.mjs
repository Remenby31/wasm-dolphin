// The committed core and what pull requests may do to it.
//
// Pull requests change sources and patches only. CI builds the core for every
// pull request, runs the tests on it and publishes it as an artifact; after a
// merge, CI builds main's core and commits it (.github/workflows/core-build.yml).
// The committed core therefore always comes from CI, and main's history is the
// index from a core hash to its exact bytes. See docs/repro-build.md.
//
//   node tools/core-artifacts.mjs status [--require-current]
//       Was cores/dolphin built from this checkout's sources and locks?
//   node tools/core-artifacts.mjs check --base <ref> [--mode warn|enforce]
//       Does this branch change core-derived content relative to <ref>?
//   node tools/core-artifacts.mjs check-staged
//       The same, for the index against HEAD (tools/hooks/pre-commit).
//   node tools/core-artifacts.mjs restore --base <ref>
//       Put <ref>'s core back, keeping this branch's source-side ABI changes.
//   node tools/core-artifacts.mjs publish-plan --artifact <dir> --out <plan.json>
//       CI on main: commit a built core onto main's current HEAD, or say why not.
//   node tools/core-artifacts.mjs fetch <sha256> [--repo owner/name]
//       Materialise an exact core under build/core-candidates/<sha256>/.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { coreSourceRecord } from "./core-build-info.mjs";
import { CORE_LOCK_PATH, parseCoreLock } from "./core-lock.mjs";
import { fileRecord } from "./dolphin-provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CORE_BINARY_FILES = Object.freeze([
  "cores/dolphin/dolphin-core-upstream.js",
  "cores/dolphin/dolphin-core-upstream.wasm",
  "cores/dolphin/dolphin-core-upstream.build.json"
]);
// Whole files CI owns: the artifacts and the default-core lock.
export const CORE_DERIVED_FILES = Object.freeze([...CORE_BINARY_FILES, CORE_LOCK_PATH]);
export const ABI_PATH = "provenance/dolphin-core-abi-v1.json";
const BUILD_JSON = CORE_BINARY_FILES[2];

// ABI manifest fields read off the built artifacts. Everything else in the
// manifest (contract source hashes, worker protocol, pending exports) follows
// the sources and stays editable by pull requests.
export const ABI_BINARY_FIELDS = Object.freeze([
  "coreId", "artifacts", "moduleExports", "runtimeMethods", "memoryContract", "memoryContractStatus"
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(args, { cwd = root, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, { cwd, encoding, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return encoding ? result.stdout.trim() : result.stdout;
}

function readAt(ref, path, cwd = root) {
  return git(["show", `${ref}:${path}`], { cwd, encoding: null });
}

// ------------------------------------------------------------------ status ---

// Compare the committed build record with the checkout. Reasons are short,
// human-readable mismatches; an empty list means the committed core is the
// build of these sources with this toolchain lock.
export async function coreStatus(base = root) {
  const reasons = [];
  const info = JSON.parse(readFileSync(join(base, BUILD_JSON), "utf8"));
  const wasm = readFileSync(join(base, CORE_BINARY_FILES[1]));
  const js = Buffer.from(readFileSync(join(base, CORE_BINARY_FILES[0]), "utf8").replaceAll("\r\n", "\n"));
  if (info.artifacts?.wasm?.sha256 !== sha256(wasm)) reasons.push("the .wasm is not the one the build record describes");
  if (info.artifacts?.js?.sha256 !== sha256(js)) reasons.push("the .js is not the one the build record describes");
  if (info.coreId !== `sha256:${sha256(wasm)}`) reasons.push("coreId does not address the committed .wasm");

  const current = coreSourceRecord(base);
  for (const field of ["upstreamCommit", "patchSeriesSha256", "vendorResultTree", "sourceLockSha256",
    "vendorSnapshotSha256", "localInputsSha256"]) {
    if (info.source?.[field] !== current[field]) reasons.push(`source.${field} differs`);
  }
  const toolchainLock = sha256(readFileSync(join(base, "provenance/wasm-toolchain.lock.json")));
  if (info.toolchain?.lockSha256 !== toolchainLock) reasons.push("toolchain lock differs");
  const cargoLock = sha256(Buffer.from(readFileSync(join(base, "tools/naga-spirv-wgsl/Cargo.lock"), "utf8")
    .replaceAll("\r\n", "\n")));
  if (info.toolchain?.cargoLockSha256 !== cargoLock) reasons.push("Naga Cargo.lock differs");

  let pinned = null;
  try {
    pinned = parseCoreLock(readFileSync(join(base, CORE_LOCK_PATH), "utf8")).sha256;
  } catch (error) {
    reasons.push(error.message);
  }
  if (pinned && pinned !== sha256(wasm)) reasons.push(`${CORE_LOCK_PATH} pins another core`);
  const abi = JSON.parse(readFileSync(join(base, ABI_PATH), "utf8"));
  if (abi.coreId !== `sha256:${sha256(wasm)}`) reasons.push(`${ABI_PATH} describes another core`);
  return { coreId: `sha256:${sha256(wasm)}`, current: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------- check ---

// What this branch changes in core-derived content. A file is flagged when it
// differs both from the merge base (so the branch changed it) and from the tip
// of base (so it is not simply main's current core, which is what
// `core:restore` puts back and what merges cleanly).
export async function coreArtifactChanges({ base, head = "HEAD", cwd = root }) {
  const mergeBase = git(["merge-base", base, head], { cwd });
  if (!mergeBase) throw new Error(`${base} and ${head} have no merge base`);
  const refs = [mergeBase, base];
  const changed = async (valueAt) => {
    const value = await valueAt(head);
    for (const ref of refs) if (await valueAt(ref) === value) return false;
    return true;
  };
  const changes = [];
  for (const path of CORE_DERIVED_FILES) {
    if (await changed((ref) => git(["rev-parse", `${ref}:${path}`], { cwd }))) changes.push(path);
  }
  const abiAt = (ref) => JSON.parse(readAt(ref, ABI_PATH, cwd)?.toString("utf8") ?? "{}");
  for (const field of ABI_BINARY_FIELDS) {
    if (await changed((ref) => JSON.stringify(abiAt(ref)[field] ?? null))) changes.push(`${ABI_PATH} (${field})`);
  }
  return changes;
}

const pick = (object, fields) => Object.fromEntries(fields.map((field) => [field, object?.[field] ?? null]));

// The same question for a commit about to be made: core-derived content in
// the index that differs from HEAD. Used by tools/hooks/pre-commit.
export async function stagedCoreArtifactChanges({ cwd = root } = {}) {
  const at = (ref, path) => readAt(ref, path, cwd);  // ref "" is the index
  const changes = [];
  for (const path of CORE_DERIVED_FILES) {
    if (git(["rev-parse", `HEAD:${path}`], { cwd }) !== git(["rev-parse", `:${path}`], { cwd })) changes.push(path);
  }
  const abiAt = (ref) => JSON.parse(at(ref, ABI_PATH)?.toString("utf8") ?? "{}");
  const [head, index] = [abiAt("HEAD"), abiAt("")];
  for (const field of ABI_BINARY_FIELDS) {
    if (JSON.stringify(head[field] ?? null) !== JSON.stringify(index[field] ?? null)) changes.push(`${ABI_PATH} (${field})`);
  }
  return changes;
}

// ----------------------------------------------------------------- restore ---

// Undo a branch's core rebuild without losing its source-side changes: the
// artifacts and the pinned hash come back from base; in the ABI manifest the
// binary fields come from base, exports the branch's own build added become
// "pending rebuild" (the existing mechanism for sources ahead of the core),
// and contract-source hashes are recomputed for the restored files.
// Also usable in the middle of `git merge <base>`: the ABI manifest is then
// read from the branch's side of the conflict (index stage 2), and the one
// conflict this scheme itself creates in src/upstream-worker-protocol.js --
// the branch's old hash declaration against base's core.lock.json import --
// is resolved to base's side. Any other conflict there is left to the user.
export const PROTOCOL_PATH = "src/upstream-worker-protocol.js";
const OLD_PIN = /^export const DEFAULT_UPSTREAM_CORE_SHA256 = "[0-9a-f]{64}";\n$/;

export function resolvePinConflict(text) {
  return text.replace(/^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm, (hunk, ours, theirs) =>
    OLD_PIN.test(ours) && theirs.includes('from "../cores/dolphin/core.lock.json" with { type: "json" }')
      ? theirs
      : hunk);
}

export async function restoreCoreFromBase({ base, cwd = root }) {
  const stagedPaths = [];
  for (const path of CORE_DERIVED_FILES) {
    const bytes = readAt(base, path, cwd);
    if (!bytes) throw new Error(`${base} has no ${path}`);
    writeFileSync(join(cwd, path), bytes);
    stagedPaths.push(path);
  }
  const protocolPath = join(cwd, PROTOCOL_PATH);
  if (existsSync(protocolPath)) {
    const before = readFileSync(protocolPath, "utf8");
    const after = resolvePinConflict(before);
    if (after !== before) {
      writeFileSync(protocolPath, after);
      if (!after.includes("<<<<<<<")) stagedPaths.push(PROTOCOL_PATH);
    }
  }

  const baseAbi = JSON.parse(readAt(base, ABI_PATH, cwd).toString("utf8"));
  const abiConflicted = Boolean(git(["ls-files", "-u", "--", ABI_PATH], { cwd }));
  const headAbi = JSON.parse((abiConflicted ? readAt(":2", ABI_PATH, cwd) : readFileSync(join(cwd, ABI_PATH))).toString("utf8"));
  const baseExports = new Set(baseAbi.moduleExports ?? []);
  const pending = [...new Set([
    ...(headAbi.sourceOnlyExportsPendingRebuild ?? []),
    ...(headAbi.moduleExports ?? []).filter((name) => !baseExports.has(name))
  ])].filter((name) => !baseExports.has(name)).sort();
  const restored = {
    ...headAbi,
    ...pick(baseAbi, ABI_BINARY_FIELDS),
    contractSources: (headAbi.contractSources ?? []).map((source) =>
      fileRecord(source.path, cwd, source.hashMode ?? "raw")),
    sourceOnlyExportsPendingRebuild: pending
  };
  writeFileSync(join(cwd, ABI_PATH), `${JSON.stringify(restored, null, 2)}\n`);
  stagedPaths.push(ABI_PATH);
  // During a merge, mark what was resolved here; outside a merge, add is a
  // no-op for unchanged files and stages the restored ones.
  if (git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd })) git(["add", "--", ...stagedPaths], { cwd });
  return { coreId: baseAbi.coreId, pendingExports: pending };
}

// ----------------------------------------------------------------- publish ---

// What CI does with a core it built, in the unprivileged job that prepares
// main's core commit. The checkout is main's current HEAD, possibly newer than
// the commit the core was built from. Decided on content only:
//   "none"     HEAD's committed core is already the build of HEAD's sources;
//   "dispatch" the build's sources or locks are not HEAD's: a run must build
//              HEAD. Checked before anything is installed, so this outcome
//              cannot fail on a core that HEAD's sources no longer accept;
//   "commit"   same sources and locks: the core is installed, the ABI
//              manifest regenerated for HEAD, and committed (the privileged
//              job pushes that commit). Any inconsistency after install throws.
export const PUBLISH_ACTIONS = Object.freeze(["none", "dispatch", "commit"]);

export function buildIdentityDifferences(buildInfo, cwd = root) {
  const reasons = [];
  const current = coreSourceRecord(cwd);
  for (const field of ["upstreamCommit", "patchSeriesSha256", "vendorResultTree", "sourceLockSha256",
    "vendorSnapshotSha256", "localInputsSha256"]) {
    if (buildInfo.source?.[field] !== current[field]) reasons.push(`source.${field} differs`);
  }
  if (buildInfo.toolchain?.lockSha256 !== sha256(readFileSync(join(cwd, "provenance/wasm-toolchain.lock.json")))) {
    reasons.push("toolchain lock differs");
  }
  const cargoLock = sha256(Buffer.from(readFileSync(join(cwd, "tools/naga-spirv-wgsl/Cargo.lock"), "utf8")
    .replaceAll("\r\n", "\n")));
  if (buildInfo.toolchain?.cargoLockSha256 !== cargoLock) reasons.push("Naga Cargo.lock differs");
  return reasons;
}

export async function publishPlan({
  artifactDir,
  cwd = root,
  status = coreStatus,
  identityDifferences = (built) => buildIdentityDifferences(built, cwd),
  regenerate = () => {
    // Logs go to stderr: stdout carries the plan only.
    const result = spawnSync(process.execPath, ["tools/update-core-abi.mjs", "--write"],
      { cwd, stdio: ["ignore", process.stderr, process.stderr] });
    if (result.status !== 0) throw new Error("update-core-abi failed");
  },
  commit = (message) => {
    for (const args of [["add", ...CORE_DERIVED_FILES, ABI_PATH], ["commit", "-q", "-m", message]]) {
      const result = spawnSync("git", args, { cwd, stdio: ["ignore", process.stderr, process.stderr] });
      if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
    }
  },
  message = "Build the core"
}) {
  if ((await status(cwd)).current) return { schemaVersion: 1, action: "none" };
  const built = JSON.parse(readFileSync(join(artifactDir, "dolphin-core-upstream.build.json"), "utf8"));
  const differences = identityDifferences(built);
  if (differences.length > 0) return { schemaVersion: 1, action: "dispatch", reasons: differences };
  for (const path of CORE_DERIVED_FILES) {
    writeFileSync(join(cwd, path), readFileSync(join(artifactDir, path.split("/").pop())));
  }
  regenerate();
  const after = await status(cwd);
  if (!after.current) throw new Error(`installed core is not current: ${after.reasons.join("; ")}`);
  commit(`${message}\n\n${after.coreId}`);
  return { schemaVersion: 1, action: "commit", coreId: after.coreId };
}

// ------------------------------------------------------------------- fetch ---

const CANDIDATE_FILES = [
  "dolphin-core-upstream.js", "dolphin-core-upstream.wasm", "dolphin-core-upstream.build.json"
];

function writeCandidate(cwd, hash, files) {
  if (sha256(files["dolphin-core-upstream.wasm"]) !== hash) throw new Error(`fetched .wasm is not ${hash}`);
  const destination = join(cwd, "build/core-candidates", hash);
  mkdirSync(destination, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(destination, name), bytes);
  return destination;
}

// Every core main ever carried is in its history (committed by CI); pull
// request builds are Actions artifacts named core-<sha256>. Local builds are
// checked first.
export function fetchCore(hash, { repo = null, cwd = root } = {}) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("expected a 64-hex-digit SHA-256");
  const fromDir = (dir) => {
    if (!CANDIDATE_FILES.every((name) => existsSync(join(dir, name)))) return null;
    const files = Object.fromEntries(CANDIDATE_FILES.map((name) => [name, readFileSync(join(dir, name))]));
    return sha256(files["dolphin-core-upstream.wasm"]) === hash ? files : null;
  };
  const candidates = join(cwd, "build/core-candidates", hash);
  if (fromDir(candidates)) return { destination: candidates, source: "local candidate" };
  const local = [join(cwd, "cores/dolphin"),
    ...(existsSync(join(cwd, "build/repro")) ? readdirSync(join(cwd, "build/repro")).map((p) => join(cwd, "build/repro", p, "core")) : [])];
  for (const dir of local) {
    const files = fromDir(dir);
    if (files) return { destination: writeCandidate(cwd, hash, files), source: dir };
  }

  const commits = (git(["log", "--all", "--format=%H", "--", BUILD_JSON], { cwd }) ?? "").split("\n").filter(Boolean);
  for (const commit of commits) {
    const info = readAt(commit, BUILD_JSON, cwd);
    if (!info || !info.toString("utf8").includes(`"coreId": "sha256:${hash}"`)) continue;
    const files = Object.fromEntries(CANDIDATE_FILES.map((name) => [name, readAt(commit, `cores/dolphin/${name}`, cwd)]));
    return { destination: writeCandidate(cwd, hash, files), source: `git ${commit.slice(0, 12)}` };
  }

  if (repo) {
    const scratch = mkdtempSync(join(tmpdir(), "core-artifact-"));
    try {
      const result = spawnSync("gh", ["run", "download", "-R", repo, "-n", `core-${hash}`, "-D", scratch],
        { encoding: "utf8" });
      if (result.status === 0) {
        const files = fromDir(scratch);
        if (files) return { destination: writeCandidate(cwd, hash, files), source: `${repo} artifact core-${hash}` };
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  throw new Error(`core ${hash} is not in cores/dolphin, build/, git history${repo ? ` or ${repo} artifacts` : ""}`);
}

// --------------------------------------------------------------------- cli ---

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name, fallback = null) => {
    const index = rest.indexOf(name);
    return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback;
  };
  try {
    if (command === "status") {
      const status = await coreStatus();
      console.log(status.current
        ? `cores/dolphin (${status.coreId}) is the build of these sources.`
        : `cores/dolphin (${status.coreId}) is not the build of these sources:\n  ${status.reasons.join("\n  ")}`);
      if (!status.current && rest.includes("--require-current")) process.exitCode = 1;
    } else if (command === "check") {
      const base = option("--base");
      if (!base) throw new Error("check needs --base <ref>");
      const mode = option("--mode", "enforce");
      const changes = await coreArtifactChanges({ base });
      if (changes.length === 0) {
        console.log(`No core-derived changes relative to ${base}.`);
      } else {
        const message = `This branch changes core-derived content that CI owns:\n  ${changes.join("\n  ")}\n` +
          `Run: npm run core:restore -- --base ${base}   (see docs/repro-build.md)`;
        if (mode === "warn") {
          console.log(process.env.GITHUB_ACTIONS ? `::warning::${message.replaceAll("\n", "%0A")}` : `warning: ${message}`);
        } else {
          console.error(message);
          process.exitCode = 1;
        }
      }
    } else if (command === "check-staged") {
      const changes = process.env.CORE_ARTIFACTS_ALLOW === "1" ? [] : await stagedCoreArtifactChanges();
      if (changes.length > 0) {
        console.error(`Refusing to commit core-derived content (CI builds and commits the core):\n  ` +
          `${changes.join("\n  ")}\nUnstage it with: npm run core:restore -- --base HEAD\n` +
          "CORE_ARTIFACTS_ALLOW=1 overrides (CI's own core commit uses it).");
        process.exitCode = 1;
      }
    } else if (command === "restore") {
      const base = option("--base");
      if (!base) throw new Error("restore needs --base <ref>");
      const result = await restoreCoreFromBase({ base });
      console.log(`Restored ${base}'s core (${result.coreId}).` +
        (result.pendingExports.length ? ` Pending rebuild: ${result.pendingExports.join(", ")}` : ""));
    } else if (command === "publish-plan") {
      const artifactDir = option("--artifact");
      if (!artifactDir) throw new Error("publish-plan needs --artifact <dir>");
      const out = option("--out");
      if (!out) throw new Error("publish-plan needs --out <plan.json>");
      const plan = await publishPlan({ artifactDir: resolve(artifactDir), message: option("--message", "Build the core") });
      if (!PUBLISH_ACTIONS.includes(plan.action)) throw new Error(`invalid plan ${JSON.stringify(plan)}`);
      writeFileSync(out, `${JSON.stringify(plan)}\n`);
    } else if (command === "fetch") {
      const hash = (rest.find((arg) => !arg.startsWith("--") && arg !== option("--repo")) ?? "").replace(/^sha256:/, "");
      const result = fetchCore(hash, { repo: option("--repo") });
      console.log(`${result.destination} (from ${result.source}); load it with ?coreid=sha256:${hash}`);
    } else {
      throw new Error("usage: core-artifacts.mjs status|check|restore|fetch (see the header)");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

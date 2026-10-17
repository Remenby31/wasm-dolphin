import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export const SOURCE_LOCK_PATH = "provenance/dolphin-source.lock.json";
export const CORE_ABI_PATH = "provenance/dolphin-core-abi-v1.json";
export const VENDOR_SNAPSHOT_PATH = "provenance/dolphin-vendor-snapshot-v1.json";
export const REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS = Object.freeze([
  "_SetWebGpuOwnershipTraceEnabled",
  "_AcknowledgeWebGpuOwnershipTraceCapture",
  "_GetWebGpuOwnershipTracePtr",
  "_GetWebGpuOwnershipTraceCapacity",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizedPath(path) {
  return path.split(sep).join("/");
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function gitBlobSha(bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function normalizedFileBytes(path, hashMode = "raw") {
  const bytes = readFileSync(path);
  if (hashMode === "raw") {
    return bytes;
  }
  invariant(hashMode === "lf-normalized", `Unsupported file hash mode: ${hashMode}`);
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
}

export function fileRecord(path, root = process.cwd(), hashMode = "raw") {
  const absolute = resolve(root, path);
  const stats = statSync(absolute);
  invariant(stats.isFile(), `Expected a regular file: ${path}`);
  const bytes = normalizedFileBytes(absolute, hashMode);
  return {
    path: normalizedPath(relative(root, absolute)),
    ...(hashMode === "raw" ? {} : { hashMode }),
    size: bytes.length,
    sha256: sha256Bytes(bytes)
  };
}

export function verifyFileRecord(root, record, label = record?.path ?? "file") {
  invariant(record && typeof record === "object", `Invalid ${label} record`);
  invariant(typeof record.path === "string" && record.path.length > 0, `Invalid ${label} path`);
  invariant(record.hashMode === undefined || record.hashMode === "raw" || record.hashMode === "lf-normalized",
    `Invalid ${label} hash mode`);
  invariant(Number.isSafeInteger(record.size) && record.size >= 0, `Invalid ${label} size`);
  invariant(SHA256_PATTERN.test(record.sha256), `Invalid ${label} SHA-256`);

  const absolute = resolve(root, record.path);
  invariant(existsSync(absolute), `Missing ${label}: ${record.path}`);
  const actual = fileRecord(record.path, root, record.hashMode ?? "raw");
  invariant(
    actual.size === record.size,
    `${label} size mismatch for ${record.path}: expected ${record.size}, got ${actual.size}`
  );
  invariant(
    actual.sha256 === record.sha256,
    `${label} SHA-256 mismatch for ${record.path}: expected ${record.sha256}, got ${actual.sha256}`
  );
  return actual;
}

export function patchSeriesDigest(patches) {
  const payload = patches
    .map((patch) =>
      `${patch.order}\0${patch.cwd ?? "."}\0${patch.path}\0${patch.hashMode ?? "raw"}\0` +
      `${patch.sha256}\0${patch.size}\n`)
    .join("");
  return sha256Bytes(payload);
}

export function validateSourceLock(lock) {
  invariant(lock?.schemaVersion === 1, "Unsupported Dolphin source lock schema");
  invariant(typeof lock.upstream?.repository === "string", "Missing upstream repository");
  invariant(GIT_SHA_PATTERN.test(lock.upstream?.commit ?? ""), "Invalid pinned upstream commit");
  invariant(lock.repositories && typeof lock.repositories === "object", "Missing patch repository map");
  for (const [cwd, repository] of Object.entries(lock.repositories)) {
    invariant(cwd === "." || (!cwd.startsWith("/") && !cwd.includes("..") && !cwd.includes("\\")),
      `Invalid patch repository cwd: ${cwd}`);
    invariant(GIT_SHA_PATTERN.test(repository?.commit ?? ""), `Invalid base commit for ${cwd}`);
  }
  invariant(lock.repositories["."]?.commit === lock.upstream.commit,
    "Root patch repository must use the pinned upstream commit");
  invariant(lock.externalRepositories === undefined ||
    (lock.externalRepositories && typeof lock.externalRepositories === "object"),
  "Invalid external repository map");
  for (const [cwd, repository] of Object.entries(lock.externalRepositories ?? {})) {
    invariant(!cwd.startsWith("/") && !cwd.includes("..") && !cwd.includes("\\"),
      `Invalid external repository cwd: ${cwd}`);
    invariant(/^(?:https|file):\/\/[^\s]+\.git$/.test(repository?.repository ?? ""),
      `Invalid external repository URL for ${cwd}`);
    invariant(GIT_SHA_PATTERN.test(repository?.commit ?? ""),
      `Invalid external repository commit for ${cwd}`);
  }
  invariant(Array.isArray(lock.patches) && lock.patches.length > 0, "Patch lock is empty");

  const paths = new Set();
  for (const [index, patch] of lock.patches.entries()) {
    invariant(patch.order === index + 1, `Patch order must be contiguous at index ${index}`);
    invariant(typeof patch.path === "string" && /^patches\/dolphin-wasm\/.*\.patch$/.test(patch.path) &&
      !patch.path.includes("..") && !patch.path.includes("\\"),
      `Invalid patch path at order ${patch.order}`);
    invariant(typeof patch.cwd === "string" && lock.repositories[patch.cwd],
      `Unknown patch repository cwd at order ${patch.order}: ${patch.cwd}`);
    invariant(patch.hashMode === "raw" || patch.hashMode === "lf-normalized",
      `Invalid patch hash mode: ${patch.path}`);
    invariant(!paths.has(patch.path), `Duplicate patch path: ${patch.path}`);
    invariant(Number.isSafeInteger(patch.size) && patch.size > 0, `Invalid patch size: ${patch.path}`);
    invariant(SHA256_PATTERN.test(patch.sha256), `Invalid patch SHA-256: ${patch.path}`);
    paths.add(patch.path);
  }

  invariant(SHA256_PATTERN.test(lock.patchSeriesSha256 ?? ""), "Invalid patch-series SHA-256");
  invariant(
    patchSeriesDigest(lock.patches) === lock.patchSeriesSha256,
    "Patch-series SHA-256 does not match the ordered lock entries"
  );
  return lock;
}

export function loadSourceLock(root = process.cwd(), lockPath = SOURCE_LOCK_PATH) {
  const absolute = resolve(root, lockPath);
  invariant(existsSync(absolute), `Missing Dolphin source lock: ${lockPath}`);
  return validateSourceLock(JSON.parse(readFileSync(absolute, "utf8")));
}

export function verifyPatchSeries(root = process.cwd(), lock = loadSourceLock(root)) {
  validateSourceLock(lock);
  for (const patch of lock.patches) {
    verifyFileRecord(root, patch, `patch ${patch.order}`);
  }

  return {
    count: lock.patches.length,
    sha256: lock.patchSeriesSha256
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return run("git", args, { ...options, cwd });
}

function gitText(cwd, args, options = {}) {
  return git(cwd, args, options).stdout.trim();
}

export function assertExactCommit(expected, actual, label = "Dolphin checkout") {
  invariant(GIT_SHA_PATTERN.test(expected ?? ""), `Invalid expected commit for ${label}`);
  invariant(
    actual === expected,
    `${label} commit mismatch: expected ${expected}, got ${actual || "<missing>"}`
  );
}

export function verifyDolphinCheckout(dolphinDir, lock) {
  validateSourceLock(lock);
  invariant(existsSync(resolve(dolphinDir, ".git")), `Not a Git checkout: ${dolphinDir}`);
  const head = gitText(dolphinDir, ["rev-parse", "HEAD"]);
  assertExactCommit(lock.upstream.commit, head);
  const objectType = gitText(dolphinDir, ["cat-file", "-t", lock.upstream.commit]);
  invariant(objectType === "commit", `Pinned upstream object is ${objectType}, not a commit`);
  return head;
}

export function verifyPatchRepositories(dolphinDir, lock) {
  validateSourceLock(lock);
  for (const [cwd, repository] of Object.entries(lock.repositories)) {
    const directory = cwd === "." ? dolphinDir : resolve(dolphinDir, cwd);
    invariant(existsSync(resolve(directory, ".git")), `Missing patch repository checkout: ${cwd}`);
    const head = gitText(directory, ["rev-parse", "HEAD"]);
    assertExactCommit(repository.commit, head, `Patch repository ${cwd}`);
  }
}

function externalDescendants(lock, cwd, dolphinDir, existingOnly = false) {
  const prefix = `${cwd}/`;
  const candidates = Object.keys(lock.externalRepositories ?? {})
    .filter((candidate) => candidate.startsWith(prefix));
  return candidates
    .filter((candidate) => !candidates.some((parent) =>
      parent !== candidate && candidate.startsWith(`${parent}/`)))
    .map((candidate) => candidate.slice(prefix.length))
    .filter((relativePath) => !existingOnly || existsSync(resolve(dolphinDir, cwd, relativePath)));
}

export function verifyExternalRepositories(dolphinDir, lock, { allowMissing = false } = {}) {
  validateSourceLock(lock);
  const result = {};
  const entries = Object.entries(lock.externalRepositories ?? {})
    .sort(([left], [right]) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  for (const [cwd, repository] of entries) {
    const directory = resolve(dolphinDir, cwd);
    if (!existsSync(resolve(directory, ".git"))) {
      invariant(allowMissing, `Missing external repository checkout: ${cwd}`);
      continue;
    }
    const origin = gitText(directory, ["remote", "get-url", "origin"]);
    invariant(origin === repository.repository,
      `External repository origin mismatch for ${cwd}: expected ${repository.repository}, got ${origin}`);
    const head = gitText(directory, ["rev-parse", "HEAD"]);
    assertExactCommit(repository.commit, head, `External repository ${cwd}`);
    const expected = new Map(externalDescendants(lock, cwd, dolphinDir, true)
      .map((path) => [`${path}/`, "I"]));
    assertStatusInventory(repositoryStatus(directory, "none"), expected, `external ${cwd}`);
    result[cwd] = gitText(directory, ["rev-parse", `${repository.commit}^{tree}`]);
  }
  return result;
}

export function fetchPinnedExternalRepositories(dolphinDir, lock) {
  const entries = Object.entries(lock.externalRepositories ?? {})
    .sort(([left], [right]) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  for (const [cwd, repository] of entries) {
    const directory = resolve(dolphinDir, cwd);
    const created = !existsSync(directory);
    if (created) {
      // Only the pinned commit is ever checked out, and it is fetched shallowly
      // below. A full partial clone is refused for anonymous clients on some
      // of these repositories (GitHub answers with a credential prompt), which
      // broke clean container and CI builds.
      run("git", ["init", "--quiet", directory], { stdio: "inherit" });
      git(directory, ["remote", "add", "origin", repository.repository]);
    }
    invariant(existsSync(resolve(directory, ".git")), `${directory} exists but is not a Git checkout`);
    const origin = gitText(directory, ["remote", "get-url", "origin"]);
    invariant(origin === repository.repository,
      `External repository origin mismatch for ${cwd}: expected ${repository.repository}, got ${origin}`);
    const current = created ? null : gitText(directory, ["rev-parse", "--verify", "HEAD"]);
    if (current !== repository.commit) {
      if (!created) {
        const expected = new Map(externalDescendants(lock, cwd, dolphinDir, true)
          .map((path) => [`${path}/`, "I"]));
        assertStatusInventory(repositoryStatus(directory, "none"), expected, `external ${cwd}`);
      }
      git(directory, ["fetch", "--depth", "1", "origin", repository.commit], { stdio: "inherit" });
    }
    git(directory, ["checkout", "--detach", repository.commit], { stdio: "inherit" });
  }
  return verifyExternalRepositories(dolphinDir, lock);
}

function parsePorcelainStatus(output) {
  const fields = output.split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) {
      continue;
    }
    invariant(field.length >= 4 && field[2] === " ", `Malformed Git status entry: ${field}`);
    const xy = field.slice(0, 2);
    const path = normalizedPath(field.slice(3));
    let originalPath = null;
    if (/[RC]/.test(xy)) {
      originalPath = normalizedPath(fields[++index] ?? "");
    }
    entries.push({ xy, path, originalPath });
  }
  return entries;
}

function assertStandardIndexFlags(directory) {
  const output = git(directory, ["ls-files", "--debug", "-z"]).stdout;
  const problems = [];
  let cursor = 0;
  while (cursor < output.length) {
    const nul = output.indexOf("\0", cursor);
    invariant(nul >= cursor, "Malformed NUL-delimited Git index debug output");
    const path = normalizedPath(output.slice(cursor, nul));
    const remainder = output.slice(nul + 1);
    const match = remainder.match(/\tflags: ([0-9a-f]+)(?:\r?\n|$)/i);
    invariant(match, `Missing Git index flags for ${path}`);
    const raw = match[1].toLowerCase();
    const value = Number.parseInt(raw, 16);
    if (value !== 0) {
      const names = [];
      if ((value & 0x00008000) !== 0) names.push("assume-unchanged");
      if ((value & 0x00200000) !== 0) names.push("fsmonitor-valid");
      if ((value & 0x20000000) !== 0) names.push("intent-to-add");
      if ((value & 0x40000000) !== 0) names.push("skip-worktree/sparse");
      problems.push(`${path}:${names.length > 0 ? names.join("+") : `flags=0x${raw}`}`);
    }
    cursor = nul + 1 + match.index + match[0].length;
  }
  invariant(problems.length === 0,
    `Nonstandard Git index flags are forbidden in ${directory}: [${problems.join(", ")}]`);
}

function repositoryStatus(directory, ignoreSubmodules = "none") {
  assertStandardIndexFlags(directory);
  const result = git(directory, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
    `--ignore-submodules=${ignoreSubmodules}`
  ]);
  return parsePorcelainStatus(result.stdout);
}

function semanticStatus(entry) {
  if (entry.xy === "??") {
    return "A";
  }
  if (entry.xy === "!!") {
    return "I";
  }
  const xy = entry.xy.toUpperCase();
  invariant(!/[DRCU]/.test(xy) && !entry.originalPath,
    `Unsupported checkout status ${entry.xy} for ${entry.path}`);
  if (xy.includes("A")) {
    return "A";
  }
  if (xy.includes("M") || xy.includes("T")) {
    return "M";
  }
  throw new Error(`Unsupported checkout status ${entry.xy} for ${entry.path}`);
}

function statusMap(entries, label) {
  const map = new Map();
  for (const entry of entries) {
    invariant(!map.has(entry.path), `Duplicate ${label} status path: ${entry.path}`);
    map.set(entry.path, { ...entry, status: semanticStatus(entry) });
  }
  return map;
}

function assertStatusInventory(actualEntries, expected, label) {
  const actual = statusMap(actualEntries, label);
  const extras = [...actual.keys()].filter((path) => !expected.has(path));
  const missing = [...expected.keys()].filter((path) => !actual.has(path));
  const mismatched = [...expected.entries()]
    .filter(([path, status]) => actual.has(path) && actual.get(path).status !== status)
    .map(([path, status]) => `${path}:${actual.get(path).status}->${status}`);
  invariant(extras.length === 0 && missing.length === 0 && mismatched.length === 0,
    `${label} checkout status does not match the locked snapshot` +
    `; extras=[${extras.join(", ")}]; missing=[${missing.join(", ")}]` +
    `; status=[${mismatched.join(", ")}]`);
  return actual;
}

function gitTreeEntry(directory, revision, path) {
  const output = gitText(directory, ["ls-tree", revision, "--", path]);
  if (!output) {
    return null;
  }
  const match = output.match(/^(\d{6})\s+(\S+)\s+([0-9a-f]{40})\t/);
  invariant(match, `Could not parse Git tree entry for ${path} at ${revision}`);
  return { mode: match[1], type: match[2], blob: match[3] };
}

function actualWorktreeMode(directory, record, statusEntry) {
  if (record.status === "A" && statusEntry.xy === "??") {
    if (process.platform === "win32") {
      return "100644";
    }
    return (statSync(resolve(directory, record.path)).mode & 0o111) === 0 ? "100644" : "100755";
  }
  const readMode = (args) => {
    const output = gitText(directory, args);
    if (!output) {
      return null;
    }
    const line = output.split(/\r?\n/).at(-1);
    const match = line.match(/^:\d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]/);
    return match?.[1] ?? null;
  };
  return readMode(["diff", "--raw", "--no-abbrev", "--", record.path]) ??
    readMode(["diff", "--cached", "--raw", "--no-abbrev", "--", record.path]) ??
    gitTreeEntry(directory, "HEAD", record.path)?.mode;
}

function verifySnapshotRecords(directory, baseCommit, records, statuses, label) {
  const actual = [];
  for (const record of records) {
    const base = gitTreeEntry(directory, baseCommit, record.path);
    if (record.status === "A") {
      invariant(record.baseBlob === null, `${label} added path has a base blob: ${record.path}`);
      invariant(base === null, `${label} added path exists in the base tree: ${record.path}`);
    } else {
      invariant(base?.type === "blob", `${label} base path is not a blob: ${record.path}`);
      invariant(base.blob === record.baseBlob, `${label} base blob mismatch: ${record.path}`);
      invariant(base.mode === record.mode, `${label} base mode mismatch: ${record.path}`);
    }

    const absolute = resolve(directory, record.path);
    invariant(existsSync(absolute) && statSync(absolute).isFile(),
      `${label} snapshot file is missing: ${record.path}`);
    const bytes = normalizedFileBytes(absolute, "lf-normalized");
    const blob = gitBlobSha(bytes);
    const sha256 = sha256Bytes(bytes);
    const mode = actualWorktreeMode(directory, record, statuses.get(record.path));
    invariant(blob === record.resultBlob,
      `${label} result blob mismatch for ${record.path}: expected ${record.resultBlob}, got ${blob}`);
    invariant(bytes.length === record.size,
      `${label} snapshot size mismatch for ${record.path}: expected ${record.size}, got ${bytes.length}`);
    invariant(sha256 === record.sha256, `${label} snapshot SHA-256 mismatch for ${record.path}`);
    invariant(mode === record.mode,
      `${label} snapshot mode mismatch for ${record.path}: expected ${record.mode}, got ${mode}`);
    actual.push({ ...record, resultBlob: blob, mode });
  }
  return actual;
}

function virtualResultTree(directory, baseCommit, records) {
  const temporary = mkdtempSync(join(tmpdir(), "dolphin-virtual-tree-"));
  const index = join(temporary, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    git(directory, ["read-tree", baseCommit], { env });
    for (const record of records) {
      git(directory, [
        "update-index",
        "--add",
        "--info-only",
        "--cacheinfo",
        `${record.mode},${record.resultBlob},${record.path}`
      ], { env });
    }
    return gitText(directory, ["write-tree", "--missing-ok"], { env });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function allPatchRepositoriesInitialized(dolphinDir, lock) {
  return Object.keys(lock.repositories).every((cwd) => {
    const directory = cwd === "." ? dolphinDir : resolve(dolphinDir, cwd);
    return existsSync(resolve(directory, ".git"));
  });
}

function assertCheckoutPristine(dolphinDir, lock, { allowMissingSubmodules = false } = {}) {
  const rootEntries = repositoryStatus(dolphinDir, "none");
  invariant(rootEntries.length === 0,
    `Refusing non-pristine Dolphin checkout; root status=[${rootEntries.map((entry) => entry.path).join(", ")}]`);
  for (const cwd of Object.keys(lock.repositories).filter((path) => path !== ".")) {
    const directory = resolve(dolphinDir, cwd);
    if (!existsSync(resolve(directory, ".git"))) {
      invariant(allowMissingSubmodules, `Missing patch repository checkout: ${cwd}`);
      continue;
    }
    const entries = repositoryStatus(directory, "none");
    invariant(entries.length === 0,
      `Refusing non-pristine patch repository ${cwd}; status=[${entries.map((entry) => entry.path).join(", ")}]`);
  }
  return { state: "pristine" };
}

export function classifyLockedCheckout(
  dolphinDir,
  root = process.cwd(),
  { allowMissingExternalRepositories = false } = {}
) {
  const lock = loadSourceLock(root);
  const manifest = loadVendorSnapshotManifest(root, lock);
  verifyDolphinCheckout(dolphinDir, lock);
  verifyPatchRepositories(dolphinDir, lock);
  const externalTrees = verifyExternalRepositories(dolphinDir, lock, {
    allowMissing: allowMissingExternalRepositories
  });

  const rootEntries = repositoryStatus(dolphinDir, "none");
  const submoduleEntries = new Map(
    manifest.submodules.map((submodule) => [
      submodule.cwd,
      repositoryStatus(resolve(dolphinDir, submodule.cwd), "none")
    ])
  );
  if (rootEntries.length === 0 && [...submoduleEntries.values()].every((entries) => entries.length === 0)) {
    return {
      state: "pristine",
      rootTree: gitText(dolphinDir, ["rev-parse", `${lock.upstream.commit}^{tree}`]),
      submoduleTrees: Object.fromEntries(manifest.submodules.map((submodule) => [
        submodule.cwd,
        gitText(resolve(dolphinDir, submodule.cwd), ["rev-parse", `${submodule.baseCommit}^{tree}`])
      ])),
      externalTrees
    };
  }

  const expectedRoot = new Map(manifest.root.records.map((record) => [record.path, record.status]));
  for (const submodule of manifest.submodules) {
    expectedRoot.set(submodule.cwd, "M");
  }
  const rootStatuses = assertStatusInventory(rootEntries, expectedRoot, "root");
  const rootRecords = verifySnapshotRecords(
    dolphinDir,
    manifest.root.baseCommit,
    manifest.root.records,
    rootStatuses,
    "root"
  );
  const rootTree = virtualResultTree(dolphinDir, manifest.root.baseCommit, rootRecords);
  invariant(rootTree === manifest.root.resultTree,
    `Root virtual result tree mismatch: expected ${manifest.root.resultTree}, got ${rootTree}`);

  const submoduleTrees = {};
  for (const submodule of manifest.submodules) {
    const entries = submoduleEntries.get(submodule.cwd);
    const expected = new Map(submodule.records.map((record) => [record.path, record.status]));
    const statuses = assertStatusInventory(entries, expected, submodule.cwd);
    const directory = resolve(dolphinDir, submodule.cwd);
    const records = verifySnapshotRecords(
      directory,
      submodule.baseCommit,
      submodule.records,
      statuses,
      submodule.cwd
    );
    const tree = virtualResultTree(directory, submodule.baseCommit, records);
    invariant(tree === submodule.resultTree,
      `${submodule.cwd} virtual result tree mismatch: expected ${submodule.resultTree}, got ${tree}`);
    submoduleTrees[submodule.cwd] = tree;
  }
  return { state: "snapshot", rootTree, submoduleTrees, externalTrees };
}

export function fetchPinnedDolphin({
  root = process.cwd(),
  destination = resolve(root, "vendor/dolphin"),
  repository,
  updateSubmodules = true
} = {}) {
  const lock = loadSourceLock(root);
  const source = repository ?? lock.upstream.repository;
  const created = !existsSync(destination);

  if (created) {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", source, destination], { stdio: "inherit" });
  } else {
    invariant(existsSync(resolve(destination, ".git")), `${destination} exists but is not a Git checkout`);
    if (!repository) {
      const origin = gitText(destination, ["remote", "get-url", "origin"]);
      invariant(origin === lock.upstream.repository,
        `Dolphin origin mismatch: expected ${lock.upstream.repository}, got ${origin}`);
    }
  }

  const currentHead = gitText(destination, ["rev-parse", "--verify", "HEAD"]);
  let priorState = null;
  if (!created) {
    if (currentHead === lock.upstream.commit && allPatchRepositoriesInitialized(destination, lock)) {
      priorState = classifyLockedCheckout(destination, root, {
        allowMissingExternalRepositories: true
      });
    } else {
      priorState = assertCheckoutPristine(destination, lock, { allowMissingSubmodules: true });
    }
  }
  if (created || currentHead !== lock.upstream.commit) {
    git(destination, ["fetch", "--depth", "1", "origin", lock.upstream.commit], { stdio: "inherit" });
    const fetched = gitText(destination, ["rev-parse", "FETCH_HEAD^{commit}"]);
    assertExactCommit(lock.upstream.commit, fetched, "Fetched Dolphin object");
  }

  // This is safe for an already-patched tree because it does not change the
  // selected commit; it only prevents a local branch name from becoming an
  // accidental moving input on a later invocation.
  git(destination, ["checkout", "--detach", lock.upstream.commit], { stdio: "inherit" });
  verifyDolphinCheckout(destination, lock);
  if (updateSubmodules) {
    if (priorState?.state !== "snapshot") {
      git(destination, ["submodule", "update", "--init", "--recursive", "--depth", "1"], { stdio: "inherit" });
    }
  } else {
    invariant(Object.keys(lock.repositories).length === 1,
      "Cannot verify a source lock with submodules when submodule update is disabled");
  }
  fetchPinnedExternalRepositories(destination, lock);
  const finalState = classifyLockedCheckout(destination, root);
  invariant(priorState?.state !== "snapshot" || finalState.state === "snapshot",
    "Fetch changed an exact locked snapshot");
  return { destination, commit: lock.upstream.commit, state: finalState.state };
}

function preflightPatchSequence(directory, baseCommit, patches, root) {
  const temporary = mkdtempSync(join(tmpdir(), "dolphin-patch-preflight-"));
  const env = { GIT_INDEX_FILE: join(temporary, "index") };
  try {
    git(directory, ["read-tree", baseCommit], { env });
    for (const patch of patches) {
      try {
        git(directory, [
          "apply",
          "--cached",
          "--unidiff-zero",
          resolve(root, patch.path)
        ], { env });
      } catch (error) {
        throw new Error(
          `Locked patch ${patch.order} for ${patch.cwd} does not apply after its locked predecessors:\n` +
          error.message,
          { cause: error }
        );
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function applyPinnedPatches({
  root = process.cwd(),
  dolphinDir = resolve(root, "vendor/dolphin")
} = {}) {
  const lock = loadSourceLock(root);
  verifyPatchSeries(root, lock);
  const before = classifyLockedCheckout(dolphinDir, root);
  if (before.state === "snapshot") {
    return {
      status: "already-applied",
      count: lock.patches.length,
      sha256: lock.patchSeriesSha256,
      resultTree: before.rootTree
    };
  }

  const groups = [];
  for (const patch of lock.patches) {
    const previous = groups.at(-1);
    if (previous?.cwd === patch.cwd) {
      previous.patches.push(patch);
    } else {
      invariant(!groups.some((group) => group.cwd === patch.cwd),
        `Patch repository ${patch.cwd} appears in non-contiguous groups`);
      groups.push({ cwd: patch.cwd, patches: [patch] });
    }
  }

  for (const group of groups) {
    group.directory = group.cwd === "." ? dolphinDir : resolve(dolphinDir, group.cwd);
    preflightPatchSequence(
      group.directory,
      lock.repositories[group.cwd].commit,
      group.patches,
      root
    );
  }

  const applied = [];
  let after;
  try {
    for (const group of groups) {
      for (const patch of group.patches) {
        git(group.directory, ["apply", "--unidiff-zero", resolve(root, patch.path)], {
          stdio: "inherit"
        });
        applied.push({ directory: group.directory, patch });
      }
    }
    after = classifyLockedCheckout(dolphinDir, root);
    invariant(after.state === "snapshot", "Patch application did not produce the exact locked snapshot");
  } catch (error) {
    const rollbackErrors = [];
    for (const item of applied.reverse()) {
      try {
        git(item.directory, [
          "apply",
          "--unidiff-zero",
          "--reverse",
          resolve(root, item.patch.path)
        ]);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      const rolledBack = classifyLockedCheckout(dolphinDir, root);
      invariant(rolledBack.state === "pristine", "Patch rollback did not restore the pristine checkout");
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Patch application failed and rollback did not restore the pristine checkout: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
  return {
    status: "applied",
    count: lock.patches.length,
    sha256: lock.patchSeriesSha256,
    resultTree: after.rootTree
  };
}

function validateSnapshotRecord(record, label) {
  invariant(record && typeof record === "object", `Invalid ${label}`);
  invariant(typeof record.path === "string" && record.path.length > 0 &&
    !record.path.startsWith("/") && !record.path.includes("..") && !record.path.includes("\\"),
  `Invalid ${label} path`);
  invariant(record.status === "A" || record.status === "M", `Invalid ${label} status`);
  invariant(/^\d{6}$/.test(record.mode), `Invalid ${label} mode`);
  invariant(record.baseBlob === null || GIT_SHA_PATTERN.test(record.baseBlob), `Invalid ${label} base blob`);
  invariant((record.status === "A") === (record.baseBlob === null),
    `${label} status/base-blob relationship is invalid`);
  invariant(GIT_SHA_PATTERN.test(record.resultBlob ?? ""), `Invalid ${label} result blob`);
  invariant(Number.isSafeInteger(record.size) && record.size >= 0, `Invalid ${label} size`);
  invariant(SHA256_PATTERN.test(record.sha256 ?? ""), `Invalid ${label} SHA-256`);
}

export function validateVendorSnapshotManifest(manifest, lock) {
  invariant(manifest?.schemaVersion === 1, "Unsupported vendor snapshot schema");
  invariant(manifest.normalization === "git-blob-lf", "Unsupported vendor snapshot normalization");
  invariant(manifest.root?.baseCommit === lock.upstream.commit,
    "Vendor snapshot root base does not match the source lock");
  invariant(!Object.hasOwn(manifest.root, "snapshotCommit"),
    "Vendor snapshot must not depend on an unavailable synthetic commit");
  invariant(GIT_SHA_PATTERN.test(manifest.root?.resultTree ?? ""), "Invalid snapshot root tree");
  invariant(Array.isArray(manifest.root?.records), "Missing vendor snapshot root records");
  invariant(Number.isSafeInteger(manifest.root.changedPathCount) && manifest.root.changedPathCount >= 0,
    "Invalid vendor snapshot changed-path count");
  invariant(manifest.root.records.length === manifest.root.changedPathCount,
    "Vendor snapshot changed-path count mismatch");

  const rootPaths = new Set();
  for (const [index, record] of manifest.root.records.entries()) {
    validateSnapshotRecord(record, `root snapshot record ${index}`);
    invariant(!rootPaths.has(record.path), `Duplicate root snapshot path: ${record.path}`);
    rootPaths.add(record.path);
  }
  invariant(JSON.stringify([...rootPaths]) === JSON.stringify([...rootPaths].sort()),
    "Root snapshot records must be sorted by path");

  invariant(Array.isArray(manifest.submodules), "Missing vendor snapshot submodules");
  const submoduleCwds = new Set();
  for (const submodule of manifest.submodules) {
    invariant(lock.repositories[submodule.cwd], `Unknown snapshot submodule: ${submodule.cwd}`);
    invariant(submodule.baseCommit === lock.repositories[submodule.cwd].commit,
      `Snapshot submodule base mismatch: ${submodule.cwd}`);
    invariant(GIT_SHA_PATTERN.test(submodule.resultTree ?? ""),
      `Invalid snapshot submodule tree: ${submodule.cwd}`);
    invariant(!submoduleCwds.has(submodule.cwd), `Duplicate snapshot submodule: ${submodule.cwd}`);
    submoduleCwds.add(submodule.cwd);
    invariant(Array.isArray(submodule.records) && submodule.records.length > 0,
      `Missing snapshot records for ${submodule.cwd}`);
    const paths = new Set();
    for (const [index, record] of submodule.records.entries()) {
      validateSnapshotRecord(record, `${submodule.cwd} snapshot record ${index}`);
      invariant(!paths.has(record.path), `Duplicate ${submodule.cwd} snapshot path: ${record.path}`);
      paths.add(record.path);
    }
    invariant(JSON.stringify([...paths]) === JSON.stringify([...paths].sort()),
      `${submodule.cwd} snapshot records must be sorted by path`);
  }
  const expectedSubmodules = Object.keys(lock.repositories).filter((cwd) => cwd !== ".").sort();
  invariant(JSON.stringify([...submoduleCwds].sort()) === JSON.stringify(expectedSubmodules),
    "Vendor snapshot submodule inventory does not match the source lock");

  invariant(SHA256_PATTERN.test(manifest.contentSha256 ?? ""), "Invalid vendor snapshot content digest");
  const content = JSON.stringify({ root: manifest.root, submodules: manifest.submodules });
  invariant(sha256Bytes(content) === manifest.contentSha256, "Vendor snapshot content digest mismatch");
  return manifest;
}

export function loadVendorSnapshotManifest(
  root = process.cwd(),
  lock = loadSourceLock(root),
  manifestPath = VENDOR_SNAPSHOT_PATH
) {
  const absolute = resolve(root, manifestPath);
  invariant(existsSync(absolute), `Missing vendor snapshot manifest: ${manifestPath}`);
  return validateVendorSnapshotManifest(JSON.parse(readFileSync(absolute, "utf8")), lock);
}

export function verifyVendorSnapshotCheckout(dolphinDir, root = process.cwd()) {
  const result = classifyLockedCheckout(dolphinDir, root);
  invariant(result.state === "snapshot", "Dolphin checkout is pristine, not the locked snapshot");
  return result;
}

function readUleb(bytes, cursor) {
  let value = 0;
  let shift = 0;
  for (;;) {
    invariant(cursor.offset < bytes.length, "Unexpected end of WASM while reading ULEB128");
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7;
    invariant(shift <= 49, "WASM ULEB128 exceeds safe integer range");
  }
}

function readName(bytes, cursor) {
  const length = readUleb(bytes, cursor);
  const end = cursor.offset + length;
  invariant(end <= bytes.length, "Unexpected end of WASM name");
  const value = new TextDecoder().decode(bytes.subarray(cursor.offset, end));
  cursor.offset = end;
  return value;
}

function readLimits(bytes, cursor) {
  const flags = readUleb(bytes, cursor);
  const minimum = readUleb(bytes, cursor);
  const maximum = (flags & 1) !== 0 ? readUleb(bytes, cursor) : null;
  return {
    flags,
    minimum,
    maximum,
    shared: (flags & 2) !== 0,
    memory64: (flags & 4) !== 0
  };
}

export function parseWasmMemoryImports(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  invariant(data.length >= 8 && data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d,
    "Not a WebAssembly binary");
  const cursor = { offset: 8 };
  const memories = [];

  while (cursor.offset < data.length) {
    const sectionId = data[cursor.offset++];
    const sectionSize = readUleb(data, cursor);
    const sectionEnd = cursor.offset + sectionSize;
    invariant(sectionEnd <= data.length, "WASM section exceeds file size");
    if (sectionId !== 2) {
      cursor.offset = sectionEnd;
      continue;
    }

    const count = readUleb(data, cursor);
    for (let index = 0; index < count; index += 1) {
      const module = readName(data, cursor);
      const name = readName(data, cursor);
      const kind = data[cursor.offset++];
      if (kind === 0) {
        readUleb(data, cursor);
      } else if (kind === 1) {
        cursor.offset += 1;
        readLimits(data, cursor);
      } else if (kind === 2) {
        memories.push({ module, name, ...readLimits(data, cursor) });
      } else if (kind === 3) {
        cursor.offset += 2;
      } else if (kind === 4) {
        readUleb(data, cursor);
        readUleb(data, cursor);
      } else {
        throw new Error(`Unknown WASM import kind: ${kind}`);
      }
    }
    invariant(cursor.offset === sectionEnd, "WASM import parser did not consume the section exactly");
    return memories;
  }
  return memories;
}

export function publicModuleExports(glueSource) {
  const names = new Set();
  for (const match of glueSource.matchAll(/Module\["(_[A-Za-z0-9_]+)"\]/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

export function inspectMemoryContract(root = process.cwd()) {
  const glue = readFileSync(resolve(root, "cores/dolphin/dolphin-core-upstream.js"), "utf8");
  const wrapper = readFileSync(resolve(root, "core/upstream/dolphin_web_core.cpp"), "utf8");
  const configure = readFileSync(resolve(root, "tools/configure-upstream-wasm.mjs"), "utf8");
  const lock = loadSourceLock(root);
  const activePatchText = lock.patches
    .filter((entry) => entry.cwd === ".")
    .map((entry) => readFileSync(resolve(root, entry.path), "utf8"))
    .join("\n");
  const wasm = readFileSync(resolve(root, "cores/dolphin/dolphin-core-upstream.wasm"));
  const jsMatch = glue.match(/var INITIAL_MEMORY=Module\["INITIAL_MEMORY"\]\|\|(\d+)/);
  invariant(jsMatch, "Could not discover INITIAL_MEMORY in the generated JS glue");
  const pageMatch = configure.match(/const wasmMemoryPages = (\d+);/);
  invariant(pageMatch, "Configure script must define the WASM memory page count exactly once");
  const memoryPages = Number(pageMatch[1]);
  const wrapperReferences = [...wrapper.matchAll(
    /EmitU32Leb\(imports,\s*DOLPHIN_WASM_SHARED_MEMORY_PAGES\);/g
  )].length;
  invariant(wrapperReferences === 4, "Dynamic-JIT wrapper must use the shared memory page constant four times");
  invariant(
    wrapper.includes("DOLPHIN_WASM_SHARED_MEMORY_PAGES = DOLPHIN_WASM_MEMORY_PAGES"),
    "Dynamic-JIT wrapper memory constant is not supplied by CMake"
  );
  invariant(
    activePatchText.includes('math(EXPR DOLPHIN_WASM_INITIAL_MEMORY_BYTES "${DOLPHIN_WASM_MEMORY_PAGES} * 65536")') &&
      activePatchText.includes('"-sINITIAL_MEMORY=${DOLPHIN_WASM_INITIAL_MEMORY_BYTES}"'),
    "Active patch series does not derive INITIAL_MEMORY from DOLPHIN_WASM_MEMORY_PAGES"
  );
  invariant(
    activePatchText.includes("EmitU32Leb(imports, DOLPHIN_WASM_MEMORY_PAGES)"),
    "Cached-interpreter JIT does not import the configured shared-memory size"
  );
  const initialMemoryBytes = memoryPages * 65536;
  return {
    wasmPageBytes: 65536,
    jsGlue: {
      initialMemoryBytes: Number(jsMatch[1]),
      initialPages: Number(jsMatch[1]) / 65536
    },
    wasmImports: parseWasmMemoryImports(wasm),
    wrapperDynamicJitPages: [memoryPages],
    activePatchSeries: {
      initialMemoryBytes,
      initialPages: memoryPages
    }
  };
}

function inspectRuntimeMethods(root, glueSource) {
  const lock = loadSourceLock(root);
  const activePatchText = lock.patches
    .filter((entry) => entry.cwd === ".")
    .map((entry) => readFileSync(resolve(root, entry.path), "utf8"))
    .join("\n");
  const methods = new Set();
  for (const list of activePatchText.matchAll(/-sEXPORTED_RUNTIME_METHODS=\[([^\]]+)\]/g)) {
    for (const method of list[1].matchAll(/'([^']+)'/g)) {
      methods.add(method[1]);
    }
  }
  invariant(methods.size > 0, "Active patch series does not declare exported runtime methods");
  const result = [...methods].sort();
  for (const method of result) {
    invariant(glueSource.includes(`Module["${method}"]=${method}`),
      `Generated core does not expose declared runtime method ${method}`);
  }
  return result;
}

export function inspectWorkerProtocol(root) {
  const worker = readFileSync(resolve(root, "src/upstream-discio-worker.js"), "utf8");
  const adapter = readFileSync(resolve(root, "src/upstream-worker-adapter.js"), "utf8");
  const protocol = readFileSync(resolve(root, "src/upstream-worker-protocol.js"), "utf8");
  const start = worker.indexOf("async function handleMessage(type, payload)");
  const end = worker.indexOf("\nasync function loadCore(", start);
  invariant(start >= 0 && end > start, "Could not isolate the upstream worker request switch");
  const requestTypes = [...worker.slice(start, end).matchAll(/case "([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
  invariant(/const \{ type, payload = \{\} \} = data;/.test(worker) &&
    worker.includes("isStrictOneWayWorkerRequest(data)"),
    "Could not verify worker request envelope fields");
  invariant(adapter.includes("this.worker.postMessage({ id, type, payload }"),
    "Could not verify adapter request envelope fields");
  invariant(adapter.includes("{ type, payload, oneWay: true }") &&
    protocol.includes("message?.oneWay === true"),
    "Could not verify adapter one-way request envelope field");
  invariant(worker.includes("self.postMessage(planned.reply, planned.transfer)") &&
    /const reply = \{ id: message\?\.id, ok: true, \.\.\.payload \};/.test(protocol),
    "Could not verify successful worker response envelope");
  invariant(worker.includes("buildWorkerErrorReply(") &&
    /id: message\?\.id,\s*ok: false,\s*error: String\(error\)/s.test(protocol),
    "Could not verify failed worker response envelope");
  invariant(/\{ type: "detachedOglFrame", bitmap: data\.bitmap, width: data\.width, height: data\.height \}/
    .test(worker), "Could not verify detached OGL notification fields");
  invariant(/function postStatus\(message\)[\s\S]*?const text = String\(message\)[\s\S]*?self\.postMessage\(\{\s*type: "status",\s*message: text\s*\}\)/.test(worker),
    "Could not verify status notification fields");
  return {
    requestEnvelopeFields: ["id", "type", "payload", "oneWay"],
    responseEnvelopeFields: ["id", "ok", "error"],
    requestTypes,
    notificationFields: {
      detachedOglFrame: ["type", "bitmap", "width", "height"],
      status: ["type", "message"]
    }
  };
}

function memoryContractStatus(contract) {
  const pages = [
    contract.jsGlue.initialPages,
    ...contract.wasmImports.flatMap((memory) => [memory.minimum, memory.maximum]),
    ...contract.wrapperDynamicJitPages,
    contract.activePatchSeries.initialPages
  ];
  const consistentPages = pages.every((value) => value === pages[0]);
  const validSharedImports = contract.wasmImports.length > 0 &&
    contract.wasmImports.every((memory) => memory.shared && !memory.memory64 && memory.maximum !== null);
  return consistentPages && validSharedImports ? "consistent" : "mismatch";
}

export function verifyCoreAbiManifest(root = process.cwd(), manifestPath = CORE_ABI_PATH) {
  const absolute = resolve(root, manifestPath);
  invariant(existsSync(absolute), `Missing core ABI manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(absolute, "utf8"));
  const lock = loadSourceLock(root);
  invariant(manifest.schemaVersion === 1, "Unsupported core manifest schema");
  invariant(manifest.abiVersion === 1, "Unsupported host/core ABI version");
  invariant(manifest.upstreamCommit === lock.upstream.commit,
    "Core ABI upstream commit does not match the source lock");
  invariant(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 2,
    "Core ABI manifest must contain the JS and WASM artifacts");
  for (const artifact of manifest.artifacts) {
    verifyFileRecord(root, artifact, `core artifact ${artifact.path}`);
  }
  for (const source of manifest.contractSources ?? []) {
    verifyFileRecord(root, source, `ABI source ${source.path}`);
  }

  const glue = readFileSync(resolve(root, "cores/dolphin/dolphin-core-upstream.js"), "utf8");
  const actualExports = publicModuleExports(glue);
  invariant(
    JSON.stringify(actualExports) === JSON.stringify(manifest.moduleExports),
    "Generated core Module exports do not match ABI v1"
  );
  const sourceOnlyExports = manifest.sourceOnlyExportsPendingRebuild ?? [];
  invariant(Array.isArray(sourceOnlyExports), "Pending source-only exports must be an array");
  for (const name of REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS) {
    invariant(
      actualExports.includes(name) || sourceOnlyExports.includes(name),
      `Required Module export ${name} is neither built nor declared pending rebuild`
    );
  }
  const activePatchText = lock.patches
    .filter((entry) => entry.cwd === ".")
    .map((entry) => readFileSync(resolve(root, entry.path), "utf8"))
    .join("\n");
  const contractSourceText = (manifest.contractSources ?? [])
    .map((source) => readFileSync(resolve(root, source.path), "utf8"))
    .join("\n");
  for (const name of sourceOnlyExports) {
    invariant(/^_[A-Za-z0-9_]+$/.test(name), `Invalid pending source-only export ${name}`);
    invariant(!actualExports.includes(name), `Pending source-only export is already in the core artifact: ${name}`);
    const symbol = name.slice(1);
    const keepalivePattern = new RegExp(
      `EMSCRIPTEN_KEEPALIVE[\\s\\S]{0,120}\\b${symbol}\\s*\\(`
    );
    const keepalive = keepalivePattern.test(contractSourceText) ||
      keepalivePattern.test(activePatchText);
    invariant(activePatchText.includes(`'${name}'`) || keepalive,
      `Pending source-only export is neither in the patch export list nor kept alive: ${name}`);
    invariant(
      new RegExp(`\\b${symbol}\\s*\\(`).test(contractSourceText) ||
        new RegExp(`\\b${symbol}\\s*\\(`).test(activePatchText),
      `Pending source-only export is absent from the ABI contract sources and patch set: ${name}`
    );
  }
  const actualMemory = inspectMemoryContract(root);
  invariant(
    JSON.stringify(actualMemory) === JSON.stringify(manifest.memoryContract),
    "Core memory contract does not match ABI v1"
  );
  const actualMemoryStatus = memoryContractStatus(actualMemory);
  invariant(manifest.memoryContractStatus === actualMemoryStatus,
    `Core memory-contract status mismatch: expected ${actualMemoryStatus}`);
  const actualRuntimeMethods = inspectRuntimeMethods(root, glue);
  invariant(JSON.stringify(manifest.runtimeMethods) === JSON.stringify(actualRuntimeMethods),
    "Generated core runtime methods do not match ABI v1");
  const actualWorkerProtocol = inspectWorkerProtocol(root);
  invariant(JSON.stringify(manifest.workerProtocol) === JSON.stringify(actualWorkerProtocol),
    "Worker protocol fields do not match ABI v1");
  const wasmArtifact = manifest.artifacts.find((artifact) => artifact.path.endsWith(".wasm"));
  invariant(manifest.coreId === `sha256:${wasmArtifact.sha256}`, "Core ID must address the WASM content");
  return {
    abiVersion: manifest.abiVersion,
    coreId: manifest.coreId,
    exports: actualExports.length,
    runtimeMethods: actualRuntimeMethods,
    workerProtocol: actualWorkerProtocol,
    memoryContract: actualMemory
  };
}

export function verifyDolphinProvenance(root = process.cwd()) {
  const lock = loadSourceLock(root);
  const patches = verifyPatchSeries(root, lock);
  const vendor = loadVendorSnapshotManifest(root, lock);
  const core = verifyCoreAbiManifest(root);
  return {
    upstreamCommit: lock.upstream.commit,
    patches,
    externalRepositories: Object.fromEntries(Object.entries(lock.externalRepositories ?? {})
      .map(([cwd, repository]) => [cwd, repository.commit])),
    vendorSnapshot: {
      rootPaths: vendor.root.records.length,
      submodulePaths: vendor.submodules.reduce((sum, item) => sum + item.records.length, 0),
      declaredResultTree: vendor.root.resultTree,
      sha256: vendor.contentSha256
    },
    core
  };
}

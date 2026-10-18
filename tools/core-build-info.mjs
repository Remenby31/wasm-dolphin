import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadWasmToolchainLock, sha256File, sha256NormalizedTextFile } from "./wasm-toolchain.mjs";
import {
  fileRecord,
  publicModuleExports,
  REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS,
} from "./dolphin-provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedTextHash(path) {
  return sha256(Buffer.from(readFileSync(path, "utf8").replace(/\r\n/g, "\n")));
}

function fileInfo(path, hashMode = "raw") {
  const bytes = readFileSync(path);
  return {
    path,
    size: bytes.length,
    sha256: hashMode === "lf-normalized" ? normalizedTextHash(path) : sha256(bytes),
    hashMode
  };
}

function readUleb(bytes, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
    if (shift > 35) throw new Error("Invalid WASM ULEB value");
  }
  throw new Error("Truncated WASM ULEB value");
}

export function wasmSectionInfo(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 4).toString("hex") !== "0061736d") throw new Error(`${path} is not a WASM module`);
  const sections = [];
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const size = readUleb(bytes, offset);
    offset = size.offset;
    const end = offset + size.value;
    if (end > bytes.length) throw new Error(`Truncated WASM section ${id}`);
    const payload = bytes.subarray(offset, end);
    sections.push({ id, size: payload.length, sha256: sha256(payload) });
    offset = end;
  }
  return sections;
}

function git(args, cwd = root) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

// Paths a canonical build is allowed to have dirty, because the build itself
// produces them. Everything else -- modified or untracked -- means the artifact
// does not correspond to any committed source state, and the recorded
// provenance would be a description of one person's desk rather than something
// a third party can reproduce.
const CANONICAL_BUILD_OUTPUTS = new Set([
  "cores/dolphin/dolphin-core-upstream.js",
  "cores/dolphin/dolphin-core-upstream.wasm",
  "cores/dolphin/dolphin-core-upstream.build.json",
  "provenance/dolphin-core-abi-v1.json"
]);

// Parse `git status --porcelain=v1 -uall` into repo-relative paths, handling
// renames ("R  old -> new") and quoted paths with spaces.
//
// The status field is two columns wide and its first column is a space when a
// change is not staged (" M path"). Slicing a fixed three characters is
// therefore wrong as soon as anything trims the text -- and git() trims its
// stdout, so the FIRST line arrives as "M path" and the fixed slice ate the
// first character of the path. That turned an allowlisted build output into an
// unrecognised one and failed an otherwise clean build. Match the status field
// rather than counting characters.
const STATUS_LINE = /^\s{0,2}[MADRCU?!]{1,2}\s+(.+)$/;

export function dirtyPathsFromStatus(status) {
  if (!status) return [];
  const paths = [];
  for (const line of status.split("\n")) {
    if (line.trim() === "") continue;
    const matched = STATUS_LINE.exec(line);
    if (!matched) continue;
    let entry = matched[1];
    const arrow = entry.indexOf(" -> ");
    if (arrow !== -1) entry = entry.slice(arrow + 4);
    if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
    paths.push(entry);
  }
  return paths;
}

export function unexpectedDirtyPaths(status) {
  return dirtyPathsFromStatus(status).filter((path) => !CANONICAL_BUILD_OUTPUTS.has(path));
}

// Local files compiled into the core besides the patched Dolphin tree.
export const CORE_LOCAL_INPUTS = Object.freeze([
  "core/upstream/dolphin_web_core.cpp",
  "core/upstream/dolphin_web_discio.cpp",
  "core/upstream/dolphin_web_raster_profile.h",
  "core/upstream/dolphin_web_xfb_fastpaths.h",
  "tools/jit-cache-prejs.js"
]);

// The source identity a core build records. Recomputing it on a checkout and
// comparing it with a committed build record says whether that core was built
// from these sources (tools/core-artifacts.mjs status).
export function coreSourceRecord(base = root) {
  const sourceLockPath = resolve(base, "provenance/dolphin-source.lock.json");
  const vendorSnapshotPath = resolve(base, "provenance/dolphin-vendor-snapshot-v1.json");
  const sourceLock = JSON.parse(readFileSync(sourceLockPath, "utf8"));
  const vendorSnapshot = JSON.parse(readFileSync(vendorSnapshotPath, "utf8"));
  const localInputs = CORE_LOCAL_INPUTS.map((relativePath) => ({
    ...fileInfo(resolve(base, relativePath), "lf-normalized"),
    path: relativePath
  }));
  const localInputsSha256 = sha256(Buffer.from(JSON.stringify(
    localInputs.map(({ path, size, sha256: fileSha256, hashMode }) => ({
      path,
      size,
      sha256: fileSha256,
      hashMode
    }))
  )));
  return {
    upstreamCommit: sourceLock.upstream.commit,
    patchSeriesSha256: sourceLock.patchSeriesSha256,
    vendorResultTree: vendorSnapshot.root.resultTree,
    sourceLockSha256: sha256File(sourceLockPath),
    vendorSnapshotSha256: sha256File(vendorSnapshotPath),
    localInputsSha256,
    localInputs
  };
}

export function writeCoreBuildInfo({
  buildDir,
  outputPath = process.env.DOLPHIN_BUILD_INFO_PATH,
  observedToolchain = null
} = {}) {
  const absoluteBuildDir = resolve(buildDir ?? process.env.DOLPHIN_WASM_BUILD_DIR ?? resolve(root, "build/dolphin-wasm"));
  const configurePath = resolve(absoluteBuildDir, "wasm-dolphin-configure.json");
  if (!existsSync(configurePath)) throw new Error(`Missing configure record ${configurePath}`);
  const configure = JSON.parse(readFileSync(configurePath, "utf8"));
  const jsPath = resolve(configure.outputDir, "dolphin-core-upstream.js");
  const wasmPath = resolve(configure.outputDir, "dolphin-core-upstream.wasm");
  if (!existsSync(jsPath) || !existsSync(wasmPath)) throw new Error("Core build did not produce both JS and WASM artifacts");

  const toolchainLockPath = resolve(root, "provenance/wasm-toolchain.lock.json");
  const cargoLockPath = resolve(root, "tools/naga-spirv-wgsl/Cargo.lock");
  const toolchain = loadWasmToolchainLock();
  const wasm = fileInfo(wasmPath);

  // Refuse to stamp a canonical build with a dirty tree. DOLPHIN_ALLOW_DIRTY_BUILD=1
  // is the deliberate escape hatch for local experiments; it also records the
  // override in the evidence so a dirty build can never masquerade as a clean one.
  const repositoryStatus = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirty = unexpectedDirtyPaths(repositoryStatus);
  const allowDirty = process.env.DOLPHIN_ALLOW_DIRTY_BUILD === "1";
  if (dirty.length > 0 && !allowDirty) {
    throw new Error(
      `Refusing to record a canonical core build from a dirty tree. Commit, stash or ` +
      `remove these ${dirty.length} path(s) first, or set DOLPHIN_ALLOW_DIRTY_BUILD=1 ` +
      `for a throwaway build:\n  ${dirty.join("\n  ")}`
    );
  }

  const info = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    coreId: `sha256:${wasm.sha256}`,
    repository: {
      commit: git(["rev-parse", "HEAD"]),
      status: repositoryStatus,
      cleanTree: dirty.length === 0,
      dirtyBuildOverride: dirty.length > 0 && allowDirty ? dirty : undefined
    },
    source: coreSourceRecord(),
    toolchain: {
      lockSha256: sha256File(toolchainLockPath),
      emscriptenVersion: toolchain.emscripten.version,
      emscriptenCompilerCommit: toolchain.emscripten.compilerCommit,
      emsdkCommit: toolchain.emscripten.emsdkCommit,
      cmakeVersion: toolchain.cmake.version,
      ninjaVersion: toolchain.ninja.version,
      rustcVersion: toolchain.rust.rustcVersion,
      rustcCommit: toolchain.rust.rustcCommit,
      cargoVersion: toolchain.rust.cargoVersion,
      nagaDependencyVersion: toolchain.naga.dependencyVersion,
      cargoLockSha256: sha256NormalizedTextFile(cargoLockPath),
      // What verify:toolchain found on disk (macOS/Linux), as opposed to the
      // lock transcription above. Absent for the Windows path, which checks
      // the same hashes but does not report them.
      observed: observedToolchain ? observedToolchainRecord(observedToolchain) : undefined
    },
    configure: {
      buildDir: configure.buildDir,
      outputDir: configure.outputDir,
      nagaLibrarySha256: configure.nagaLibrarySha256,
      wasmMemoryPages: configure.wasmMemoryPages,
      fastBranchInline: configure.fastBranchInline,
      fallbackMapDiagnostics: configure.fallbackMapDiagnostics,
      fallbackMapBits: configure.fallbackMapBits,
      directWasmBlockDispatch: configure.directWasmBlockDispatch,
      wasmCompileFlags: configure.wasmCompileFlags,
      sourcePathFlags: configure.sourcePathFlags,
      rustRemapFlags: configure.rustRemapFlags,
      cmakeArgs: configure.cmakeArgs,
      cmakeCacheSha256: sha256File(resolve(absoluteBuildDir, "CMakeCache.txt"))
    },
    artifacts: {
      js: fileInfo(jsPath, "lf-normalized"),
      wasm,
      wasmSections: wasmSectionInfo(wasmPath)
    }
  };

  const destination = resolve(outputPath ?? resolve(configure.outputDir, `${basename(wasmPath, ".wasm")}.build.json`));
  writeFileSync(destination, `${JSON.stringify(info, null, 2)}\n`);
  return { destination, info };
}

function observedToolchainRecord(observed) {
  const { paths, ...record } = observed;
  return { ...record, toolchainDir: paths?.toolchainDir };
}

export function packageCoreCandidate(buildInfoPath) {
  const absoluteBuildInfo = resolve(buildInfoPath);
  const info = JSON.parse(readFileSync(absoluteBuildInfo, "utf8"));
  if (info.schemaVersion !== 1 || !/^sha256:[0-9a-f]{64}$/.test(info.coreId ?? "")) {
    throw new Error("Core build info is not a supported content-addressed build");
  }
  const hash = info.coreId.slice("sha256:".length);
  const js = info.artifacts?.js;
  const wasm = info.artifacts?.wasm;
  if (!js?.path || !wasm?.path) throw new Error("Core build info is missing artifacts");
  if (normalizedTextHash(js.path) !== js.sha256 || sha256File(wasm.path) !== wasm.sha256 || wasm.sha256 !== hash) {
    throw new Error("Core artifacts changed after build evidence was written");
  }

  const destination = resolve(root, `build/core-candidates/${hash}`);
  mkdirSync(destination, { recursive: true });
  copyFileSync(js.path, resolve(destination, "dolphin-core-upstream.js"));
  copyFileSync(wasm.path, resolve(destination, "dolphin-core-upstream.wasm"));
  copyFileSync(absoluteBuildInfo, resolve(destination, "dolphin-core-upstream.build.json"));
  for (const relativePath of [
    "provenance/dolphin-source.lock.json",
    "provenance/dolphin-vendor-snapshot-v1.json",
    "provenance/wasm-toolchain.lock.json",
    "tools/naga-spirv-wgsl/Cargo.lock"
  ]) {
    const source = resolve(root, relativePath);
    const target = resolve(destination, basename(relativePath));
    copyFileSync(source, target);
  }
  const candidateAbi = buildCandidateAbiManifest({
    template: JSON.parse(readFileSync(resolve(root, "provenance/dolphin-core-abi-v1.json"), "utf8")),
    jsPath: js.path,
    wasmPath: wasm.path,
  });
  writeFileSync(
    resolve(destination, "dolphin-core-abi-v1.json"),
    `${JSON.stringify(candidateAbi, null, 2)}\n`
  );
  const manifest = {
    schemaVersion: 1,
    coreId: info.coreId,
    buildInfoSha256: sha256File(absoluteBuildInfo),
    files: [
      "dolphin-core-upstream.js",
      "dolphin-core-upstream.wasm",
      "dolphin-core-upstream.build.json",
      "dolphin-source.lock.json",
      "dolphin-core-abi-v1.json",
      "dolphin-vendor-snapshot-v1.json",
      "wasm-toolchain.lock.json",
      "Cargo.lock"
    ].map((name) => ({ name, sha256: sha256File(resolve(destination, name)) }))
  };
  writeFileSync(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { destination, manifest };
}

export function buildCandidateAbiManifest({ template, jsPath, wasmPath }) {
  if (template?.schemaVersion !== 1 || template?.abiVersion !== 1) {
    throw new Error("Core ABI template is not supported");
  }
  const js = fileInfo(resolve(jsPath), "lf-normalized");
  js.size = Buffer.byteLength(readFileSync(resolve(jsPath), "utf8").replace(/\r\n/g, "\n"));
  const wasm = fileInfo(resolve(wasmPath));
  const moduleExports = publicModuleExports(readFileSync(resolve(jsPath), "utf8"));
  const logicalArtifact = (artifact, suffix, info) => ({
    ...artifact,
    path: artifact?.path || `cores/dolphin/${suffix}`,
    ...(info.hashMode === "raw" ? {} : { hashMode: info.hashMode }),
    size: info.size,
    sha256: info.sha256,
  });
  const templateArtifacts = Array.isArray(template.artifacts) ? template.artifacts : [];
  const findArtifact = (suffix) => templateArtifacts.find((entry) =>
    String(entry?.path || "").replaceAll("\\", "/").endsWith(suffix)
  );
  const contractSources = (template.contractSources || []).map((source) =>
    fileRecord(source.path, root, source.hashMode ?? "raw")
  );
  return {
    ...template,
    coreId: `sha256:${wasm.sha256}`,
    artifacts: [
      logicalArtifact(findArtifact("dolphin-core-upstream.js"), "dolphin-core-upstream.js", js),
      logicalArtifact(findArtifact("dolphin-core-upstream.wasm"), "dolphin-core-upstream.wasm", wasm),
    ],
    contractSources,
    sourceOnlyExportsPendingRebuild: [
      ...new Set([
        ...(template.sourceOnlyExportsPendingRebuild || []),
        ...REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS,
      ]),
    ].filter((name) => !moduleExports.includes(name)),
    moduleExports,
  };
}

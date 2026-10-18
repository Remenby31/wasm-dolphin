// Rebuild the upstream core from pinned inputs, on macOS, Linux, or in the
// pinned Linux container, and compare it with the committed artifacts.
//
//   npm run build:core:repro                    # native (macOS / Linux)
//   npm run build:core:repro -- --docker        # inside tools/toolchain/Dockerfile
//   npm run build:core:repro -- --clean         # discard the CMake tree first
//   npm run build:core:repro -- --install       # also replace cores/dolphin + ABI
//
// Other flags: --no-sync (build vendor/dolphin as it is, e.g. while editing
// it before regenerating a patch), --allow-dirty (record a build from an
// uncommitted tree), --jobs N. Docker only: --docker-platform linux/amd64,
// --bind-mounts (no named volumes; what CI uses), --image-only, and
// --docker-context (stage the image context, print its tag).
//
// Outputs, per host platform P (darwin-arm64, linux-x64, linux-arm64):
//   build/repro/P/dolphin-wasm/   CMake/Ninja tree (incremental between runs)
//   build/repro/P/core/           dolphin-core-upstream.{js,wasm,build.json}
//   build/repro/P/parity.json     comparison with cores/dolphin
//   build/core-candidates/<sha>/  loadable with ?coreid=sha256:<sha>

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { wasmSectionInfo } from "./core-build-info.mjs";
import { hostPlatform, lockPath, sha256File, verifyWasmToolchain } from "./wasm-toolchain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`})`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// CMake runs SPIRV-Tools' Python generators inside vendor/dolphin; bytecode
// caches they leave behind make the next fetch:dolphin reject the checkout as
// drifted from the locked snapshot.
process.env.PYTHONDONTWRITEBYTECODE = "1";

function removeBytecodeCaches(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "__pycache__") {
      rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
    }
  }
}

const seconds = (start) => Math.round((performance.now() - start) / 100) / 10;

// -------------------------------------------------------------- identity ---

const hashText = (text) => createHash("sha256").update(text).digest("hex");

// What a CMake tree was built from. Ninja trusts timestamps, so a tree reused
// across checkouts, or across a change of patch series or toolchain, can link
// objects compiled from other sources under this checkout's provenance. The
// identity keys Docker volumes and is stamped into every CMake tree; a tree
// whose stamp differs is emptied before configuring.
export function buildIdentity({ checkout, sourceLockSha256, toolchainLockSha256 }) {
  const fields = { checkout, sourceLockSha256, toolchainLockSha256 };
  return { ...fields, key: hashText(JSON.stringify(fields)).slice(0, 16) };
}

function currentIdentity() {
  return buildIdentity({
    // Inside the container every checkout is /wasm-dolphin; the host path is
    // passed in so two checkouts never share a tree.
    checkout: process.env.WASM_DOLPHIN_CHECKOUT ?? realpathSync(root),
    sourceLockSha256: sha256File(join(root, "provenance/dolphin-source.lock.json")),
    toolchainLockSha256: sha256File(lockPath)
  });
}

const IDENTITY_STAMP = ".wasm-dolphin-build-identity.json";

// Returns true when the tree was emptied.
export function resetStaleBuildTree(buildDir, identity) {
  const stamp = join(buildDir, IDENTITY_STAMP);
  if (!existsSync(buildDir) || readdirSync(buildDir).length === 0) return false;
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(stamp, "utf8")).key;
  } catch {
    previous = null;
  }
  if (previous === identity.key) return false;
  for (const entry of readdirSync(buildDir)) rmSync(join(buildDir, entry), { recursive: true, force: true });
  return true;
}

// Before configuring: empty the CMake tree and the output directory if either
// belongs to another identity. The output directory needs its own check: a
// Docker CMake volume keyed by identity can come back (patch series A, then
// B, then A again) while the outputs on the checkout still hold B's link,
// newer than A's objects, so Ninja would not relink and B's binary would be
// recorded as A's. The output stamp is removed before building and written
// back only after a successful build. Returns the directories emptied.
export function prepareBuildDirectories({ buildDir, outputDir, identity }) {
  const emptied = [buildDir, outputDir].filter((dir) => resetStaleBuildTree(dir, identity));
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  return emptied;
}

export function stampBuildTree(buildDir, identity) {
  writeFileSync(join(buildDir, IDENTITY_STAMP), `${JSON.stringify(identity, null, 2)}\n`);
}

// ---------------------------------------------------------------- docker ---

// The image installs the toolchain from the lock's install inputs only. The
// per-platform hashes are left out of the build context so that recording a
// new platform in the lock does not invalidate the image.
export function prepareDockerContext() {
  const context = join(root, "build/docker-context");
  rmSync(context, { recursive: true, force: true });
  // Only the files the image installs from, so the tag covers the whole context.
  for (const path of [
    "tools/toolchain/Dockerfile",
    "tools/toolchain/bootstrap.sh",
    "tools/toolchain/requirements.txt",
    "tools/naga-spirv-wgsl/Cargo.toml",
    "tools/naga-spirv-wgsl/Cargo.lock"
  ]) {
    mkdirSync(dirname(join(context, path)), { recursive: true });
    cpSync(join(root, path), join(context, path), { recursive: true });
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  delete lock.posix.platforms;
  delete lock.posix.emscriptenTreeSha256;
  mkdirSync(join(context, "provenance"), { recursive: true });
  writeFileSync(join(context, "provenance/wasm-toolchain.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

  const hash = createHash("sha256");
  for (const path of [
    "provenance/wasm-toolchain.lock.json",
    "tools/toolchain/Dockerfile",
    "tools/toolchain/bootstrap.sh",
    "tools/toolchain/requirements.txt",
    "tools/naga-spirv-wgsl/Cargo.toml",
    "tools/naga-spirv-wgsl/Cargo.lock"
  ]) {
    hash.update(sha256File(join(context, path)));
  }
  return { context, tag: `wasm-dolphin-build:${hash.digest("hex").slice(0, 16)}` };
}

function runInDocker() {
  const platform = option("--docker-platform", null);
  const prepared = prepareDockerContext();
  const tag = prepared.tag + (platform ? `-${platform.replace(/\W+/g, "-")}` : "");
  const platformArgs = platform ? ["--platform", platform] : [];
  if (!capture("docker", ["image", "inspect", tag])) {
    const start = performance.now();
    run("docker", ["build", ...platformArgs, "-t", tag, "-f",
      join(prepared.context, "tools/toolchain/Dockerfile"), prepared.context]);
    console.log(`Built image ${tag} in ${seconds(start)} s`);
  }
  if (flag("--image-only")) return;

  // A git worktree keeps its object store outside the checkout; mount it at
  // the same path so `git status` works for the build record.
  const commonDir = capture("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitMounts = commonDir && !commonDir.startsWith(`${root}/`)
    ? ["-v", `${commonDir}:${commonDir}`]
    : [];
  const arch = platform?.split("/")[1] ?? capture("docker", ["info", "--format", "{{.Architecture}}"]);
  const volumeSuffix = arch === "x86_64" || arch === "amd64" ? "x64" : "arm64";
  const forwarded = argv.filter((arg, index) =>
    !["--docker", "--docker-platform", "--bind-mounts", "--image-only"].includes(arg) && argv[index - 1] !== "--docker-platform");
  const platformDir = `/wasm-dolphin/build/repro/linux-${volumeSuffix}`;
  // --bind-mounts (CI): everything on the checkout, so later host steps
  // (npm test, dist:source) see the patched vendor/dolphin.
  // Emscripten builds some system libraries and ports lazily and guards its
  // cache with flock(), which fails on a macOS bind mount: keep the cache in
  // a volume there, and next to the CMake tree on a Linux host.
  // Volumes are keyed by build identity (checkout, source lock, toolchain
  // lock); the vendor tree by the source lock alone, since sync verifies it.
  const identity = currentIdentity();
  const sourceKey = identity.sourceLockSha256.slice(0, 16);
  const volumes = flag("--bind-mounts")
    ? ["-e", `EM_CACHE=${platformDir}/em-cache`]
    : [
      "-v", `wasm-dolphin-vendor-${sourceKey}:/wasm-dolphin/vendor`,
      "-v", `wasm-dolphin-cmake-${volumeSuffix}-${identity.key}:${platformDir}/dolphin-wasm`,
      "-v", `wasm-dolphin-emcache-${volumeSuffix}:/opt/em-cache`,
      "-e", "EM_CACHE=/opt/em-cache"
    ];
  run("docker", [
    "run", "--rm", ...platformArgs,
    "-v", `${root}:/wasm-dolphin`,
    ...gitMounts,
    // By default vendor/ and the CMake tree live in named volumes: faster than
    // a macOS bind mount, and the container fetches its own sources instead of
    // reusing the host checkout.
    ...volumes,
    "-e", `WASM_DOLPHIN_CHECKOUT=${identity.checkout}`,
    "-e", `HOST_UID=${process.getuid?.() ?? 0}`,
    "-e", `HOST_GID=${process.getgid?.() ?? 0}`,
    tag,
    "node", "tools/build-core-repro.mjs", ...forwarded
  ]);
}

// ---------------------------------------------------------------- parity ---

export function glueFacts(jsPath) {
  const glue = readFileSync(jsPath, "utf8");
  return {
    filesystems: /FS\.filesystems=\{([^}]*)\}/.exec(glue)?.[1].split(",").sort() ?? null,
    runtimeMethods: [...glue.matchAll(/Module\["([A-Za-z0-9_]+)"\]=\1(?![A-Za-z0-9_])/g)]
      .map((match) => match[1]).filter((name) => !name.startsWith("_")).sort(),
    exports: [...new Set([...glue.matchAll(/Module\["(_[A-Za-z0-9_]+)"\]/g)].map((match) => match[1]))].sort()
  };
}

function setDiff(left, right) {
  return {
    onlyCommitted: left.filter((value) => !right.includes(value)),
    onlyRebuilt: right.filter((value) => !left.includes(value))
  };
}

export function compareWithCommitted(outputDir) {
  const committedDir = join(root, "cores/dolphin");
  const name = "dolphin-core-upstream";
  const sections = (path) => new Map(wasmSectionInfo(path).map((section) => [section.id, section]));
  const committedSections = sections(join(committedDir, `${name}.wasm`));
  const rebuiltSections = sections(join(outputDir, `${name}.wasm`));
  const sectionNames = { 1: "type", 2: "import", 3: "function", 6: "global", 7: "export", 10: "code", 11: "data" };
  const committedGlue = glueFacts(join(committedDir, `${name}.js`));
  const rebuiltGlue = glueFacts(join(outputDir, `${name}.js`));
  return {
    committed: {
      wasmSha256: sha256File(join(committedDir, `${name}.wasm`)),
      wasmBytes: readFileSync(join(committedDir, `${name}.wasm`)).length
    },
    rebuilt: {
      wasmSha256: sha256File(join(outputDir, `${name}.wasm`)),
      wasmBytes: readFileSync(join(outputDir, `${name}.wasm`)).length
    },
    sections: Object.entries(sectionNames).map(([id, label]) => {
      const left = committedSections.get(Number(id));
      const right = rebuiltSections.get(Number(id));
      return { id: Number(id), label, committedBytes: left?.size ?? null, rebuiltBytes: right?.size ?? null,
        equal: left?.sha256 === right?.sha256 };
    }),
    glue: {
      filesystems: { committed: committedGlue.filesystems, rebuilt: rebuiltGlue.filesystems },
      runtimeMethods: setDiff(committedGlue.runtimeMethods, rebuiltGlue.runtimeMethods),
      runtimeMethodsRebuilt: rebuiltGlue.runtimeMethods,
      exports: setDiff(committedGlue.exports, rebuiltGlue.exports)
    }
  };
}

// --------------------------------------------------------------- install ---

// A rebuilt core that drops an export, a runtime method or WORKERFS would break
// the worker; refuse it before touching cores/dolphin.
export function installRefusal(parity) {
  const { exports, runtimeMethods, filesystems } = parity.glue;
  if (exports.onlyCommitted.length > 0) return `missing exports ${exports.onlyCommitted.join(", ")}`;
  if (runtimeMethods.onlyCommitted.length > 0) {
    return `missing runtime methods ${runtimeMethods.onlyCommitted.join(", ")}`;
  }
  const reachable = new Set([...(filesystems.rebuilt ?? []), ...(parity.glue.runtimeMethodsRebuilt ?? [])]);
  if (!reachable.has("WORKERFS")) return "WORKERFS is not reachable from the rebuilt glue";
  return null;
}

// Files a core installation rewrites: the artifacts, and what update:core-abi
// derives from them.
export const INSTALLED_FILES = [
  "cores/dolphin/dolphin-core-upstream.js",
  "cores/dolphin/dolphin-core-upstream.wasm",
  "cores/dolphin/dolphin-core-upstream.build.json",
  "provenance/dolphin-core-abi-v1.json",
  "src/upstream-worker-protocol.js"
];

// Swap the candidate in, validate, and restore every installed file if the
// validation fails, so cores/dolphin is never left half-replaced. Each file is
// staged next to its destination and renamed into place.
export function installCore({ root: base, outputDir, validate }) {
  const backup = mkdtempSync(join(tmpdir(), "wasm-dolphin-install-"));
  try {
    // Record what exists and back it up before touching anything. A failure
    // here leaves cores/dolphin untouched, so there is nothing to roll back.
    const absent = new Set(INSTALLED_FILES.filter((path) => !existsSync(join(base, path))));
    for (const path of INSTALLED_FILES) {
      if (absent.has(path)) continue;
      mkdirSync(dirname(join(backup, path)), { recursive: true });
      copyFileSync(join(base, path), join(backup, path));
    }
    try {
      for (const name of ["dolphin-core-upstream.js", "dolphin-core-upstream.wasm", "dolphin-core-upstream.build.json"]) {
        const destination = join(base, "cores/dolphin", name);
        copyFileSync(join(outputDir, name), `${destination}.install-tmp`);
        renameSync(`${destination}.install-tmp`, destination);
      }
      validate();
    } catch (error) {
      for (const path of INSTALLED_FILES) {
        rmSync(join(base, `${path}.install-tmp`), { force: true });
        if (absent.has(path)) {
          // Absent before the install: absent after the rollback.
          rmSync(join(base, path), { force: true });
        } else {
          copyFileSync(join(backup, path), join(base, `${path}.install-tmp`));
          renameSync(join(base, `${path}.install-tmp`), join(base, path));
        }
      }
      throw new Error(`Install rolled back, cores/dolphin is unchanged: ${error.message}`, { cause: error });
    }
  } finally {
    rmSync(backup, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- build ---

function buildNative() {
  const platformDir = join(root, "build/repro", hostPlatform);
  const buildDir = join(platformDir, "dolphin-wasm");
  const outputDir = join(platformDir, "core");
  const timings = {};
  const env = {
    ...process.env,
    DOLPHIN_WASM_BUILD_DIR: buildDir,
    DOLPHIN_WASM_OUTPUT_DIR: outputDir,
    // A per-platform cargo target dir: a macOS and a container build of the
    // same checkout must not overwrite each other's Naga archive.
    CARGO_TARGET_DIR: join(platformDir, "naga-target"),
    BUILD_PARALLELISM: option("--jobs", process.env.BUILD_PARALLELISM ?? "8"),
    ...(flag("--allow-dirty") ? { DOLPHIN_ALLOW_DIRTY_BUILD: "1" } : {})
  };

  let start = performance.now();
  if (process.platform !== "win32") {
    try {
      verifyWasmToolchain();
    } catch (error) {
      if (!/npm run toolchain:bootstrap/.test(error.message)) throw error;
      run("bash", [join(root, "tools/toolchain/bootstrap.sh")]);
    }
  }
  const toolchain = verifyWasmToolchain();
  timings.toolchain = seconds(start);

  start = performance.now();
  if (!flag("--no-sync")) {
    removeBytecodeCaches(join(root, "vendor/dolphin/Externals/glslang"));
    run(process.execPath, ["tools/fetch-dolphin.mjs"]);
    run(process.execPath, ["tools/patch-upstream-wasm.mjs"]);
  }
  timings.sources = seconds(start);

  if (flag("--clean")) {
    // Keep a mounted volume's root in place; empty it instead.
    for (const path of [buildDir, outputDir]) {
      if (existsSync(path)) {
        for (const entry of readdirSync(path)) rmSync(join(path, entry), { recursive: true, force: true });
      }
    }
  }
  const identity = currentIdentity();
  for (const emptied of prepareBuildDirectories({ buildDir, outputDir, identity })) {
    console.log(`Emptied ${emptied}: it came from another checkout, patch series or toolchain.`);
  }

  start = performance.now();
  run(process.execPath, ["tools/configure-upstream-wasm.mjs"], { env });
  stampBuildTree(buildDir, identity);
  rmSync(join(outputDir, IDENTITY_STAMP), { force: true });
  timings.configure = seconds(start);

  start = performance.now();
  run(process.execPath, ["tools/build-upstream-target.mjs", "dolphin_web_core"], { env });
  stampBuildTree(outputDir, identity);
  timings.build = seconds(start);

  const parity = {
    schemaVersion: 1,
    platform: hostPlatform,
    toolchain: toolchain.observed
      ? { ...toolchain.observed, paths: undefined }
      : { platform: toolchain.platform },
    timingsSeconds: timings,
    ...compareWithCommitted(outputDir)
  };
  writeFileSync(join(platformDir, "parity.json"), `${JSON.stringify(parity, null, 2)}\n`);

  if (flag("--install")) {
    const refusal = installRefusal(parity);
    if (refusal && !flag("--force-install")) {
      throw new Error(`Not installing: ${refusal} (--force-install overrides)`);
    }
    installCore({
      root,
      outputDir,
      validate: () => {
        run(process.execPath, ["tools/update-core-abi.mjs", "--write"]);
        run(process.execPath, ["tools/verify-dolphin-provenance.mjs"]);
      }
    });
    console.log("Installed the rebuilt core into cores/dolphin for local testing. Do not commit it:");
    console.log("CI builds and commits the core after a merge. `npm run core:restore -- --base origin/main` puts main's back.");
  }

  if (process.env.HOST_UID) {
    // Running as root in the container: hand outputs back to the host user.
    spawnSync("chown", ["-R", `${process.env.HOST_UID}:${process.env.HOST_GID}`,
      platformDir, join(root, "build/core-candidates"), join(root, "vendor")]);
  }

  const same = parity.committed.wasmSha256 === parity.rebuilt.wasmSha256;
  console.log(`\nRebuilt core  sha256:${parity.rebuilt.wasmSha256} (${parity.rebuilt.wasmBytes} bytes)`);
  console.log(`Committed core sha256:${parity.committed.wasmSha256} (${parity.committed.wasmBytes} bytes)`);
  console.log(same ? "Byte-identical to cores/dolphin." :
    `Differs from cores/dolphin; see ${join(platformDir, "parity.json")} and docs/repro-build.md.`);
  console.log(`Load it with ?coreid=sha256:${parity.rebuilt.wasmSha256}`);
  console.log(`Timings (s): ${JSON.stringify(timings)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (flag("--docker-context")) console.log(prepareDockerContext().tag);
    else if (flag("--docker")) runInDocker();
    else buildNative();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(root, "provenance/wasm-toolchain.lock.json");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256NormalizedTextFile(path) {
  return createHash("sha256")
    .update(readFileSync(path, "utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
}

function normalizedTextBytes(path) {
  return Buffer.from(readFileSync(path, "utf8").replaceAll("\r\n", "\n"));
}

function expandCandidate(candidate) {
  return resolve(
    String(candidate).replace(/%([^%]+)%/g, (_, name) => {
      const value = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
      invariant(value, `Environment variable ${name} is required to resolve ${candidate}`);
      return value;
    })
  );
}

function pathCandidate(command) {
  const where = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
  if (where.status !== 0) return null;
  return where.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function resolveTool(label, envName, candidates, expectedSha256, pathCommand = null) {
  const attempted = [];
  const values = [process.env[envName], ...candidates.map(expandCandidate), pathCommand && pathCandidate(pathCommand)]
    .filter(Boolean);

  for (const value of values) {
    const path = resolve(value);
    attempted.push(path);
    if (!existsSync(path)) continue;
    const actual = sha256File(path);
    invariant(
      actual === expectedSha256,
      `${label} hash mismatch at ${path}: expected ${expectedSha256}, got ${actual}`
    );
    return path;
  }

  throw new Error(`${label} was not found. Checked: ${attempted.join(", ")}`);
}

function runVersion(command, args) {
  const isBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  const executable = isBatch ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = isBatch ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true
  });
  invariant(!result.error && result.status === 0, `Could not run ${command} ${args.join(" ")}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function requireText(label, output, expected) {
  invariant(output.includes(expected), `${label} version mismatch: expected output containing ${expected}, got ${output}`);
}

export function loadWasmToolchainLock() {
  return JSON.parse(readFileSync(lockPath, "utf8"));
}

export const hostPlatform = `${process.platform}-${process.arch}`;

export function verifyWasmToolchain() {
  const lock = loadWasmToolchainLock();
  invariant(lock.schemaVersion === 1, `Unsupported toolchain lock schema ${lock.schemaVersion}`);
  if (hostPlatform !== lock.platform && lock.posix?.platforms?.[hostPlatform]) {
    return verifyPosixToolchain(lock);
  }
  const supported = [lock.platform, ...Object.keys(lock.posix?.platforms ?? {})];
  invariant(hostPlatform === lock.platform, `Toolchain lock supports ${supported.join(", ")}, not ${hostPlatform}`);

  const node = resolveTool("Node", "DOLPHIN_NODE", lock.node.candidates, lock.node.sha256, "node.exe");
  const emcc = resolveTool("emcc", "EMCC", lock.emscripten.emccCandidates, lock.emscripten.emccSha256, "emcc.bat");
  const emcmake = resolveTool("emcmake", "EMCMAKE", lock.emscripten.emcmakeCandidates, lock.emscripten.emcmakeSha256, "emcmake.bat");
  const cmake = resolveTool("CMake", "CMAKE", lock.cmake.candidates, lock.cmake.sha256, "cmake.exe");
  const ninja = resolveTool("Ninja", "NINJA", lock.ninja.candidates, lock.ninja.sha256, "ninja.exe");
  const rustc = resolveTool("rustc", "RUSTC", lock.rust.rustcCandidates, lock.rust.rustcSha256);
  const cargo = resolveTool("cargo", "CARGO", lock.rust.cargoCandidates, lock.rust.cargoSha256);
  const rustup = resolveTool("rustup", "RUSTUP", lock.rust.rustupCandidates, lock.rust.rustupSha256);

  requireText("Node", runVersion(node, ["--version"]), `v${lock.node.version}`);
  const emccVersion = runVersion(emcc, ["--version"]);
  requireText("Emscripten", emccVersion, lock.emscripten.version);
  requireText("Emscripten compiler", emccVersion, lock.emscripten.compilerCommit);
  requireText("CMake", runVersion(cmake, ["--version"]), lock.cmake.version);
  requireText("Ninja", runVersion(ninja, ["--version"]), lock.ninja.version);
  const rustcVersion = runVersion(rustc, ["--version", "--verbose"]);
  requireText("rustc", rustcVersion, lock.rust.rustcVersion);
  requireText("rustc", rustcVersion, lock.rust.rustcCommit);
  const cargoVersion = runVersion(cargo, ["--version", "--verbose"]);
  requireText("cargo", cargoVersion, lock.rust.cargoVersion);
  requireText("cargo", cargoVersion, lock.rust.cargoCommit);

  const emsdkRoot = resolve(dirname(emcc), "../..");
  const emsdkHead = runVersion("git", ["-C", emsdkRoot, "rev-parse", "HEAD"]);
  invariant(emsdkHead === lock.emscripten.emsdkCommit, `emsdk commit mismatch: expected ${lock.emscripten.emsdkCommit}, got ${emsdkHead}`);
  const clangxx = resolve(emsdkRoot, "upstream/bin/clang++.exe");
  invariant(existsSync(clangxx), `Emscripten clang++ is missing at ${clangxx}`);
  invariant(sha256File(clangxx) === lock.emscripten.clangxxSha256, "Emscripten clang++ hash mismatch");

  if (lock.rust.rustSrcRequired) {
    const installed = runVersion(rustup, ["component", "list", "--toolchain", lock.rust.toolchain, "--installed"]);
    invariant(installed.split(/\r?\n/).some((line) => line.startsWith("rust-src")), `${lock.rust.toolchain} is missing rust-src`);
  }

  verifyNagaSources(lock);

  return {
    lock,
    platform: hostPlatform,
    paths: { node, emcc, emcmake, cmake, ninja, rustc, cargo, rustup, clangxx },
    hashes: {
      lock: sha256File(lockPath),
      cargoLock: sha256NormalizedTextFile(resolve(root, "tools/naga-spirv-wgsl/Cargo.lock"))
    }
  };
}

function verifyNagaSources(lock) {
  const cargoLock = resolve(root, "tools/naga-spirv-wgsl/Cargo.lock");
  invariant(lock.naga.cargoLockHashMode === "lf-normalized", "Unsupported Naga Cargo.lock hash mode");
  invariant(sha256NormalizedTextFile(cargoLock) === lock.naga.cargoLockSha256, "Naga Cargo.lock hash mismatch");
  const cargoToml = readFileSync(resolve(root, "tools/naga-spirv-wgsl/Cargo.toml"), "utf8");
  invariant(cargoToml.includes(`version = "${lock.naga.crateVersion}"`), "Naga crate version does not match the lock");
  invariant(cargoToml.includes(`naga = { version = "${lock.naga.dependencyVersion.split(".")[0]}"`), "Naga dependency version does not match the lock");
  invariant(Array.isArray(lock.naga.sourceRecords) && lock.naga.sourceRecords.length > 0,
    "Naga source records are missing from the toolchain lock");
  for (const record of lock.naga.sourceRecords) {
    invariant(record.hashMode === "lf-normalized", `Unsupported Naga source hash mode for ${record.path}`);
    const path = resolve(root, record.path);
    invariant(existsSync(path), `Missing Naga source ${record.path}`);
    const bytes = normalizedTextBytes(path);
    invariant(bytes.length === record.size, `Naga source size mismatch for ${record.path}`);
    invariant(createHash("sha256").update(bytes).digest("hex") === record.sha256,
      `Naga source hash mismatch for ${record.path}`);
  }
}

// macOS and Linux: every tool lives in one directory populated by
// tools/toolchain/bootstrap.sh from pinned sources (emsdk commit + release,
// a dated Rust nightly, hash-locked CMake/Ninja wheels). Nothing is taken from
// PATH, so a stray Homebrew cmake or a second emsdk cannot slip in.
export function posixToolchainDir() {
  return resolve(root, process.env.WASM_TOOLCHAIN_DIR ?? loadWasmToolchainLock().posix.toolchainDir);
}

// The Emscripten layer that decides what the JS glue contains (src/lib/*.js,
// settings, link.py, emcc.py) is plain text and identical on every host, so one
// digest pins it everywhere. This is the input that issue #13 showed the
// version string alone does not pin (FS.filesystems differed under an
// identical version record).
const EMSCRIPTEN_TREE_ROOTS = ["emcc.py", "emcmake.py", "src", "tools", "system/include", "system/lib"];

export function emscriptenTreeSha256(emscriptenDir) {
  const files = [];
  const walk = (path) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name === "__pycache__" || name === "node_modules" || name.endsWith(".pyc")) continue;
        walk(join(path, name));
      }
    } else if (stats.isFile()) {
      files.push(path);
    }
  };
  for (const entry of EMSCRIPTEN_TREE_ROOTS) {
    const path = join(emscriptenDir, entry);
    if (existsSync(path)) walk(path);
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${relative(emscriptenDir, file).split("\\").join("/")}\0${sha256File(file)}\n`);
  }
  return { sha256: hash.digest("hex"), files: files.length };
}

function rustHostTriple() {
  return {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu"
  }[hostPlatform];
}

export function posixToolPaths(lock = loadWasmToolchainLock()) {
  const dir = posixToolchainDir();
  const emsdkRoot = join(dir, "emsdk");
  const emscriptenDir = join(emsdkRoot, "upstream/emscripten");
  const rustupHome = process.env.RUSTUP_HOME ?? join(process.env.HOME ?? "", ".rustup");
  const rustToolchain = join(rustupHome, "toolchains", `${lock.posix.rust.toolchain}-${rustHostTriple()}`);
  const pythonBin = join(dir, "python/bin");
  return {
    toolchainDir: dir,
    emsdkRoot,
    emscriptenDir,
    emcc: join(emscriptenDir, "emcc"),
    emcmake: join(emscriptenDir, "emcmake"),
    clang: join(emsdkRoot, "upstream/bin/clang"),
    wasmLd: join(emsdkRoot, "upstream/bin/wasm-ld"),
    wasmOpt: join(emsdkRoot, "upstream/bin/wasm-opt"),
    cmake: join(pythonBin, "cmake"),
    ninja: join(pythonBin, "ninja"),
    rustToolchain,
    rustc: join(rustToolchain, "bin/rustc"),
    cargo: join(rustToolchain, "bin/cargo")
  };
}

// The Ninja wheel installs its binary straight into bin/; the CMake wheel puts
// a Python launcher there and the binary under site-packages. Hash the binary.
function wheelBinary(paths, name) {
  const launcher = join(paths.toolchainDir, "python/bin", name);
  if (existsSync(launcher) && readFileSync(launcher).subarray(0, 2).toString() !== "#!") return launcher;
  const lib = join(paths.toolchainDir, "python/lib");
  invariant(existsSync(lib), `Missing Python environment in ${paths.toolchainDir}`);
  for (const version of readdirSync(lib)) {
    const candidate = join(lib, version, `site-packages/${name}/data/bin/${name}`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find the ${name} wheel binary under ${lib}`);
}

export function observePosixToolchain(lock = loadWasmToolchainLock()) {
  const paths = posixToolPaths(lock);
  const missing = ["emcc", "emcmake", "clang", "wasmLd", "wasmOpt", "cmake", "ninja", "rustc", "cargo"]
    .filter((key) => !existsSync(paths[key]));
  invariant(missing.length === 0,
    `Pinned toolchain is incomplete in ${paths.toolchainDir} (missing ${missing.join(", ")}). ` +
    "Run npm run toolchain:bootstrap first.");
  const real = (path) => realpathSync(path);
  const emccVersion = runVersion(paths.emcc, ["--version"]);
  const rustcVersion = runVersion(paths.rustc, ["--version", "--verbose"]);
  const rustSrc = join(paths.rustToolchain, "lib/rustlib/src/rust/library/Cargo.lock");
  const emscriptenTree = emscriptenTreeSha256(paths.emscriptenDir);
  return {
    platform: hostPlatform,
    paths,
    emsdkCommit: runVersion("git", ["-C", paths.emsdkRoot, "rev-parse", "HEAD"]),
    emscriptenVersion: readFileSync(join(paths.emscriptenDir, "emscripten-version.txt"), "utf8").trim().replaceAll('"', ""),
    emccVersion: emccVersion.split("\n")[0],
    emscriptenTreeSha256: emscriptenTree.sha256,
    emscriptenTreeFiles: emscriptenTree.files,
    clangVersion: runVersion(paths.clang, ["--version"]).split("\n")[0],
    cmakeVersion: runVersion(paths.cmake, ["--version"]).split("\n")[0],
    ninjaVersion: runVersion(paths.ninja, ["--version"]),
    rustcVersion: rustcVersion.split("\n")[0],
    rustcCommit: /commit-hash: ([0-9a-f]+)/.exec(rustcVersion)?.[1] ?? null,
    rustSrcPresent: existsSync(rustSrc),
    hashes: {
      clangSha256: sha256File(real(paths.clang)),
      wasmLdSha256: sha256File(real(paths.wasmLd)),
      wasmOptSha256: sha256File(real(paths.wasmOpt)),
      rustcSha256: sha256File(real(paths.rustc)),
      cargoSha256: sha256File(real(paths.cargo)),
      cmakeSha256: sha256File(wheelBinary(paths, "cmake")),
      ninjaSha256: sha256File(wheelBinary(paths, "ninja"))
    }
  };
}

function verifyPosixToolchain(lock) {
  const expected = lock.posix.platforms[hostPlatform];
  const observed = observePosixToolchain(lock);
  const { paths } = observed;
  invariant(observed.emsdkCommit === lock.posix.emsdk.commit,
    `emsdk commit mismatch: expected ${lock.posix.emsdk.commit}, got ${observed.emsdkCommit}`);
  requireText("Emscripten", observed.emccVersion, lock.emscripten.version);
  requireText("Emscripten compiler", runVersion(paths.emcc, ["--version"]), lock.emscripten.compilerCommit);
  invariant(observed.emscriptenTreeSha256 === lock.posix.emscriptenTreeSha256,
    `Emscripten source tree mismatch in ${paths.emscriptenDir}: expected ${lock.posix.emscriptenTreeSha256}, ` +
    `got ${observed.emscriptenTreeSha256}`);
  requireText("CMake", observed.cmakeVersion, lock.cmake.version);
  requireText("Ninja", observed.ninjaVersion, lock.ninja.version);
  requireText("rustc", observed.rustcVersion, lock.rust.rustcVersion);
  invariant(observed.rustcCommit === lock.rust.rustcCommit,
    `rustc commit mismatch: expected ${lock.rust.rustcCommit}, got ${observed.rustcCommit}`);
  invariant(!lock.rust.rustSrcRequired || observed.rustSrcPresent,
    `${lock.posix.rust.toolchain} is missing rust-src`);
  for (const [key, value] of Object.entries(expected)) {
    invariant(observed.hashes[key] === value,
      `${key.replace(/Sha256$/, "")} hash mismatch on ${hostPlatform}: expected ${value}, got ${observed.hashes[key]}`);
  }
  verifyNagaSources(lock);
  return {
    lock,
    platform: hostPlatform,
    observed,
    paths: { ...paths, clangxx: paths.clang, rustup: null, node: process.execPath },
    hashes: {
      lock: sha256File(lockPath),
      cargoLock: sha256NormalizedTextFile(resolve(root, "tools/naga-spirv-wgsl/Cargo.lock"))
    }
  };
}

export { lockPath, root as repositoryRoot, sha256File, sha256NormalizedTextFile };

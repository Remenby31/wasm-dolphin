import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, relative, resolve } from "node:path";
import { sha256File, verifyWasmToolchain } from "./wasm-toolchain.mjs";

const root = process.cwd();
const sourceDir = resolve(root, "vendor/dolphin");
const buildDir = resolve(process.env.DOLPHIN_WASM_BUILD_DIR ?? resolve(root, "build/dolphin-wasm"));
const bridgeSource = resolve(root, "core/upstream/dolphin_web_discio.cpp");
const sharedSourceDir = dirname(bridgeSource);
const coreSource = resolve(root, "core/upstream/dolphin_web_core.cpp");
const outputDir = resolve(process.env.DOLPHIN_WASM_OUTPUT_DIR ?? resolve(root, "cores/dolphin"));
const nagaDir = resolve(root, "tools/naga-spirv-wgsl");
const jitCachePreJs = resolve(root, "tools/jit-cache-prejs.js");
const wasmMemoryPages = 24576;
const fastBranchInline = String(
  process.env.DOLPHIN_WEB_INLINE_FAST_BRANCH ?? "1"
).trim();
if (!["0", "1"].includes(fastBranchInline)) {
  throw new Error(
    `DOLPHIN_WEB_INLINE_FAST_BRANCH must be 0 or 1, got ${JSON.stringify(fastBranchInline)}`
  );
}
const fallbackMapDiagnostics = String(
  process.env.DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS ?? "0"
).trim();
if (!["0", "1"].includes(fallbackMapDiagnostics)) {
  throw new Error(
    `DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS must be 0 or 1, got ${JSON.stringify(fallbackMapDiagnostics)}`
  );
}
const fallbackMapBits = String(
  process.env.DOLPHIN_WEB_FALLBACK_MAP_BITS ?? "16"
).trim();
if (!["16", "18", "20"].includes(fallbackMapBits)) {
  throw new Error(
    `DOLPHIN_WEB_FALLBACK_MAP_BITS must be 16, 18, or 20, got ${JSON.stringify(fallbackMapBits)}`
  );
}
const directWasmBlockDispatch = String(
  process.env.DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH ?? "0"
).trim();
if (!["0", "1"].includes(directWasmBlockDispatch)) {
  throw new Error(
    `DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH must be 0 or 1, got ${JSON.stringify(directWasmBlockDispatch)}`
  );
}

function quoteShellArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function run(command, args, options = {}) {
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  const result = spawnSync(isWindowsBatch ? [command, ...args].map(quoteShellArg).join(" ") : command, isWindowsBatch ? [] : args, {
    encoding: "utf8",
    stdio: "inherit",
    shell: isWindowsBatch,
    ...options
  });

  if (result.error || result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!existsSync(resolve(sourceDir, "CMakeLists.txt"))) {
  console.error("vendor/dolphin is missing. Run npm run fetch:dolphin first.");
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

const toolchain = verifyWasmToolchain();
const { emcc, emcmake, cmake, ninja, cargo, rustc } = toolchain.paths;
const nagaEnvironment = {
  ...process.env,
  PATH: [dirname(rustc), dirname(emcc), process.env.PATH ?? ""].join(delimiter),
  RUSTC: rustc,
  CARGO: cargo
};

// Absolute checkout, build and toolchain paths reach the binary through
// __FILE__ (Dolphin asserts) and Rust panic locations (std rebuilt from
// rust-src, crates from the cargo registry). Map them onto fixed virtual roots
// so the core depends on the sources, not on where they sit: a macOS checkout,
// a Docker container and a CI runner then produce the same bytes.
const forwardSlashes = (path) => path.replaceAll("\\", "/");
const virtualRoot = "/wasm-dolphin";
for (const path of [root, buildDir]) {
  if (/\s/.test(path)) {
    throw new Error(`Build paths must not contain whitespace (CMake flag lists split on it): ${path}`);
  }
}
const sourcePathFlags = [`-ffile-prefix-map=${forwardSlashes(root)}=${virtualRoot}`];
if (relative(root, buildDir).startsWith("..")) {
  sourcePathFlags.push(`-ffile-prefix-map=${forwardSlashes(buildDir)}=${virtualRoot}/build/dolphin-wasm`);
}
const rustSysroot = spawnSync(rustc, ["--print", "sysroot"], { encoding: "utf8" }).stdout.trim();
if (!rustSysroot) {
  throw new Error(`Could not query the sysroot of ${rustc}`);
}
// Crate sources are unpacked under registry/src/<source-name>-<hash>, and the
// source name follows the host's cargo configuration (a crates.io mirror gets
// its own directory). Cargo.lock checksums already pin the content, so fold
// every registry directory onto one virtual name. Fetch first so the
// directories exist before they are enumerated.
const cargoHome = resolve(process.env.CARGO_HOME ?? resolve(homedir(), ".cargo"));
run(cargo, ["fetch", "--locked"], { cwd: nagaDir, env: nagaEnvironment });
const registrySources = existsSync(resolve(cargoHome, "registry/src"))
  ? readdirSync(resolve(cargoHome, "registry/src")).sort()
  : [];
// rustc applies the last matching mapping, so the most specific come last.
const rustRemapFlags = [
  [cargoHome, "/cargo"],
  ...registrySources.map((name) => [resolve(cargoHome, "registry/src", name), "/cargo/registry/src/crates.io"]),
  [resolve(rustSysroot, "lib/rustlib/src/rust"), `/rustc/${toolchain.lock.rust.rustcCommit}`],
  [root, virtualRoot]
].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);

console.log("Building the pinned Naga SPIR-V to WGSL bridge");
// Take the archive cargo reports for this build. Picking whichever of the two
// possible file names exists let a stale archive from an older toolchain win
// (issue #13, naga hash drift under an identical record).
const nagaBuild = spawnSync(cargo, [
  "build", "--locked", "--release", "--target", toolchain.lock.rust.target,
  "--message-format=json-render-diagnostics",
  "--config", `target.${toolchain.lock.rust.target}.rustflags=${JSON.stringify(rustRemapFlags)}`
], {
  cwd: nagaDir,
  env: nagaEnvironment,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: 64 * 1024 * 1024
});
if (nagaBuild.error || nagaBuild.status !== 0) {
  process.exit(nagaBuild.status || 1);
}
const nagaArtifacts = nagaBuild.stdout.split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line))
  .filter((message) => message.reason === "compiler-artifact" && message.target?.name === "naga_spirv_wgsl")
  .flatMap((message) => message.filenames)
  .filter((file) => file.endsWith(".a"));
if (nagaArtifacts.length !== 1 || !existsSync(nagaArtifacts[0])) {
  console.error(`Pinned Naga build reported ${nagaArtifacts.length} static archives: ${nagaArtifacts.join(", ")}`);
  process.exit(1);
}
const resolvedNagaLibrary = nagaArtifacts[0];

// CMake runs hundreds of feature probes. Keep the original global production
// flags so subprojects that replace their Release flags still retain LTO, but
// make try_compile use Debug and append overrides that disable optimization
// and LTO for probes only. Clang/Emscripten honors the last -O*/-f*lto option.
const wasmCompileFlags =
  "-O3 -pthread -msimd128 -flto -DXXH_VECTOR=0 -DDOLPHIN_WEB_HOT_COUNTERS=0 " +
  `-DDOLPHIN_WEB_INLINE_FAST_BRANCH=${fastBranchInline} ` +
  `-DDOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS=${fallbackMapDiagnostics} ` +
  `-DDOLPHIN_WEB_FALLBACK_MAP_BITS=${fallbackMapBits} ` +
  `-DDOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH=${directWasmBlockDispatch} ` +
  sourcePathFlags.join(" ");
const wasmDebugProbeFlags = "-O0 -fno-lto";
const cmakeArgs = [
  cmake,
  "-S",
  sourceDir,
  "-B",
  buildDir,
  "-GNinja",
  `-DCMAKE_MAKE_PROGRAM=${ninja}`,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_TRY_COMPILE_CONFIGURATION=Debug",
  "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
  "-DUSE_SYSTEM_LIBS=OFF",
  "-DENABLE_GENERIC=ON",
  "-DENABLE_QT=OFF",
  "-DENABLE_NOGUI=OFF",
  "-DENABLE_CLI_TOOL=OFF",
  "-DENABLE_HEADLESS=OFF",
  "-DENABLE_ALSA=OFF",
  "-DENABLE_PULSEAUDIO=OFF",
  "-DENABLE_CUBEB=OFF",
  "-DENABLE_X11=OFF",
  "-DENABLE_EGL=OFF",
  "-DENABLE_SDL=OFF",
  "-DENABLE_VULKAN=OFF",
  "-DENABLE_LLVM=OFF",
  "-DENABLE_TESTS=OFF",
  "-DUSE_UPNP=OFF",
  "-DUSE_DISCORD_PRESENCE=OFF",
  "-DUSE_MGBA=OFF",
  "-DUSE_RETRO_ACHIEVEMENTS=OFF",
  "-DENABLE_AUTOUPDATE=OFF",
  "-DENABLE_ANALYTICS=OFF",
  "-DENCODE_FRAMEDUMPS=OFF",
  "-DWITH_OPTIM=OFF",
  "-DWITH_SSE2=OFF",
  "-DWITH_SSSE3=OFF",
  "-DWITH_SSE41=OFF",
  "-DWITH_SSE42=OFF",
  "-DWITH_PCLMULQDQ=OFF",
  "-DWITH_AVX2=OFF",
  "-DWITH_AVX512=OFF",
  "-DWITH_AVX512VNNI=OFF",
  "-DWITH_VPCLMULQDQ=OFF",
  `-DCMAKE_C_FLAGS:STRING=${wasmCompileFlags}`,
  `-DCMAKE_CXX_FLAGS:STRING=${wasmCompileFlags}`,
  `-DCMAKE_C_FLAGS_DEBUG:STRING=${wasmDebugProbeFlags}`,
  `-DCMAKE_CXX_FLAGS_DEBUG:STRING=${wasmDebugProbeFlags}`,
  `-DDOLPHIN_WASM_NAGA_WGSL_LIB=${resolvedNagaLibrary}`,
  `-DDOLPHIN_WASM_JIT_CACHE_PRE_JS=${jitCachePreJs}`,
  `-DDOLPHIN_WASM_MEMORY_PAGES=${wasmMemoryPages}`
];

// The vendored CMakeLists needs this project's root to locate the Naga
// staticlib and the jit-cache pre-js. CMAKE_SOURCE_DIR there is the vendored
// Dolphin tree, not this repo. It can derive the root from the core source
// path, but pass it explicitly so a clone at any path links correctly.
cmakeArgs.push(`-DDOLPHIN_WASM_PROJECT_ROOT=${root.replace(/\\/g, "/")}`);

// PROFILING_FUNCS=1 adds a wasm name section to the core so CPU profiles show
// real symbols instead of wasm-function[N]. Name section only — no codegen or
// optimisation change, so timings stay representative. Off by default.
if (process.env.PROFILING_FUNCS === "1") {
  // The -D was on its own for a while, and nothing in the vendored CMake ever
  // read it: the configure step logged that it was building with symbols, the
  // link never got the flag, and the profile still read wasm-function[N].
  // Pass the flag itself so the setting cannot be advertised without taking
  // effect.
  cmakeArgs.push("-DDOLPHIN_WASM_PROFILING_FUNCS=ON");
  cmakeArgs.push("-DCMAKE_EXE_LINKER_FLAGS:STRING=--profiling-funcs");
  console.log("PROFILING_FUNCS=1 -> core will be built with a wasm name section");
}

if (existsSync(bridgeSource)) {
  cmakeArgs.push(`-DDOLPHIN_WASM_BRIDGE_SOURCE=${bridgeSource}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_SHARED_SOURCE_DIR=${sharedSourceDir}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_OUTPUT_DIR=${outputDir}`);
}

if (existsSync(coreSource)) {
  cmakeArgs.push(`-DDOLPHIN_WASM_CORE_SOURCE=${coreSource}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_OUTPUT_DIR=${outputDir}`);
}

console.log(`Configuring upstream Dolphin for Emscripten in ${buildDir}`);
run(emcmake, cmakeArgs);
writeFileSync(resolve(buildDir, "wasm-dolphin-configure.json"), `${JSON.stringify({
  schemaVersion: 1,
  sourceDir,
  buildDir,
  outputDir,
  bridgeSource,
  sharedSourceDir,
  coreSource,
  nagaLibrary: resolvedNagaLibrary,
  nagaLibrarySha256: sha256File(resolvedNagaLibrary),
  jitCachePreJs,
  wasmMemoryPages,
  fastBranchInline,
  fallbackMapDiagnostics,
  fallbackMapBits,
  directWasmBlockDispatch,
  wasmCompileFlags,
  sourcePathFlags,
  rustRemapFlags,
  cmakeArgs,
  toolchainLockSha256: toolchain.hashes.lock,
  cargoLockSha256: toolchain.hashes.cargoLock
}, null, 2)}\n`);
console.log("Configured. Probe targets with: cmake --build build/dolphin-wasm --target discio --parallel 8");

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { sha256File, verifyWasmToolchain } from "./wasm-toolchain.mjs";
import { buildGameSettings } from "./gamesettings-filter.mjs";
import { rustRemapFlags as remapFlags, scmGitShim, sourcePathFlags as pathFlags, vendoredCargoArgs } from "./toolchain/path-maps.mjs";

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
// DOLPHIN_WEB_DET_TRACE=1: a trace build (patch 0081's CoreTiming trace, read
// by harness/probes/determinism.mjs). Off by default: a player's core has
// none of it and CoreTiming's hot path is upstream's.
const detTrace = String(process.env.DOLPHIN_WEB_DET_TRACE ?? "0").trim();
if (!["0", "1"].includes(detTrace)) {
  throw new Error(`DOLPHIN_WEB_DET_TRACE must be 0 or 1, got ${JSON.stringify(detTrace)}`);
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

// Absolute checkout, build and toolchain paths reach the binary; map them onto
// fixed virtual roots (tools/toolchain/path-maps.mjs) so a macOS checkout, a
// Docker container and a CI runner produce the same bytes.
const { flags: sourcePathFlags, unmapped: unmappedPaths } = pathFlags({ root, buildDir });
for (const path of unmappedPaths) {
  console.warn(`Not remapping ${path}: it contains whitespace; the core will embed this path.`);
}
const rustSysroot = spawnSync(rustc, ["--print", "sysroot"], { encoding: "utf8" }).stdout.trim();
if (!rustSysroot) {
  throw new Error(`Could not query the sysroot of ${rustc}`);
}
// The GPL source archive carries every crate (Naga's and std's) vendored here
// and builds offline from them.
const vendoredCrates = resolve(nagaDir, "vendor");
const useVendoredCrates = existsSync(resolve(vendoredCrates, "naga-26.0.0"));
const cargoSourceArgs = useVendoredCrates ? vendoredCargoArgs(vendoredCrates) : [];
const cargoHome = resolve(process.env.CARGO_HOME ?? resolve(homedir(), ".cargo"));
if (!useVendoredCrates) {
  // Fetch first so the registry directories exist before they are enumerated.
  run(cargo, ["fetch", "--locked"], { cwd: nagaDir, env: nagaEnvironment });
}
const registrySources = existsSync(resolve(cargoHome, "registry/src"))
  ? readdirSync(resolve(cargoHome, "registry/src")).sort()
  : [];
const rustRemapFlags = remapFlags({
  cargoHome,
  registryDirs: registrySources.map((name) => resolve(cargoHome, "registry/src", name)),
  rustSrc: resolve(rustSysroot, "lib/rustlib/src/rust"),
  rustcCommit: toolchain.lock.rust.rustcCommit,
  root,
  vendoredCrates: useVendoredCrates ? vendoredCrates : null
});

console.log("Building the pinned Naga SPIR-V to WGSL bridge");
// Take the archive cargo reports for this build. Picking whichever of the two
// possible file names exists let a stale archive from an older toolchain win
// (issue #13, naga hash drift under an identical record).
const nagaBuild = spawnSync(cargo, [
  "build", "--locked", "--release", "--target", toolchain.lock.rust.target,
  "--message-format=json-render-diagnostics",
  ...cargoSourceArgs,
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
  `-DDOLPHIN_WEB_DET_TRACE=${detTrace} ` +
  sourcePathFlags.join(" ");
const wasmDebugProbeFlags = "-O0 -fno-lto";
// Dolphin's per-game settings (patch 0097): the GameCube discs' INIs with
// only the allowlisted keys (tools/gamesettings-allowlist.json), embedded at
// /dolphin-sys/GameSettings where GameConfigLoader looks for them.
const gameSettingsDir = resolve(buildDir, "gamesettings");
const gameSettingsFiles = buildGameSettings(resolve(sourceDir, "Data/Sys/GameSettings"), gameSettingsDir);
console.log(`gamesettings: ${gameSettingsFiles.length} disc files with allowlisted keys`);

const cmakeArgs = [
  cmake,
  "-S",
  sourceDir,
  "-B",
  buildDir,
  "-GNinja",
  `-DCMAKE_MAKE_PROGRAM=${ninja}`,
  "-DCMAKE_BUILD_TYPE=Release",
  `-DDOLPHIN_WEB_GAMESETTINGS_DIR=${gameSettingsDir}`,
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

// scmrev.h from the source lock, not from vendor/dolphin/.git (absent in the
// GPL source archive). POSIX shell only; Windows keeps asking git.
if (process.platform !== "win32") {
  const lockedCommit = JSON.parse(readFileSync(resolve(root, "provenance/dolphin-source.lock.json"), "utf8")).upstream.commit;
  const shim = resolve(buildDir, "scm-git.sh");
  writeFileSync(shim, scmGitShim(lockedCommit));
  chmodSync(shim, 0o755);
  cmakeArgs.push("-DCMAKE_DISABLE_FIND_PACKAGE_Git=ON", "-DGIT_FOUND=ON", `-DGIT_EXECUTABLE=${shim}`);
}

// DOLPHIN_WASM_CCACHE=<path to ccache> compiles through ccache (set by
// build-core-repro.mjs --ccache). The launcher does not change the compiler's
// arguments; CI checks that a ccache build gives the same core as one without.
if (process.env.DOLPHIN_WASM_CCACHE) {
  cmakeArgs.push(
    `-DCMAKE_C_COMPILER_LAUNCHER=${process.env.DOLPHIN_WASM_CCACHE}`,
    `-DCMAKE_CXX_COMPILER_LAUNCHER=${process.env.DOLPHIN_WASM_CCACHE}`
  );
} else {
  // A tree configured with ccache keeps the launcher in CMakeCache.txt unless
  // it is cleared explicitly.
  cmakeArgs.push("-UCMAKE_C_COMPILER_LAUNCHER", "-UCMAKE_CXX_COMPILER_LAUNCHER");
}

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
  detTrace,
  wasmCompileFlags,
  sourcePathFlags,
  unmappedPaths,
  useVendoredCrates,
  rustRemapFlags,
  cmakeArgs,
  toolchainLockSha256: toolchain.hashes.lock,
  cargoLockSha256: toolchain.hashes.cargoLock
}, null, 2)}\n`);
console.log("Configured. Probe targets with: cmake --build build/dolphin-wasm --target discio --parallel 8");

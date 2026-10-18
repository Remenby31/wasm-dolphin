import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fileRecord,
  inspectMemoryContract,
  inspectWorkerProtocol,
  loadSourceLock,
  publicModuleExports,
  REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS,
  verifyCoreAbiManifest,
} from "./dolphin-provenance.mjs";
import { pinnedCoreHash, withPinnedCoreHash } from "./core-pin.mjs";

const root = process.cwd();
const manifestPath = resolve(root, "provenance/dolphin-core-abi-v1.json");
const write = process.argv.includes("--write");
const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
const lock = loadSourceLock(root);
const artifacts = previous.artifacts.map((artifact) => ({
  ...fileRecord(artifact.path, root, artifact.hashMode ?? "raw"),
  ...(artifact.hashMode ? { hashMode: artifact.hashMode } : {}),
}));
const wasm = artifacts.find((artifact) => artifact.path.endsWith(".wasm"));
if (!wasm) throw new Error("Core ABI manifest has no WASM artifact");
const protocolPath = resolve(root, "src/upstream-worker-protocol.js");
const protocolSource = readFileSync(protocolPath, "utf8");
const pinnedCoreSha256 = await pinnedCoreHash(protocolSource);
if (pinnedCoreSha256 !== wasm.sha256) {
  if (!write) {
    throw new Error(
      `Default worker core SHA-256 is stale: ${pinnedCoreSha256}; expected ${wasm.sha256}`
    );
  }
  writeFileSync(protocolPath, await withPinnedCoreHash(protocolSource, wasm.sha256));
}
const contractSourceDeclarations = [...previous.contractSources];
for (const requiredPath of [
  "src/incremental-sha256.js",
  "src/jit-cache-identity.js",
  "src/wgpu-consumer-reset-attestation.js",
  "src/wgpu-legacy-semantic-decoder.js",
  "src/wgpu-mapped-staging-pool.js",
  "src/wgpu-ownership-command-correlator.js",
  "src/wgpu-pass-package-projection.js",
  "src/wgpu-resource-generation-tracker.js",
  "src/wgpu-renderer-runtime.js",
  "src/wgpu-semantic-digest.js",
  "src/wgpu-semantic-parity-sink.js",
  "src/wgpu-semantic-runtime.js",
  "src/wgpu-semantic-v2-decoder.js",
  "src/wgpu-sparse-ubo-copy-forward.js",
  "src/wgpu-ubo-compute-projection.js",
  "src/wgpu-ubo-compute-codec.js",
  "src/wgpu-ubo-compute-reconstruction.js",
  "src/wgpu-upload-run-projection.js",
  "src/wgpu-ownership-trace.js",
  "src/wgpu-visual-cadence.js",
]) {
  if (!contractSourceDeclarations.some((source) => source.path === requiredPath)) {
    contractSourceDeclarations.push({
      path: requiredPath,
      hashMode: "lf-normalized",
    });
  }
}
const contractSources = contractSourceDeclarations.map((source) => ({
  ...fileRecord(source.path, root, source.hashMode ?? "raw"),
  ...(source.hashMode ? { hashMode: source.hashMode } : {}),
}));
const glue = readFileSync(resolve(root, "cores/dolphin/dolphin-core-upstream.js"), "utf8");
const moduleExports = publicModuleExports(glue);
const memoryContract = inspectMemoryContract(root);
const runtimeMethods = inspectRuntimeMethods(lock, glue);
const manifest = {
  ...previous,
  coreId: `sha256:${wasm.sha256}`,
  upstreamCommit: lock.upstream.commit,
  artifacts,
  contractSources,
  memoryContract,
  memoryContractStatus: memoryContractStatus(memoryContract),
  sourceOnlyExportsPendingRebuild: [
    ...new Set([
      ...(previous.sourceOnlyExportsPendingRebuild ?? []),
      ...REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS,
    ]),
  ].filter((name) => !moduleExports.includes(name)),
  moduleExports,
  runtimeMethods,
  workerProtocol: inspectWorkerProtocol(root),
};

if (write) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  verifyCoreAbiManifest(root);
}

console.log(JSON.stringify({
  wroteFile: write,
  coreId: manifest.coreId,
  artifactSizes: Object.fromEntries(artifacts.map((artifact) => [artifact.path, artifact.size])),
  contractSourceCount: contractSources.length,
  moduleExportCount: manifest.moduleExports.length,
  runtimeMethods,
  memoryContractStatus: manifest.memoryContractStatus,
}, null, 2));

function inspectRuntimeMethods(sourceLock, glueSource) {
  const activePatchText = sourceLock.patches
    .filter((entry) => entry.cwd === ".")
    .map((entry) => readFileSync(resolve(root, entry.path), "utf8"))
    .join("\n");
  const methods = new Set();
  for (const list of activePatchText.matchAll(/-sEXPORTED_RUNTIME_METHODS=\[([^\]]+)\]/g)) {
    for (const method of list[1].matchAll(/'([^']+)'/g)) methods.add(method[1]);
  }
  if (methods.size === 0) throw new Error("Active patch series declares no runtime methods");
  const result = [...methods].sort();
  for (const method of result) {
    if (!glueSource.includes(`Module["${method}"]=${method}`)) {
      throw new Error(`Generated core does not expose runtime method ${method}`);
    }
  }
  return result;
}

function memoryContractStatus(contract) {
  const pages = [
    contract.jsGlue.initialPages,
    ...contract.wasmImports.flatMap((memory) => [memory.minimum, memory.maximum]),
    ...contract.wrapperDynamicJitPages,
    contract.activePatchSeries.initialPages,
  ];
  const consistentPages = pages.every((value) => value === pages[0]);
  const validSharedImports = contract.wasmImports.length > 0 &&
    contract.wasmImports.every(
      (memory) => memory.shared && !memory.memory64 && memory.maximum !== null
    );
  return consistentPages && validSharedImports ? "consistent" : "mismatch";
}

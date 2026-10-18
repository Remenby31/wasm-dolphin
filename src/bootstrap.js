import {
  readWebGpuSyntheticRequest,
  runWebGpuSyntheticPage
} from "./wgpu-synthetic-diagnostics.js";

const request = readWebGpuSyntheticRequest(globalThis.location?.search || "");

if (request) {
  globalThis.__wgpuSyntheticDiagnostics = {
    schema: "wasm-dolphin.wgpu-synthetic.v1",
    status: "running",
    request
  };
  const promise = runWebGpuSyntheticPage({ request });
  globalThis.__wgpuSyntheticDiagnosticsPromise = promise;
  await promise;
} else {
  // P6: the Service Worker that serves cached regions to the engine's
  // workers. Registered before the first worker starts, never awaited.
  import("./aot-cache.js").then((aot) => aot.registerAotServiceWorker()).catch(() => {});
  await import("./app.js");
}

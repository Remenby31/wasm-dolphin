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
  // workers, registered before the first worker starts, never awaited. Off
  // until something loads regions (P7): installing it during boot shifts the
  // core's boot timing, which the emulated game turns out to depend on.
  // ?aotsw=1 turns it on (harness probes).
  // Without it, a registration left by an earlier ?aotsw=1 visit is removed
  // (the module is only loaded when there is one).
  if (new URLSearchParams(globalThis.location?.search || "").get("aotsw") === "1") {
    import("./aot-cache.js").then((aot) => aot.registerAotServiceWorker()).catch(() => {});
  } else {
    globalThis.navigator?.serviceWorker?.getRegistrations?.()
      .then((registrations) => {
        const left = registrations.some((r) => /aot-sw\.js\?standalone=1/.test(r.active?.scriptURL ?? ""));
        if (left) return import("./aot-cache.js").then((aot) => aot.unregisterAotServiceWorker());
        return 0;
      })
      .catch(() => {});
  }
  await import("./app.js");
}

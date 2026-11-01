// Assembles first-launch region modules in a worker of its own. A region's
// assembly (assembleRegion: sections, function bodies, relocations, a few
// hundred KiB of bytes) took 30-60 ms of JS each on the discio worker, which
// also replays and presents: a first launch's boot screens and menus lost a
// present for that long every few hundred ms while regions were made
// (harness parcours, worker CPU profile: aot-region-module.js append, section
// and assembleRegion were the busiest frames inside every present gap).
// Here the discio worker only translates (sliced, 8 ms) and hands the
// fragments over; the bytes come back transferred.
// One file, two roles, as aot-plan-worker.js: loaded as a module Worker named
// AOT_ASSEMBLER_WORKER_NAME it serves requests; imported, it gives the client.
// ?aotasm=0 assembles on the discio worker as before.
import { assembleRegion } from "./aot-region-module.js";

export const AOT_ASSEMBLER_WORKER_NAME = "salon-aot-assembler";

export function aotAssemblerRequested(search = "") {
  return new URLSearchParams(search).get("aotasm") !== "0";
}

// The client: assemble(fragments) -> Promise<Uint8Array>, in order of the
// requests; an assembly error comes back with its message (the optimizer
// reads "different layouts" from it).
export function createAotAssemblerClient({
  options,
  createWorker = () => new Worker(new URL("./aot-assembler-worker.js", import.meta.url), { type: "module", name: AOT_ASSEMBLER_WORKER_NAME })
}) {
  let worker = null;
  let id = 0;
  const pending = new Map();
  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    worker = null;
  };
  const ensure = () => {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = (e) => {
      const p = pending.get(e.data?.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(new Uint8Array(e.data.bytes));
      else p.reject(new Error(e.data.message || "aot assembler failed"));
    };
    worker.onerror = (e) => failAll(new Error(e?.message || "aot assembler failed to load"));
    return worker;
  };
  return {
    assemble(fragments) {
      return new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        try {
          ensure().postMessage({ id: n, fragments, options });
        } catch (error) {
          pending.delete(n);
          reject(error);
        }
      });
    },
    terminate() {
      try { worker?.terminate(); } catch { /* already gone */ }
      failAll(new Error("aot assembler terminated"));
    }
  };
}

export function installAotAssemblerWorker(scope) {
  scope.onmessage = (e) => {
    const { id, fragments, options } = e.data ?? {};
    try {
      const { bytes } = assembleRegion(fragments, options);
      scope.postMessage({ id, ok: true, bytes: bytes.buffer }, [bytes.buffer]);
    } catch (error) {
      scope.postMessage({ id, ok: false, message: String(error?.message || error) });
    }
  };
}

if (
  typeof self !== "undefined" &&
  typeof self.postMessage === "function" &&
  typeof window === "undefined" &&
  self.name === AOT_ASSEMBLER_WORKER_NAME
) {
  installAotAssemblerWorker(self);
}

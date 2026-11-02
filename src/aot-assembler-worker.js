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

// The client: assemble(fragments) -> Promise<Uint8Array>.
// Two kinds of failure, kept apart:
//  - the module's own: the worker ran assembleRegion and it threw (a reply
//    { ok: false }). Rejected with its message, exactly as an assembly in
//    place would throw: the optimizer judges it as before ("different
//    layouts" waits, anything else is the module's failure).
//  - the helper's (transport): the Worker cannot be made or loads with an
//    error (404, CSP, refused, out of memory), a postMessage throws (a clone
//    error), a message cannot be read, or no reply comes within timeoutMs.
//    Never the module's fault: that request and every later one, the ones
//    in flight included, are assembled in place (assembleRegion, the old
//    path), the worker is terminated and never made again this session.
//    A region is never refused because the helper failed.
export function createAotAssemblerClient({
  options,
  createWorker = () => new Worker(new URL("./aot-assembler-worker.js", import.meta.url), { type: "module", name: AOT_ASSEMBLER_WORKER_NAME }),
  assembleInPlace = (fragments) => assembleRegion(fragments, options).bytes,
  timeoutMs = 30000,
  onHelperFailure = () => {}
}) {
  let worker = null;
  let failed = null; // the helper's failure: in place for the rest of the session
  let id = 0;
  const pending = new Map(); // id -> { fragments, resolve, reject, timer }
  const inPlace = (p) => {
    try {
      p.resolve(assembleInPlace(p.fragments));
    } catch (error) {
      p.reject(error); // the module's own error, judged as before
    }
  };
  const fail = (reason) => {
    if (failed) return;
    failed = String(reason?.message || reason || "aot assembler failed");
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) { clearTimeout(p.timer); inPlace(p); }
    try { onHelperFailure(failed); } catch { /* a listener never matters */ }
  };
  const ensure = () => {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = (e) => {
      const p = pending.get(e.data?.id);
      if (!p) return;
      pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok) p.resolve(new Uint8Array(e.data.bytes));
      else p.reject(new Error(e.data.message || "aot assembler: assembly failed"));
    };
    worker.onerror = (e) => fail(new Error(`aot assembler worker error: ${e?.message || "failed to load"}`));
    worker.onmessageerror = () => fail(new Error("aot assembler: a reply could not be read"));
    return worker;
  };
  return {
    get failed() { return failed; },
    assemble(fragments) {
      return new Promise((resolve, reject) => {
        const p = { fragments, resolve, reject, timer: null };
        if (failed) { inPlace(p); return; }
        const n = ++id;
        try {
          const w = ensure();
          pending.set(n, p);
          p.timer = setTimeout(() => fail(new Error(`aot assembler: no reply within ${timeoutMs} ms`)), timeoutMs);
          p.timer.unref?.();
          w.postMessage({ id: n, fragments, options });
        } catch (error) {
          // the constructor or postMessage (a clone error): the helper's failure
          pending.delete(n);
          clearTimeout(p.timer);
          fail(error);
          inPlace(p);
        }
      });
    },
    // The flow's end (another disc, a stop): the worker goes; requests still
    // in flight are assembled in place.
    terminate() {
      fail(new Error("aot assembler terminated"));
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

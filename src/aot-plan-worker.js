// Plans a disc in a worker of its own (P7): planDisc reads the DOL and RELs
// and runs discovery, about a second of CPU right after the boot. On the
// discio worker that second would delay the core's disc reads, so it runs
// here, one job per worker, and the worker ends with the job.
import { fileReader, planDisc } from "./aot-recomp.js";

export const AOT_PLANNER_WORKER_NAME = "salon-aot-planner";

// file: the user's disc (a File, cloned to the worker without copying its bytes).
export function planDiscInWorker(file, {
  profile = null,
  createWorker = () => new Worker(new URL("./aot-plan-worker.js", import.meta.url), { type: "module", name: AOT_PLANNER_WORKER_NAME }),
  timeoutMs = 120_000
} = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = createWorker();
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => finish(new Error("aot planner: timed out")), timeoutMs);
    timer.unref?.();
    function finish(error, plan) {
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        // already gone
      }
      if (error) reject(error);
      else resolve(plan);
    }
    worker.onmessage = (e) => (e.data?.ok ? finish(null, e.data.plan) : finish(new Error(e.data?.message || "aot planner failed")));
    worker.onerror = (e) => finish(new Error(e?.message || "aot planner failed to load"));
    worker.postMessage({ file, profile });
  });
}

export function installAotPlannerWorker(scope) {
  scope.onmessage = async (e) => {
    try {
      const plan = await planDisc(fileReader(e.data.file), { profile: e.data.profile ?? null });
      scope.postMessage({ ok: true, plan });
    } catch (error) {
      scope.postMessage({ ok: false, message: String(error?.message || error) });
    }
  };
}

if (
  typeof self !== "undefined" &&
  typeof self.postMessage === "function" &&
  typeof window === "undefined" &&
  self.name === AOT_PLANNER_WORKER_NAME
) {
  installAotPlannerWorker(self);
}

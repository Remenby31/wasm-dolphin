// Off-thread compile of JIT modules (plan piste 3, P5).
//
// One file, two roles:
//   - loaded as a module Worker named AOT_COMPILER_WORKER_NAME, it compiles
//     WASM bytes, warms every entry point once so V8's lazy Liftoff code
//     exists, and posts the WebAssembly.Module back. The Module shares its
//     compiled code with every thread it is cloned to, so the CPU thread only
//     instantiates it.
//   - imported, it gives createAotCompilerClient(), the side that owns the
//     worker, queues jobs, and kills and respawns a worker stuck in a warm-up.
//
// Warm-up never touches real memory. The worker is never given the emulator's
// Memory: every memory, table and global a module imports is a scratch object
// created here, and every imported function is a stub returning 0. A trap or a
// stub of the wrong type ends that call, which is fine: V8 compiles a function
// before its first instruction runs.

export const AOT_COMPILER_WORKER_NAME = "salon-aot-compiler";

// Off by default until its memory cost is measured on mainstream machines
// (a scratch Memory of the JIT's shape reserves 1.5 GiB of address space,
// and warmed code is retained): ?aotcompiler=1 turns it on.
export function aotCompilerRequested(search = "") {
  return new URLSearchParams(search).get("aotcompiler") === "1";
}
export const AOT_COMPILER_PROTOCOL = 1;

// Where the warm-up call points its state argument in scratch memory, and how
// much of it is zeroed before each call so every warm run starts from the same
// state (downcount 0, CTR 0, ...).
export const WARM_STATE_PTR = 0x10000;
const WARM_STATE_CLEAR_BYTES = 0x10000;
// An imported table can be the size of the core's whole function table. Only
// the first entries a module's own segments fill are worth calling.
const WARM_TABLE_SCAN_MAX = 4096;
const SCRATCH_MEMORY_SHAPES_MAX = 2;
// Scratch memories are dropped once warm-ups have been idle this long; the
// next warm-up allocates again.
const SCRATCH_IDLE_RELEASE_MS = 5000;

const PAGE = 65536;

function readU32Leb(bytes, state) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (state.pos >= bytes.length) throw new RangeError("truncated LEB128");
    const byte = bytes[state.pos++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return result >>> 0;
    shift += 7;
    if (shift > 35) throw new RangeError("LEB128 too long");
  }
}

function readName(bytes, state) {
  const len = readU32Leb(bytes, state);
  const name = new TextDecoder().decode(bytes.subarray(state.pos, state.pos + len));
  state.pos += len;
  return name;
}

function readLimits(bytes, state) {
  const flags = bytes[state.pos++];
  if (flags & 0x04) return { memory64: true };
  const initial = readU32Leb(bytes, state);
  const maximum = flags & 0x01 ? readU32Leb(bytes, state) : undefined;
  return { initial, maximum, shared: Boolean(flags & 0x02) };
}

const VALTYPES = new Map([[0x7f, "i32"], [0x7e, "i64"], [0x7d, "f32"], [0x7c, "f64"]]);

// The descriptors WebAssembly.Module.imports() leaves out: limits of memories
// and tables, value types of globals. Only the import section is read.
export function parseWasmImports(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new TypeError("not a WebAssembly binary");
  }
  const state = { pos: 8 };
  while (state.pos < bytes.length) {
    const id = bytes[state.pos++];
    const size = readU32Leb(bytes, state);
    const end = state.pos + size;
    if (id !== 2) {
      state.pos = end;
      continue;
    }
    const imports = [];
    const count = readU32Leb(bytes, state);
    for (let i = 0; i < count; i++) {
      const module = readName(bytes, state);
      const name = readName(bytes, state);
      const kind = bytes[state.pos++];
      if (kind === 0x00) {
        readU32Leb(bytes, state);
        imports.push({ module, name, kind: "function" });
      } else if (kind === 0x01) {
        const element = bytes[state.pos++];
        imports.push({ module, name, kind: "table", element, ...readLimits(bytes, state) });
      } else if (kind === 0x02) {
        imports.push({ module, name, kind: "memory", ...readLimits(bytes, state) });
      } else if (kind === 0x03) {
        const value = VALTYPES.get(bytes[state.pos++]) || "unsupported";
        const mutable = bytes[state.pos++] === 1;
        imports.push({ module, name, kind: "global", value, mutable });
      } else {
        imports.push({ module, name, kind: "unsupported" });
        return imports;
      }
    }
    return imports;
  }
  return [];
}

const stub = () => 0;

// Scratch objects outlive one module: a shared memory of the JIT's shape is
// 1.5 GiB of address space, reserved once per shape, not per block.
export function createWarmer() {
  const memories = new Map();
  const stats = { modules: 0, warmed: 0, calls: 0, traps: 0, skipped: 0, scratchFailures: 0 };

  // A shape the engine could not allocate is not tried again: those modules
  // are delivered unwarmed.
  const failedShapes = new Set();
  function scratchMemory(desc) {
    const shapeKey = `${desc.initial}:${desc.maximum ?? ""}:${desc.shared ? 1 : 0}`;
    if (failedShapes.has(shapeKey)) return null;
    let memory = memories.get(shapeKey);
    if (!memory) {
      if (memories.size >= SCRATCH_MEMORY_SHAPES_MAX) memories.delete(memories.keys().next().value);
      try {
        memory = new WebAssembly.Memory({
          initial: desc.initial,
          ...(desc.maximum !== undefined ? { maximum: desc.maximum } : {}),
          ...(desc.shared ? { shared: true } : {})
        });
      } catch {
        failedShapes.add(shapeKey);
        stats.scratchFailures += 1;
        return null;
      }
      memories.set(shapeKey, memory);
    }
    return memory;
  }

  function buildImports(imports) {
    const importObject = {};
    let memory = null;
    const tables = [];
    for (const desc of imports) {
      let value;
      if (desc.kind === "function") value = stub;
      else if (desc.kind === "memory") {
        if (desc.memory64) return null;
        value = memory = scratchMemory(desc);
        if (!value) return null;
      } else if (desc.kind === "table") {
        if (desc.memory64 || desc.element !== 0x70) return null;
        value = new WebAssembly.Table({
          element: "anyfunc",
          initial: desc.initial,
          ...(desc.maximum !== undefined ? { maximum: desc.maximum } : {})
        });
        tables.push(value);
      } else if (desc.kind === "global") {
        if (desc.value === "unsupported") return null;
        value = new WebAssembly.Global(
          { value: desc.value, mutable: desc.mutable },
          desc.value === "i64" ? 0n : 0
        );
      } else {
        return null;
      }
      (importObject[desc.module] ??= {})[desc.name] = value;
    }
    return { importObject, memory, tables };
  }

  // The core may hand over the bytes of a state that makes every entry point
  // leave at its first downcount test (downcount INT32_MIN). Without it the
  // state is zeroed, and the owner's watchdog covers a block that loops.
  let warmState = null;
  function setWarmState(next) {
    warmState = next && Number.isInteger(next.statePtr) && next.state instanceof Uint8Array
      ? { statePtr: next.statePtr, state: next.state.slice() }
      : null;
  }

  function callOnce(fn, memory) {
    const statePtr = warmState ? warmState.statePtr : WARM_STATE_PTR;
    if (memory) {
      const bytes = warmState ? warmState.state : null;
      const len = bytes ? bytes.length : WARM_STATE_CLEAR_BYTES;
      if (statePtr >= 0 && memory.buffer.byteLength >= statePtr + len) {
        const view = new Uint8Array(memory.buffer, statePtr, len);
        if (bytes) view.set(bytes);
        else view.fill(0);
      }
    }
    stats.calls += 1;
    try {
      fn(statePtr);
    } catch {
      stats.traps += 1;
    }
  }

  // Instantiate on scratch imports and call every reachable entry point once:
  // exported functions, then the entries of imported and exported tables.
  function warm(module, bytes) {
    stats.modules += 1;
    let built;
    try {
      built = buildImports(parseWasmImports(bytes));
    } catch {
      built = null;
    }
    if (!built) {
      stats.skipped += 1;
      return { warmed: false, calls: 0 };
    }
    let instance;
    try {
      instance = new WebAssembly.Instance(module, built.importObject);
    } catch {
      stats.skipped += 1;
      return { warmed: false, calls: 0 };
    }
    const callsBefore = stats.calls;
    const seen = new Set();
    const visit = (fn) => {
      if (typeof fn !== "function" || seen.has(fn)) return;
      seen.add(fn);
      callOnce(fn, built.memory);
    };
    const tables = [...built.tables];
    for (const value of Object.values(instance.exports)) {
      if (typeof value === "function") visit(value);
      else if (value instanceof WebAssembly.Table) tables.push(value);
    }
    for (const table of tables) {
      const n = Math.min(table.length, WARM_TABLE_SCAN_MAX);
      for (let i = 0; i < n; i++) {
        let fn = null;
        try {
          fn = table.get(i);
        } catch {
          fn = null;
        }
        visit(fn);
      }
    }
    stats.warmed += 1;
    return { warmed: true, calls: stats.calls - callsBefore };
  }

  return { warm, setWarmState, stats, scratchMemories: () => [...memories.values()], releaseScratch: () => memories.clear() };
}


const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export async function compileAndWarm(bytes, { warm = true } = {}, warmer = null) {
  const t0 = now();
  const module = await WebAssembly.compile(bytes);
  const t1 = now();
  let warmResult = { warmed: false, calls: 0 };
  if (warm && warmer) warmResult = warmer.warm(module, bytes);
  const t2 = now();
  return { module, compileMs: t1 - t0, warmMs: t2 - t1, ...warmResult };
}

// When the Module goes back to the owner, relative to its warm-up:
//   "after-warm"  a thread is about to call it (a deferred block, a region the
//                 CPU thread asked for): Liftoff code must exist first.
//   "before-warm" nothing calls it soon (cache loaded at boot): deliver at
//                 once and warm in the background. The code V8 compiles then
//                 lands in the same shared NativeModule.
export const DELIVER_AFTER_WARM = "after-warm";
export const DELIVER_BEFORE_WARM = "before-warm";

// Worker side. Compiles run concurrently (V8 validates on its own threads)
// and each module is answered as soon as it is ready to be delivered.
// Warm-ups run one at a time from a queue, in slices that yield to the event
// loop so compiles keep being answered; modules someone waits for (after-warm)
// go first. The id of the warm-up running is published in a SharedArrayBuffer
// so the owner can tell which job a stuck one holds without a message per job.
const WARM_SLICE_MS = 4;

export function installAotCompilerWorker(scope) {
  const warmer = createWarmer();
  let status = null; // Int32Array [warming job id]
  const urgent = [];
  const background = [];
  let pumping = false;
  let idleRelease = null;
  let flushes = [];
  let inFlight = 0;
  const totals = { warmed: 0, warmCalls: 0, warmMs: 0, maxWarmMs: 0, scratchFailures: 0, traps: 0 };

  function runWarm(job, module) {
    Atomics.store(status, 0, job.id);
    const t0 = now();
    const result = warmer.warm(module, job.bytes);
    const warmMs = now() - t0;
    Atomics.store(status, 0, 0);
    if (result.warmed) totals.warmed += 1;
    totals.warmCalls += result.calls;
    totals.warmMs += warmMs;
    totals.maxWarmMs = Math.max(totals.maxWarmMs, warmMs);
    totals.scratchFailures = warmer.stats.scratchFailures;
    totals.traps = warmer.stats.traps;
    return { ...result, warmMs };
  }

  // Replies are coalesced: thousands of cached blocks load at boot, and one
  // message per module costs more than compiling it.
  let outbox = [];
  function flushReplies() {
    const results = outbox;
    outbox = [];
    scope.postMessage({ type: "aot-compiled", results, totals: { ...totals } });
  }
  function reply(job, fields) {
    if (!outbox.length) setTimeout(flushReplies, 0);
    outbox.push({ id: job.id, ...fields });
  }

  function pump() {
    const sliceEnd = now() + WARM_SLICE_MS;
    while (urgent.length || background.length) {
      const item = urgent.length ? urgent.shift() : background.shift();
      const w = runWarm(item.job, item.module);
      if (item.replyAfter) {
        reply(item.job, { module: item.module, compileMs: item.compileMs, warmed: w.warmed, warmMs: w.warmMs, calls: w.calls });
      }
      if (now() >= sliceEnd) break;
    }
    if (urgent.length || background.length) setTimeout(pump, 0);
    else {
      pumping = false;
      clearTimeout(idleRelease);
      idleRelease = setTimeout(() => warmer.releaseScratch(), SCRATCH_IDLE_RELEASE_MS);
      answerFlushes();
    }
  }

  // Answered once nothing is compiling or waiting for its warm-up.
  function answerFlushes() {
    if (!inFlight && !pumping) scope.postMessage({ type: "aot-idle", totals: { ...totals } });
    if (inFlight || pumping || !flushes.length) return;
    if (outbox.length) flushReplies();
    for (const id of flushes) scope.postMessage({ type: "aot-flushed", id, totals: { ...totals } });
    flushes = [];
  }

  function enqueueWarm(item) {
    (item.replyAfter ? urgent : background).push(item);
    if (!pumping) {
      pumping = true;
      setTimeout(pump, 0);
    }
  }

  scope.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === "aot-init") {
      status = msg.status instanceof SharedArrayBuffer ? new Int32Array(msg.status) : null;
      return;
    }
    if (msg.type === "aot-warm-state") {
      warmer.setWarmState(msg);
      return;
    }
    if (msg.type === "aot-flush") {
      flushes.push(msg.id);
      answerFlushes();
      return;
    }
    if (msg.type !== "aot-compile") return;
    startBatch(msg.jobs);
  });
  scope.postMessage({ type: "aot-compiler-ready", protocol: AOT_COMPILER_PROTOCOL });

  // Everything a message brought that can be delivered without waiting for
  // its warm-up is answered in one reply as soon as the whole message is
  // compiled: the boot load waits on batches, so a batch's latency is what
  // counts. Modules delivered after their warm-up are answered one by one.
  function startBatch(jobs) {
    const now0 = now();
    inFlight += 1;
    const ready = [];
    Promise.all(jobs.map((job) => WebAssembly.compile(job.bytes).then((module) => {
      const compileMs = now() - now0;
      const warm = job.warm !== false && Boolean(status);
      if (!warm) {
        ready.push({ id: job.id, module, compileMs, warmed: false, warmMs: 0, calls: 0 });
      } else if (job.deliver === DELIVER_BEFORE_WARM) {
        ready.push({ id: job.id, module, compileMs, warmed: false, warmMs: 0, calls: 0, warmQueued: true });
        enqueueWarm({ job, module, compileMs, replyAfter: false });
      } else {
        enqueueWarm({ job, module, compileMs, replyAfter: true });
      }
    }, (error) => {
      ready.push({ id: job.id, error: { name: error?.name || "Error", message: String(error?.message || error) } });
    }))).then(() => {
      inFlight -= 1;
      if (ready.length) scope.postMessage({ type: "aot-compiled", results: ready, totals: { ...totals } });
      answerFlushes();
    });
  }
}

if (
  typeof self !== "undefined" &&
  typeof self.postMessage === "function" &&
  typeof window === "undefined" &&
  self.name === AOT_COMPILER_WORKER_NAME
) {
  installAotCompilerWorker(self);
}

function rebuildError(error) {
  const ctor = { CompileError: WebAssembly.CompileError, LinkError: WebAssembly.LinkError, RangeError }[error?.name];
  return ctor ? new ctor(error.message) : Object.assign(new Error(error?.message || "compile failed"), { name: error?.name || "Error" });
}

// The reason the JIT owner's pthreads act on: a compile or link error is a
// property of the bytes (blacklist), anything else is transient.
export function compileFailureReason(error) {
  if (error instanceof WebAssembly.CompileError || error?.name === "CompileError") return "compile";
  if (error instanceof WebAssembly.LinkError || error?.name === "LinkError") return "link";
  return "oom";
}

// Owner side. `createWorker` returns a fresh worker (browser Worker, or a Node
// worker_threads adapter in tests). Nothing it does can hang or fail a job
// that compiling in place would not:
//   - no worker, or one that fails to load: jobs compile in place, without
//     warm-up; the worker is tried again after `retryAfterMs`, at most
//     `maxWorkerFailures` times;
//   - a job unanswered after `jobTimeoutMs` (lost or unreadable reply) is
//     compiled in place;
//   - a warm-up stuck for `warmTimeoutMs` costs a worker restart; after
//     `maxWarmTimeouts` of them, warm-ups stop for the session.
// Without SharedArrayBuffer there is no watchdog, so no warm-up.
export function createAotCompilerClient({
  createWorker,
  warmTimeoutMs = 2000,
  jobTimeoutMs = 15000,
  maxWarmTimeouts = 5,
  maxWorkerFailures = 3,
  maxConsecutiveLost = 3,
  retryAfterMs = 30000,
  // A worker with nothing to do for this long is stopped (its isolate and
  // any scratch memory go with it); the next job starts a new one.
  idleStopMs = 30000,
  pollMs = Math.max(50, Math.floor(warmTimeoutMs / 4)),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onEvent = () => {}
} = {}) {
  const pending = new Map(); // id -> {bytes, warm, deliver, sentAt, promise, resolve, reject}
  let worker = null;
  let workerFailures = 0;
  let idleTimer = null;
  let stoppingIdle = false;
  let restartAfterIdle = false;
  let consecutiveLost = 0;
  let brokenUntil = createWorker ? 0 : Infinity;
  let workersStarted = 0;
  let nextId = 1;
  let warmState = null;
  const canWatch = typeof SharedArrayBuffer === "function" && typeof Atomics === "object";
  let status = null;
  let poll = null;
  let stuckId = 0;
  let stuckSince = 0;
  let outgoing = [];
  const flushWaiters = new Map();
  const stats = {
    jobs: 0, done: 0, failed: 0, inPlace: 0, lost: 0, messageErrors: 0, timeouts: 0, respawns: 0,
    workerFailures: 0, compileMs: 0, warmed: 0, warmCalls: 0, warmMs: 0, maxWarmMs: 0, idleStops: 0
  };
  const zero = () => ({ warmed: 0, warmCalls: 0, warmMs: 0, maxWarmMs: 0, scratchFailures: 0, traps: 0 });
  let carried = zero(); // totals of workers that are gone
  let current = zero();

  const warmAllowed = () => Boolean(status) && stats.timeouts < maxWarmTimeouts;

  function foldTotals() {
    stats.warmed = carried.warmed + current.warmed;
    stats.warmCalls = carried.warmCalls + current.warmCalls;
    stats.warmMs = carried.warmMs + current.warmMs;
    stats.maxWarmMs = Math.max(carried.maxWarmMs, current.maxWarmMs);
    stats.scratchFailures = (carried.scratchFailures || 0) + (current.scratchFailures || 0);
    stats.warmTraps = (carried.traps || 0) + (current.traps || 0);
  }

  // The watchdog runs for as long as a worker lives (background warm-ups go
  // on after every job is answered): one Atomics.load and a scan of the
  // pending jobs per poll.
  function schedulePoll() {
    if (poll !== null || !worker) return;
    poll = setTimer(onPoll, pollMs);
    poll?.unref?.();
  }

  function onPoll() {
    poll = null;
    if (!worker) return;
    const t = now();
    if (status) {
      const id = Atomics.load(status, 0);
      if (id === 0 || id !== stuckId) {
        stuckId = id;
        stuckSince = t;
      } else if (t - stuckSince >= warmTimeoutMs) {
        onStuck(id);
        return;
      }
    }
    for (const [id, job] of pending) {
      if (job.sentAt !== null && t - job.sentAt >= jobTimeoutMs) {
        stats.lost += 1;
        consecutiveLost += 1;
        onEvent({ type: "job-timeout", id });
        compileInPlace(id);
      }
    }
    // A worker that keeps losing replies is replaced (with the load-failure
    // back-off), so a boot never waits a deadline per job.
    if (consecutiveLost >= maxConsecutiveLost) {
      consecutiveLost = 0;
      onWorkerFailure();
      return;
    }
    schedulePoll();
  }

  function onStuck(id) {
    stats.timeouts += 1;
    onEvent({ type: "warm-timeout", id });
    // V8 compiled the looping function before running it; only the worker is
    // lost. The stuck job, if not delivered yet, is compiled again without
    // warm-up; every other undelivered job goes to the new worker.
    const job = pending.get(id);
    if (job) job.warm = false;
    killWorker();
    resendAll();
  }

  function resendAll() {
    for (const id of [...pending.keys()]) send(id);
  }

  function killWorker() {
    if (!worker) return;
    cancelIdleStop();
    if (stoppingIdle) restartAfterIdle = true;
    try {
      worker.terminate();
    } catch {
      // already gone
    }
    worker = null;
    status = null;
    outgoing = [];
    carried = {
      warmed: carried.warmed + current.warmed,
      warmCalls: carried.warmCalls + current.warmCalls,
      warmMs: carried.warmMs + current.warmMs,
      maxWarmMs: Math.max(carried.maxWarmMs, current.maxWarmMs),
      scratchFailures: (carried.scratchFailures || 0) + (current.scratchFailures || 0),
      traps: (carried.traps || 0) + (current.traps || 0)
    };
    current = zero();
    stuckId = 0;
    for (const resolve of flushWaiters.values()) resolve();
    flushWaiters.clear();
    if (poll !== null) clearTimer(poll);
    poll = null;
  }

  function onWorkerFailure() {
    stats.workerFailures += 1;
    workerFailures += 1;
    brokenUntil = workerFailures >= maxWorkerFailures ? Infinity : now() + retryAfterMs;
    onEvent({ type: "worker-failure", permanent: brokenUntil === Infinity });
    killWorker();
    resendAll();
  }

  function cancelIdleStop() {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  }

  function onMessage(data) {
    if (data?.type === "aot-idle") {
      current = data.totals;
      foldTotals();
      cancelIdleStop();
      if (pending.size === 0 && outgoing.length === 0 && idleStopMs > 0) {
        idleTimer = setTimer(() => {
          idleTimer = null;
          if (pending.size || outgoing.length || !worker) return;
          stats.idleStops += 1;
          stoppingIdle = true;
          killWorker();
          stoppingIdle = false;
        }, idleStopMs);
        idleTimer?.unref?.();
      }
      return;
    }
    if (data?.type === "aot-flushed") {
      current = data.totals;
      foldTotals();
      flushWaiters.get(data.id)?.();
      flushWaiters.delete(data.id);
      return;
    }
    if (!data || data.type !== "aot-compiled") return;
    if (data.totals) {
      current = data.totals;
      foldTotals();
    }
    for (const result of data.results) settle(result);
  }

  function settle(result) {
    const job = pending.get(result.id);
    if (!job) return; // answered already (in place, after a timeout)
    pending.delete(result.id);
    consecutiveLost = 0;
    if (result.error) {
      stats.failed += 1;
      job.reject(rebuildError(result.error));
      return;
    }
    stats.done += 1;
    stats.compileMs += result.compileMs || 0;
    job.resolve({
      module: result.module,
      compileMs: result.compileMs,
      warmMs: result.warmMs,
      warmed: Boolean(result.warmed),
      warmQueued: Boolean(result.warmQueued),
      offThread: true
    });
  }

  function ensureWorker() {
    if (worker) return worker;
    if (now() < brokenUntil) return null;
    let created;
    try {
      created = createWorker();
    } catch {
      onWorkerFailure();
      return null;
    }
    worker = created;
    if (workersStarted++ > 0 && !restartAfterIdle) stats.respawns += 1;
    restartAfterIdle = false;
    // Events of a worker that was replaced are ignored: its replies are
    // stale and its totals already counted.
    created.addEventListener("message", (event) => {
      if (created === worker) onMessage(event.data);
    });
    created.addEventListener("messageerror", () => {
      if (created === worker) stats.messageErrors += 1; // the job's deadline covers it
    });
    created.addEventListener("error", () => {
      if (created === worker) onWorkerFailure();
    });
    if (canWatch) {
      status = new Int32Array(new SharedArrayBuffer(4));
      created.postMessage({ type: "aot-init", status: status.buffer });
    }
    if (warmState) created.postMessage({ type: "aot-warm-state", ...warmState });
    return worker;
  }

  function compileInPlace(id) {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    stats.inPlace += 1;
    const t0 = now();
    WebAssembly.compile(job.bytes).then((module) => {
      stats.done += 1;
      job.resolve({ module, compileMs: now() - t0, warmMs: 0, warmed: false, warmQueued: false, offThread: false });
    }, (error) => {
      stats.failed += 1;
      job.reject(error);
    });
  }

  function send(id) {
    const job = pending.get(id);
    if (!job) return;
    cancelIdleStop();
    const target = ensureWorker();
    if (!target) {
      compileInPlace(id);
      return;
    }
    // Bytes are copied, never transferred: callers keep theirs for storage.
    // Jobs sent in the same turn go in one message.
    if (!outgoing.length) queueMicrotask(flushOutgoing);
    job.sentAt = now();
    outgoing.push({ id, bytes: job.bytes, warm: job.warm && warmAllowed(), deliver: job.deliver });
    schedulePoll();
  }

  function flushOutgoing() {
    const jobs = outgoing;
    outgoing = [];
    if (!jobs.length) return;
    if (!worker) {
      for (const job of jobs) send(job.id);
      return;
    }
    try {
      worker.postMessage({ type: "aot-compile", jobs });
    } catch {
      onWorkerFailure();
    }
  }

  return {
    compile(bytes, { warm = true, deliver = DELIVER_AFTER_WARM } = {}) {
      let view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      // A view of the emulator's heap (a SharedArrayBuffer) would hand the
      // worker the whole heap: copy the module's bytes out.
      if (typeof SharedArrayBuffer === "function" && view.buffer instanceof SharedArrayBuffer) view = view.slice();
      const id = nextId++;
      stats.jobs += 1;
      const job = { bytes: view, warm, deliver, sentAt: null };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      pending.set(id, job);
      send(id);
      return job.promise;
    },
    // {statePtr, state: Uint8Array}: copied at statePtr in scratch memory
    // before every warm call. Kept across worker restarts.
    setWarmState(next) {
      warmState = next && next.state instanceof Uint8Array ? { statePtr: next.statePtr, state: next.state.slice() } : null;
      if (worker && warmState) worker.postMessage({ type: "aot-warm-state", ...warmState });
    },
    // Resolves once every job sent so far is delivered and warmed (or the
    // worker was lost, which ends its warm-ups too).
    async drain() {
      while (pending.size) {
        await Promise.allSettled([...pending.values()].map((job) => job.promise));
      }
      if (!worker) return;
      const id = nextId++;
      await new Promise((resolve) => {
        flushWaiters.set(id, resolve);
        worker.postMessage({ type: "aot-flush", id });
      });
    },
    stats: () => ({ ...stats, pending: pending.size, offThread: brokenUntil !== Infinity, watchdog: canWatch, warmDisabled: !warmAllowed() && canWatch }),
    terminate() {
      killWorker();
      brokenUntil = Infinity;
      for (const [id, job] of pending) {
        pending.delete(id);
        job.reject(new Error("aot compiler terminated"));
      }
    }
  };
}

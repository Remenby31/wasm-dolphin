// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pipelines seen, compiled again before they are needed (video=wgpu).
//
// The replay creates each render pipeline the first time a draw needs it,
// with the synchronous createRenderPipeline: the GPU process compiles it
// (WGSL -> MSL / SPIR-V / HLSL+DXC) on the sequence every later WebGPU call
// of the worker waits behind. Chrome's own shader cache does not survive a
// restart on Windows (research/deep-webgpu-perf.md, 1.4), so a game pays
// those compiles again in every session, in the middle of play.
//
// This keeps, per game, the pipelines a session created (their WGSL and
// descriptor, as plain data) in OPFS. At the next boot they are compiled
// with createRenderPipelineAsync, on the GPU process's worker threads,
// while the game boots; the replay then takes the ready pipeline instead of
// compiling it. A pipeline not ready yet is still created synchronously as
// before: nothing is skipped or drawn differently, only compiled earlier.
//
// The list belongs to one core build (another core translates other WGSL:
// its list is dropped) and forgets a pipeline no session has used for
// PREWARM_IDLE_SESSIONS sessions, so it does not grow without bound.
//
// Opt out with ?wgpuprewarm=0.

export const PREWARM_FORMAT = 2;
export const PREWARM_DIR = "wgpu-pipelines";
// Bounds: a game that keeps creating pipelines must not grow the file or the
// boot compile without limit.
export const PREWARM_MAX_PIPELINES = 4096;
export const PREWARM_MAX_SHADER_BYTES = 32 << 20;
export const PREWARM_IDLE_SESSIONS = 8;
// Saved once the replay has created no new pipeline for this long (a scene
// change creates them in bursts), and when the page asks (flushUserData /
// stop: page hidden or closed).
const FLUSH_QUIET_MS = 20000;
const CONCURRENCY = 8;

export function requestedWgpuPipelinePrewarm(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuprewarm") !== "0";
}

// 53-bit FNV-1a over UTF-16 code units: a name for a WGSL text, not a
// security boundary (the text itself is stored next to it and compared).
export function wgslHash(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return ((h2 >>> 11) * 0x100000000 + (h1 >>> 0)).toString(36);
}

// The descriptor as data: everything but the modules (named by their WGSL
// hash) and the layout (named by its sampling key, see getFixedLayouts).
export function pipelineSpec(desc, { vs, fs, samplingKey }) {
  const fragment = desc.fragment ?? {};
  return {
    vs, fs, samplingKey,
    buffers: desc.vertex?.buffers ?? [],
    primitive: desc.primitive ?? {},
    depthStencil: desc.depthStencil ?? null,
    targets: fragment.targets ?? [],
    multisample: desc.multisample ?? null
  };
}

export const specKey = (spec) => JSON.stringify(spec);

export function descriptorFromSpec(spec, { vsModule, fsModule, layout, label }) {
  const desc = {
    label,
    layout,
    vertex: { module: vsModule, buffers: spec.buffers },
    fragment: { module: fsModule, targets: spec.targets },
    primitive: spec.primitive
  };
  if (spec.depthStencil) desc.depthStencil = spec.depthStencil;
  if (spec.multisample) desc.multisample = spec.multisample;
  return desc;
}

// The saved list, checked for shape only: each WGSL text is checked against
// its hash when it is compiled (prewarm), spread over the boot, not here.
// null when the file is unreadable, of another format or of another core.
export function parsePrewarmFile(text, { core = "" } = {}) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (data?.format !== PREWARM_FORMAT || typeof data.shaders !== "object" || !Array.isArray(data.pipelines)) return null;
  if (String(data.core ?? "") !== String(core)) return null;
  const session = Number.isInteger(data.session) && data.session >= 0 ? data.session : 0;
  const shaders = new Map(Object.entries(data.shaders).filter(([, wgsl]) => typeof wgsl === "string"));
  const pipelines = data.pipelines
    .filter((e) => e?.spec && shaders.has(e.spec.vs) && shaders.has(e.spec.fs) &&
      typeof e.spec.samplingKey === "string" && /^\d+\/\d+$/.test(e.spec.samplingKey) &&
      Number.isInteger(e.seen) && session - e.seen < PREWARM_IDLE_SESSIONS)
    .slice(0, PREWARM_MAX_PIPELINES);
  return { session, shaders, pipelines };
}

// Only a pipeline the device rejects as invalid leaves the list; an internal
// error or a lost device says nothing about the pipeline.
const isValidationRejection = (error) => error?.reason === "validation";

export class PipelinePrewarm {
  // root: an OPFS directory handle (navigator.storage.getDirectory()) or a
  // stand-in with the same calls; null keeps everything in memory.
  constructor({ root = null, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this.root = root;
    // Plain functions: setTimeout called as a method of this object throws
    // "Illegal invocation" in a worker.
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.gameId = "";
    this.core = "";
    this.session = 0;
    this.shaderText = new Map(); // shader id -> WGSL
    this.shaderHashes = new Map(); // shader id -> hash
    this.known = new Map(); // spec key -> { spec, seen } (this game, saved and new)
    this.texts = new Map(); // hash -> WGSL, for the specs in `known`
    this.json = new Map(); // spec key / "s:"+hash -> its JSON, serialized once
    this.ready = new Map(); // spec key -> prewarmed GPURenderPipeline
    this.built = new Set(); // spec keys the replay created itself this session
    this.stopped = false;
    this.dirty = false;
    this.flushTimer = null;
    this.stats = { loaded: 0, dropped: 0, compiled: 0, failed: 0, lateDiscarded: 0, prewarmMs: 0, hits: 0, misses: 0, recorded: 0, saved: 0, saveErrors: 0, saveMs: 0, lastError: null };
  }

  noteShader(id, wgsl) {
    this.shaderText.set(id, wgsl);
    this.shaderHashes.delete(id);
  }

  // The key of the pipeline the replay is about to create, or null when one
  // of its modules is not a recorded game shader (diagnostic variants).
  keyFor(desc, { vsId, fsId, vsModule, fsModule, samplingKey }) {
    if (desc.vertex?.module !== vsModule || desc.fragment?.module !== fsModule) return null;
    const vs = this.hashOf(vsId);
    const fs = this.hashOf(fsId);
    if (!vs || !fs) return null;
    const spec = pipelineSpec(desc, { vs, fs, samplingKey });
    return { key: specKey(spec), spec, vsId, fsId };
  }

  hashOf(id) {
    let hash = this.shaderHashes.get(id);
    if (hash === undefined) {
      const text = this.shaderText.get(id);
      if (text === undefined) return null;
      hash = wgslHash(text);
      this.shaderHashes.set(id, hash);
    }
    return hash;
  }

  // A prewarmed pipeline for this key, once (the replay caches it itself).
  // A miss means the replay builds it now: a prewarm finishing later drops
  // its copy instead of holding it all session.
  take(key) {
    const pipe = this.ready.get(key);
    this.built.add(key);
    if (pipe === undefined) { this.stats.misses += 1; return null; }
    this.ready.delete(key);
    this.stats.hits += 1;
    return pipe;
  }

  // The replay created this pipeline without error: keep it for next time,
  // or note that this session used it.
  record(entry) {
    if (!entry) return;
    const known = this.known.get(entry.key);
    if (known) {
      if (known.seen !== this.session) {
        known.seen = this.session;
        this.json.delete(entry.key);
        this.touch();
      }
      return;
    }
    if (this.known.size >= PREWARM_MAX_PIPELINES) return;
    const vsText = this.shaderText.get(entry.vsId);
    const fsText = this.shaderText.get(entry.fsId);
    if (vsText === undefined || fsText === undefined) return;
    this.known.set(entry.key, { spec: entry.spec, seen: this.session });
    this.texts.set(entry.spec.vs, vsText);
    this.texts.set(entry.spec.fs, fsText);
    this.stats.recorded += 1;
    this.touch();
  }

  // Trailing debounce: the file is written once the scene stops creating
  // pipelines, not in the middle of a burst.
  touch() {
    this.dirty = true;
    if (!this.root || !this.gameId) return;
    if (this.flushTimer) this.clearTimer(this.flushTimer);
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_QUIET_MS);
  }

  fileName() {
    return `${this.gameId.replace(/[^\w.-]/g, "_")}.json`;
  }

  async directory() {
    return this.root.getDirectoryHandle(PREWARM_DIR, { create: true });
  }

  // Each entry and each WGSL text is turned into JSON once and kept: a save
  // only joins strings, it does not stringify megabytes of WGSL again.
  serialize() {
    const piece = (key, make) => {
      let s = this.json.get(key);
      if (s === undefined) { s = make(); this.json.set(key, s); }
      return s;
    };
    const shaders = new Set();
    const shaderParts = [];
    const pipelineParts = [];
    let bytes = 0;
    for (const [key, entry] of this.known) {
      const add = [entry.spec.vs, entry.spec.fs].filter((h) => !shaders.has(h));
      const size = add.reduce((n, h) => n + this.texts.get(h).length, 0);
      if (bytes + size > PREWARM_MAX_SHADER_BYTES) continue;
      for (const h of add) {
        shaders.add(h);
        shaderParts.push(piece(`s:${h}`, () => `${JSON.stringify(h)}:${JSON.stringify(this.texts.get(h))}`));
      }
      bytes += size;
      pipelineParts.push(piece(key, () => JSON.stringify({ spec: entry.spec, seen: entry.seen })));
    }
    return `{"format":${PREWARM_FORMAT},"core":${JSON.stringify(this.core)},"gameId":${JSON.stringify(this.gameId)},` +
      `"session":${this.session},"shaders":{${shaderParts.join(",")}},"pipelines":[${pipelineParts.join(",")}]}`;
  }

  async flush() {
    if (this.flushTimer) { this.clearTimer(this.flushTimer); this.flushTimer = null; }
    if (!this.root || !this.gameId || !this.dirty) return false;
    this.dirty = false;
    try {
      const started = performance.now();
      const text = this.serialize();
      this.stats.saveMs = Math.round(performance.now() - started);
      const dir = await this.directory();
      const handle = await dir.getFileHandle(this.fileName(), { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      this.stats.saved = this.known.size;
      return true;
    } catch (error) {
      this.dirty = true;
      this.stats.saveErrors += 1;
      this.stats.lastError = String(error?.message || error);
      return false;
    }
  }

  // This game's list for this core, or nothing. Opens a new session: entries
  // unused for PREWARM_IDLE_SESSIONS sessions are not kept.
  async load(gameId, core = "") {
    this.gameId = String(gameId || "");
    this.core = String(core || "");
    if (this.dirty) this.touch();
    if (!this.root || !this.gameId) return null;
    let text;
    try {
      const dir = await this.directory();
      const handle = await dir.getFileHandle(this.fileName());
      text = await (await handle.getFile()).text();
    } catch (error) {
      if (error?.name !== "NotFoundError") this.stats.lastError = String(error?.message || error);
      return null;
    }
    const parsed = parsePrewarmFile(text, { core: this.core });
    if (!parsed) {
      // Another core or format: start over, and overwrite it at the next save.
      this.stats.lastError = "saved list belongs to another core or format";
      this.touch();
      return null;
    }
    this.session = parsed.session + 1;
    for (const { spec, seen } of parsed.pipelines) {
      this.known.set(specKey(spec), { spec, seen });
      this.texts.set(spec.vs, parsed.shaders.get(spec.vs));
      this.texts.set(spec.fs, parsed.shaders.get(spec.fs));
    }
    this.stats.loaded = parsed.pipelines.length;
    this.touch(); // the session number moved on
    return parsed;
  }

  // Compiles the loaded list off the GPU process's command sequence.
  // layoutFor(samplingKey) gives the pipeline layout the replay would use;
  // alive() says whether this run still has its device and is still current.
  async prewarm(device, layoutFor, { alive = () => true, now = () => performance.now(), concurrency = CONCURRENCY } = {}) {
    if (typeof device?.createRenderPipelineAsync !== "function") return this.stats;
    const started = now();
    const modules = new Map();
    const moduleOf = (hash) => {
      let module = modules.get(hash);
      if (module === undefined) {
        const text = this.texts.get(hash);
        // A text edited on disk no longer matches its name: not compiled.
        module = wgslHash(text) === hash ? device.createShaderModule({ label: `prewarm-${hash}`, code: text }) : null;
        modules.set(hash, module);
      }
      return module;
    };
    const drop = (key) => {
      this.known.delete(key);
      this.json.delete(key);
      this.dirty = true;
    };
    const queue = [...this.known.entries()].map(([key, entry]) => [key, entry.spec]);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (this.stopped || !alive()) return;
        const [key, spec] = next;
        if (this.built.has(key)) continue; // the replay was faster
        const vsModule = moduleOf(spec.vs);
        const fsModule = moduleOf(spec.fs);
        if (!vsModule || !fsModule) { drop(key); this.stats.dropped += 1; continue; }
        try {
          const desc = descriptorFromSpec(spec, { vsModule, fsModule, layout: layoutFor(spec.samplingKey), label: "dolphin-prewarm" });
          const pipe = await device.createRenderPipelineAsync(desc);
          if (this.stopped || !alive()) return;
          if (this.built.has(key)) { this.stats.lateDiscarded += 1; continue; }
          this.ready.set(key, pipe);
          this.stats.compiled += 1;
        } catch (error) {
          this.stats.failed += 1;
          this.stats.lastError = String(error?.message || error);
          if (!alive()) return;
          // The device rejects this pipeline (another adapter, a stale
          // descriptor): it leaves the list. Anything else keeps it.
          if (isValidationRejection(error)) drop(key);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    this.stats.prewarmMs = Math.round(now() - started);
    if (this.dirty) this.touch();
    return this.stats;
  }

  // Core reload, device lost, page closing: nothing is compiled any more and
  // the pipelines not taken are let go.
  stop() {
    this.stopped = true;
    this.ready.clear();
  }

  snapshot() {
    return { gameId: this.gameId, session: this.session, known: this.known.size, ready: this.ready.size, ...this.stats };
  }
}

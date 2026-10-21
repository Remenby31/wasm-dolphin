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
// Opt out with ?wgpuprewarm=0.

export const PREWARM_FORMAT = 1;
export const PREWARM_DIR = "wgpu-pipelines";
// Bounds: a game that keeps creating pipelines must not grow the file or the
// boot compile without limit.
export const PREWARM_MAX_PIPELINES = 4096;
export const PREWARM_MAX_SHADER_BYTES = 32 << 20;
const FLUSH_DELAY_MS = 5000;
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

// The saved list, checked: anything malformed is dropped, not compiled.
export function parsePrewarmFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (data?.format !== PREWARM_FORMAT || typeof data.shaders !== "object" || !Array.isArray(data.pipelines)) return null;
  const shaders = new Map();
  for (const [hash, wgsl] of Object.entries(data.shaders)) {
    if (typeof wgsl === "string" && wgslHash(wgsl) === hash) shaders.set(hash, wgsl);
  }
  const pipelines = data.pipelines
    .filter((p) => p && shaders.has(p.vs) && shaders.has(p.fs) && typeof p.samplingKey === "string" && /^\d+\/\d+$/.test(p.samplingKey))
    .slice(0, PREWARM_MAX_PIPELINES);
  return { shaders, pipelines };
}

export class PipelinePrewarm {
  // root: an OPFS directory handle (navigator.storage.getDirectory()) or a
  // stand-in with the same calls; null keeps everything in memory.
  constructor({ root = null, setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
    this.root = root;
    // A plain function: setTimeout called as a method of this object throws
    // "Illegal invocation" in a worker.
    this.setTimer = setTimer;
    this.gameId = "";
    this.shaderText = new Map(); // shader id -> WGSL
    this.shaderHashes = new Map(); // shader id -> hash
    this.known = new Map(); // spec key -> spec (this game, saved and new)
    this.texts = new Map(); // hash -> WGSL, for the specs in `known`
    this.ready = new Map(); // spec key -> prewarmed GPURenderPipeline
    this.dirty = false;
    this.flushTimer = null;
    this.stats = { loaded: 0, compiled: 0, failed: 0, prewarmMs: 0, hits: 0, misses: 0, recorded: 0, saved: 0, saveErrors: 0, lastError: null };
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
  take(key) {
    const pipe = this.ready.get(key);
    if (pipe === undefined) { this.stats.misses += 1; return null; }
    this.ready.delete(key);
    this.stats.hits += 1;
    return pipe;
  }

  // The replay created this pipeline without error: keep it for next time.
  record(entry) {
    if (!entry || this.known.has(entry.key) || this.known.size >= PREWARM_MAX_PIPELINES) return;
    const vsText = this.shaderText.get(entry.vsId);
    const fsText = this.shaderText.get(entry.fsId);
    if (vsText === undefined || fsText === undefined) return;
    this.known.set(entry.key, entry.spec);
    this.texts.set(entry.spec.vs, vsText);
    this.texts.set(entry.spec.fs, fsText);
    this.stats.recorded += 1;
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (!this.root || !this.gameId || this.flushTimer) return;
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  fileName() {
    return `${this.gameId.replace(/[^\w.-]/g, "_")}.json`;
  }

  async directory() {
    return this.root.getDirectoryHandle(PREWARM_DIR, { create: true });
  }

  serialize() {
    const shaders = {};
    let bytes = 0;
    const pipelines = [];
    for (const spec of this.known.values()) {
      const add = [spec.vs, spec.fs].filter((h) => !(h in shaders));
      const size = add.reduce((n, h) => n + this.texts.get(h).length, 0);
      if (bytes + size > PREWARM_MAX_SHADER_BYTES) continue;
      for (const h of add) shaders[h] = this.texts.get(h);
      bytes += size;
      pipelines.push(spec);
    }
    return JSON.stringify({ format: PREWARM_FORMAT, gameId: this.gameId, shaders, pipelines });
  }

  async flush() {
    if (!this.root || !this.gameId || !this.dirty) return false;
    this.dirty = false;
    try {
      const dir = await this.directory();
      const handle = await dir.getFileHandle(this.fileName(), { create: true });
      const writable = await handle.createWritable();
      await writable.write(this.serialize());
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

  // The saved list for this game, or nothing.
  async load(gameId) {
    this.gameId = String(gameId || "");
    if (this.dirty) this.scheduleFlush();
    if (!this.root || !this.gameId) return null;
    try {
      const dir = await this.directory();
      const handle = await dir.getFileHandle(this.fileName());
      const parsed = parsePrewarmFile(await (await handle.getFile()).text());
      if (!parsed) return null;
      for (const spec of parsed.pipelines) {
        this.known.set(specKey(spec), spec);
        this.texts.set(spec.vs, parsed.shaders.get(spec.vs));
        this.texts.set(spec.fs, parsed.shaders.get(spec.fs));
      }
      this.stats.loaded = parsed.pipelines.length;
      return parsed;
    } catch (error) {
      if (error?.name !== "NotFoundError") this.stats.lastError = String(error?.message || error);
      return null;
    }
  }

  // Compiles the loaded list off the GPU process's command sequence.
  // layoutFor(samplingKey) gives the pipeline layout the replay would use.
  async prewarm(device, layoutFor, { now = () => performance.now(), concurrency = CONCURRENCY } = {}) {
    if (typeof device?.createRenderPipelineAsync !== "function") return this.stats;
    const started = now();
    const modules = new Map();
    const moduleOf = (hash) => {
      let module = modules.get(hash);
      if (!module) {
        module = device.createShaderModule({ label: `prewarm-${hash}`, code: this.texts.get(hash) });
        modules.set(hash, module);
      }
      return module;
    };
    const queue = [...this.known.entries()];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [key, spec] = next;
        try {
          const desc = descriptorFromSpec(spec, {
            vsModule: moduleOf(spec.vs), fsModule: moduleOf(spec.fs),
            layout: layoutFor(spec.samplingKey), label: "dolphin-prewarm"
          });
          this.ready.set(key, await device.createRenderPipelineAsync(desc));
          this.stats.compiled += 1;
        } catch (error) {
          // A pipeline that no longer builds (another core, another
          // adapter) is dropped from the list at the next save.
          this.known.delete(key);
          this.dirty = true;
          this.stats.failed += 1;
          this.stats.lastError = String(error?.message || error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    this.stats.prewarmMs = Math.round(now() - started);
    if (this.dirty) this.scheduleFlush();
    return this.stats;
  }

  snapshot() {
    return { gameId: this.gameId, known: this.known.size, ready: this.ready.size, ...this.stats };
  }
}

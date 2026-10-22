// The replay side of the pipeline prewarm: the worker's real resolvePipeline
// and getFixedLayouts, run against a fake device.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { PipelinePrewarm } from "../src/wgpu-pipeline-prewarm.js";

const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
function between(startMarker, endMarker) {
  const start = worker.indexOf(startMarker);
  const end = worker.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, startMarker);
  return worker.slice(start, end);
}
const layoutsFunction = between("function getFixedLayouts(", "\nfunction ");
const pipelineFunction = between("function resolvePipeline(", "// Day-28: build a real GPUShaderModule");

const VS = "@vertex fn main() -> @builtin(position) vec4f { return vec4f(); }";
const FS = "@fragment fn main() -> @location(0) vec4f { return vec4f(1); }";

function harness({ scopeError = null } = {}) {
  const created = [];
  const device = {
    createBindGroupLayout: (d) => ({ d }), createPipelineLayout: (d) => ({ d }),
    createTexture: (d) => ({ ...d, createView: () => ({}) }), createSampler: (d) => ({ d }), createBuffer: (d) => ({ d }),
    createRenderPipeline(d) { const p = { d }; created.push(p); return p; },
    pushErrorScope() {}, async popErrorScope() { return scopeError; }
  };
  const objects = { shaders: new Map(), pipeTpl: new Map(), pipeVar: new Map() };
  const vsModule = { stage: "vs" }, fsModule = { stage: "fs" };
  objects.shaders.set(1, vsModule);
  objects.shaders.set(2, fsModule);
  const prewarm = new PipelinePrewarm({ setTimer: () => 1, clearTimer() {} });
  prewarm.noteShader(1, VS);
  prewarm.noteShader(2, FS);
  const context = vm.createContext({
    renderGpu: { device }, webGpuObjects: objects, pipelinePrewarm: prewarm,
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 }, GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2 }, GPUBufferUsage: { UNIFORM: 64, STORAGE: 128, COPY_DST: 8 },
    self: {}, console: { log() {} }, REVZ_COMPARE_FLIP: false, REVZ_COMPARE_FLIP_ALL: false, DIAG_DEPTH_ALWAYS: false,
    DIAG_DUMMY_TINT: false, DIAG_DEPTH_TRACE: false, vpDiagDone: true,
    vpDiagFinalCmp: new Map(), vpDiagPipeFinalDs: new Map(), webGpuPcfg: { ok: 0, fail: 0 },
    recordRendererError: () => {}
  });
  vm.runInContext(`${layoutsFunction}\n${pipelineFunction}`, context);
  const template = (vertexModule = vsModule) => ({
    desc: { vertex: { module: vertexModule, buffers: [] }, fragment: { module: fsModule },
      primitive: { topology: "triangle-list", frontFace: "cw", cullMode: "back" }, multisample: { count: 1 } },
    target: { format: "rgba8unorm", writeMask: 15 }, depthBase: null, vsId: 1, fsId: 2
  });
  return { context, created, objects, prewarm, template };
}
const settle = () => new Promise((r) => setImmediate(r));

test("the replay takes a prewarmed pipeline instead of compiling it, with the same layout", async () => {
  const h = harness();
  h.objects.pipeTpl.set(7, h.template());
  // What the prewarm would have built for this pipeline and sampling key.
  const first = h.context.resolvePipeline(7, "rgba8unorm", null, null, false, "1/1");
  assert.equal(h.created.length, 1, "first session: compiled synchronously");
  await settle();
  assert.equal(h.prewarm.known.size, 1, "recorded after a clean error scope");
  const [[key, entry]] = h.prewarm.known;
  assert.equal(entry.spec.samplingKey, "1/1");
  assert.equal(first.d.layout, h.context.getFixedLayouts(1, 1).pipelineLayout);

  const next = harness();
  next.objects.pipeTpl.set(7, next.template());
  const prewarmed = { prewarmed: true };
  next.prewarm.ready.set(key, prewarmed);
  const pipe = next.context.resolvePipeline(7, "rgba8unorm", null, null, false, "1/1");
  assert.equal(pipe, prewarmed);
  assert.equal(next.created.length, 0, "nothing compiled on the replay's sequence");
  assert.equal(next.prewarm.stats.hits, 1);
  assert.equal(next.context.resolvePipeline(7, "rgba8unorm", null, null, false, "1/1"), prewarmed, "then cached by the replay");
});

test("a pipeline the device rejects is not recorded", async () => {
  const h = harness({ scopeError: { message: "invalid" } });
  h.objects.pipeTpl.set(7, h.template());
  h.context.resolvePipeline(7, "rgba8unorm", null, null, false, "0/0");
  await settle();
  assert.equal(h.prewarm.known.size, 0);
});

test("a diagnostic module replacing the game's shader is neither taken nor recorded", async () => {
  const h = harness();
  h.objects.pipeTpl.set(7, h.template({ stage: "trivial-vs" }));
  h.context.resolvePipeline(7, "rgba8unorm", null, null, false, "0/0");
  await settle();
  assert.equal(h.created.length, 1);
  assert.equal(h.prewarm.known.size, 0);
  assert.equal(h.prewarm.stats.misses, 0);
});

test("?wgpuprewarm=0 travels page -> adapter -> worker load message", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  for (const [option, expected] of [[undefined, true], [false, false]]) {
    const adapter = new UpstreamWorkerAdapter({ wgpuPipelinePrewarm: option });
    assert.equal(adapter.wgpuPipelinePrewarm, expected);
  }
  // The worker's load handler copies the field into loadCore's options.
  assert.match(between('case "load":', "case \"mountFile\""), /wgpuPipelinePrewarm: payload\.wgpuPipelinePrewarm,/);
});

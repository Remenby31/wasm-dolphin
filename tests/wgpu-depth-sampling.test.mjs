// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
function between(startMarker, endMarker) {
  const start = worker.indexOf(startMarker);
  const end = worker.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, startMarker);
  return worker.slice(start, end);
}
const bindingFunctions = between("const FILTERABLE_TEX_FORMATS", "// Day-33 grind: GPU texture-to-texture blit");
const pipelineFunction = between("function resolvePipeline(", "// Day-28: build a real GPUShaderModule");
const stateCases = between("case WGPU_CMD_OP_SET_PIPELINE: {", "case WGPU_CMD_OP_SET_VERTEX_BUFFER: {");

function harness() {
  const errors = [];
  const createdPipelines = [];
  const events = [];
  const objects = Object.fromEntries([
    "textures", "samplers", "samplerDescriptors", "nearestSamplers", "bindGroups",
    "bindGroupSamplingMasks", "buffers", "pipeTpl", "pipeVar"
  ].map((name) => [name, new Map()]));
  const device = {
    createBindGroupLayout(descriptor) { return { descriptor }; },
    createPipelineLayout(descriptor) { return { descriptor }; },
    createTexture(descriptor) {
      return { ...descriptor, createView(viewDescriptor) { return { descriptor: viewDescriptor, texture: this }; } };
    },
    createSampler(descriptor) { return { descriptor }; },
    createBindGroup(descriptor) { return { descriptor }; },
    createRenderPipeline(descriptor) {
      const pipeline = { descriptor };
      createdPipelines.push(pipeline);
      return pipeline;
    },
    pushErrorScope() {},
    async popErrorScope() { return null; },
  };
  const context = vm.createContext({
    renderGpu: { device }, webGpuObjects: objects,
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
    GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2 },
    moduleInstance: { HEAPU8: new Uint8Array(4096) },
    self: { _wgBg1N: 100 }, console: { log() {} },
    wgpuReplayClassifier: null, noteMissingResource() {},
    // main gates the viewport dump with vpDiagDone (true == finished/off),
    // where this work originally used a vpDiagEnabled flag.
    vpDiagDone: true,
    vpDiagBgTexByBinding: new Map(), vpDiagFinalCmp: new Map(),
    REVZ_COMPARE_FLIP: false, REVZ_COMPARE_FLIP_ALL: false,
    webGpuPcfg: { ok: 0, fail: 0 }, dropSampler: null, recordRendererError: (...args) => errors.push(args),
    wgpuConsumerStateCacheEnabled: false, pipelinePrewarm: null,
    webGpuExecStats: { setPipe: 0, missPipe: 0, setBg: 0, missBg: 0 },
    frameCapPush() {}, frameCapActive: () => false, WGPU_DYN_OFF_SCRATCH: new Uint32Array(4),
    WGPU_CMD_OP_SET_PIPELINE: 11, WGPU_CMD_OP_SET_BIND_GROUP: 12,
    pass: {
      setPipeline(pipeline) { events.push(["pipeline", pipeline]); },
      setBindGroup(slot, group) { events.push(["bind", slot, group]); },
    },
  });
  vm.runInContext(`${bindingFunctions}\n${pipelineFunction}`, context);
  function texture(id, format) {
    const tex = { width: 2, height: 2,
      createView(descriptor) { return { texture: this, descriptor }; } };
    const record = { tex, format };
    objects.textures.set(id, record);
    return record;
  }
  function sampler(id, descriptor) {
    const sampler = device.createSampler(descriptor);
    objects.samplers.set(id, sampler);
    objects.samplerDescriptors.set(id, descriptor);
    return sampler;
  }
  function group(id, entries) {
    new Uint32Array(context.moduleInstance.HEAPU8.buffer, 4).set([
      0x57424731, 1, entries.length,
      ...entries.flatMap(([binding, kind, resourceId]) => [binding, kind, resourceId, 0, 0])
    ]);
    context.replayCreateBindGroup(id, 4, (3 + entries.length * 5) * 4);
    assert.deepEqual(errors, []);
    return objects.bindGroups.get(id);
  }
  function run(commands) {
    context.commands = commands.map((command) => new Uint32Array(command));
    return vm.runInContext(`(() => {
      let passHasPipe = false, passNeedsVertexBuffer = false;
      let passSamplingKey = "0/0";
      const passColorFmt = "rgba8unorm", passDepthFmt = null, passFbId = 77;
      const bgValid = [false, false, false];
      const drawState = null, pd = { pipeOk: 0, pipeMiss: 0, bgOk: 0, bgMiss: 0 };
      for (const u32 of commands) {
        const recWord = 0, read = 0;
        switch (u32[0]) { ${stateCases} }
      }
      return { passHasPipe, passSamplingKey };
    })()`, context);
  }
  return { context, objects, device, errors, events, createdPipelines, texture, sampler, group, run };
}

function entry(group, binding) {
  return group.descriptor.entries.find((item) => item.binding === binding);
}
function layoutEntry(group, binding) {
  return group.descriptor.layout.descriptor.entries.find((item) => item.binding === binding);
}

for (const format of ["depth32float", "depth24plus", "depth24plus-stencil8", "r32float"]) {
  test(`${format} binds actual full-precision texture while preserving linear color sampling`, () => {
    const h = harness();
    const color = h.texture(1, "rgba8unorm");
    const depth = h.texture(2, format);
    const linear = h.sampler(3, { minFilter: "linear", magFilter: "linear" });
    const nearest = h.sampler(4, { addressModeU: "clamp-to-edge" });
    const group = h.group(10, [[0, 1, 1], [1, 1, 2], [8, 2, 3], [9, 2, 4]]);
    assert.equal(entry(group, 0).resource.texture, color.tex);
    assert.equal(entry(group, 1).resource.texture, depth.tex);
    assert.equal(entry(group, 1).resource.descriptor.aspect, format.startsWith("depth") ? "depth-only" : "all");
    assert.equal(layoutEntry(group, 0).texture.sampleType, "float");
    assert.equal(layoutEntry(group, 1).texture.sampleType, "unfilterable-float");
    assert.equal(layoutEntry(group, 8).sampler.type, "filtering");
    assert.equal(layoutEntry(group, 9).sampler.type, "non-filtering");
    assert.equal(entry(group, 8).resource, linear);
    assert.equal(entry(group, 9).resource, nearest);
    assert.equal(h.objects.bindGroupSamplingMasks.get(10), "2/2");
    assert.equal(h.context.self._wgDummyFormat || 0, 0);
  });
}

test("nearest compatibility samplers preserve wrapping and LOD and are cached", () => {
  const h = harness();
  h.texture(1, "r32float");
  const descriptor = { minFilter: "linear", magFilter: "linear", mipmapFilter: "linear",
    maxAnisotropy: 4, addressModeU: "mirror-repeat", addressModeV: "repeat", lodMinClamp: 2, lodMaxClamp: 5 };
  const original = h.sampler(3, descriptor);
  const group = h.group(10, [[0, 1, 1], [8, 2, 3]]);
  const next = h.group(11, [[0, 1, 1], [8, 2, 3]]);
  const nearest = entry(group, 8).resource;
  assert.notEqual(nearest, original);
  assert.equal(nearest, entry(next, 8).resource);
  assert.deepEqual(JSON.parse(JSON.stringify(nearest.descriptor)), { ...descriptor,
    minFilter: "nearest", magFilter: "nearest", mipmapFilter: "nearest", maxAnisotropy: 1 });
  assert.equal(original.descriptor.minFilter, "linear");
});

test("legacy shared sampler becomes compatible even when only another texture slot contains depth", () => {
  const h = harness();
  h.texture(1, "depth32float");
  h.sampler(3, { minFilter: "linear", addressModeU: "repeat" });
  const group = h.group(10, [[5, 1, 1], [8, 2, 3]]);
  assert.equal(h.objects.bindGroupSamplingMasks.get(10), "32/33");
  assert.equal(layoutEntry(group, 8).sampler.type, "non-filtering");
  assert.equal(entry(group, 8).resource.descriptor.minFilter, "nearest");
  assert.equal(entry(group, 8).resource.descriptor.addressModeU, "repeat");
});

test("missing and integer textures remain valid placeholders and layouts share uniform/storage groups", () => {
  const h = harness();
  h.texture(1, "r16uint");
  const group = h.group(10, [[0, 1, 1], [1, 1, 99]]);
  const base = h.context.getFixedLayouts();
  const depth = h.context.getFixedLayouts(2, 2);
  assert.equal(entry(group, 0).resource, base.dummyTexView);
  assert.equal(entry(group, 1).resource, base.dummyTexView);
  assert.equal(depth.l0, base.l0);
  assert.equal(depth.l2, base.l2);
  assert.equal(depth, h.context.getFixedLayouts(2, 2));
  assert.notEqual(depth.l1, base.l1);
  assert.equal(h.objects.bindGroupSamplingMasks.get(10), "0/0");
});

test("pipeline-before-textures and repeated texture changes refresh matching pipeline variants", () => {
  const h = harness();
  h.texture(1, "rgba8unorm");
  h.texture(2, "depth32float");
  h.sampler(3, {});
  h.group(10, [[0, 1, 1], [8, 2, 3]]);
  h.group(11, [[0, 1, 2], [8, 2, 3]]);
  h.objects.pipeTpl.set(7, { desc: { vertex: { buffers: [] }, fragment: { module: {} } },
    target: { format: "rgba8unorm" }, depthBase: null });
  const result = h.run([[11, 7], [12, 1, 11, 0], [12, 1, 10, 0], [12, 1, 11, 0], [11, 7]]);
  const applied = h.events.filter((event) => event[0] === "pipeline").map((event) => event[1]);
  assert.equal(applied.length, 5);
  assert.equal(applied[0], applied[2], "returning to color reuses its variant");
  assert.equal(applied[1], applied[3], "returning to depth reuses its variant");
  assert.equal(applied[3], applied[4], "later SET_PIPELINE honors the current depth bindings");
  assert.notEqual(applied[0], applied[1]);
  assert.equal(h.createdPipelines.length, 2);
  assert.equal(applied[1].descriptor.layout, h.context.getFixedLayouts(1, 1).pipelineLayout);
  assert.equal(result.passSamplingKey, "1/1");
  assert.equal(result.passHasPipe, true);
  assert.deepEqual(h.errors, []);
});

test("destroying a bind group releases its sampling layout metadata", () => {
  const h = harness();
  const group = h.group(10, []);
  h.group(11, []);
  vm.runInContext(`(() => {
    const WGPU_CMD_OP_DESTROY = 24, u32 = new Uint32Array([24,3,10]), recWord = 0;
    const pendingWgpuUploadSnapshot = () => ({pendingUploads:0});
    const wgpuMappedDrainCoalescingEnabled = false;
    switch (24) { ${between("case WGPU_CMD_OP_DESTROY: {", "case WGPU_CMD_OP_BLIT_TEXTURE: {")} }
  })()`, h.context);
  assert.ok(group);
  assert.equal(h.objects.bindGroups.has(10), false);
  assert.equal(h.objects.bindGroupSamplingMasks.has(10), false);
  assert.equal(h.objects.bindGroups.has(11), true);
  assert.equal(h.objects.bindGroupSamplingMasks.has(11), true);
});

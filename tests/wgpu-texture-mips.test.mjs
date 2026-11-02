// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const worker = await readFile(
  new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"
);

function sourceBetween(startMarker, endMarker) {
  const start = worker.indexOf(startMarker);
  const end = worker.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `worker seam: ${startMarker}`);
  return worker.slice(start, end);
}

function texture(width, height, mipLevelCount = 1, depthOrArrayLayers = 1) {
  return {
    width, height, mipLevelCount, depthOrArrayLayers, views: [],
    createView(descriptor = {}) {
      // Resolve WebGPU's omitted view ranges so callers can assert the
      // visible resource range, including views which use API defaults.
      const view = {
        descriptor: { ...descriptor },
        baseMipLevel: descriptor.baseMipLevel ?? 0,
        mipLevelCount: descriptor.mipLevelCount ??
          this.mipLevelCount - (descriptor.baseMipLevel ?? 0),
        baseArrayLayer: descriptor.baseArrayLayer ?? 0,
        arrayLayerCount: descriptor.arrayLayerCount ??
          this.depthOrArrayLayers - (descriptor.baseArrayLayer ?? 0),
      };
      this.views.push(view);
      return view;
    },
  };
}

function createTextureRecord({ levels, layers = 1, width = 64, height = 32 }) {
  const records = new Map();
  const descriptors = [];
  // A nonzero record offset catches absolute word indexing mistakes.
  const recWord = 8;
  const u32 = new Uint32Array(24);
  u32.set([7, 42, width, height, 1, 0x16, layers, levels], recWord);
  const device = {
    createTexture(descriptor) {
      descriptors.push(descriptor);
      return texture(...descriptor.size.slice(0, 2),
        descriptor.mipLevelCount ?? 1, descriptor.size[2]);
    },
  };
  const replay = vm.runInNewContext(
    `(function () { switch (7) {
      ${sourceBetween("case WGPU_CMD_OP_CREATE_TEXTURE: {", "case WGPU_CMD_OP_UPLOAD_TEXTURE: {")}
    } })`,
    {
      u32, recWord, dev: device, webGpuObjects: { textures: records },
      WGPU_CMD_OP_CREATE_TEXTURE: 7, WGPU_TEX_FORMAT: { 1: "rgba8unorm" },
      harnessEnabled: false,
      wgpuStalePresent: { created() {}, wrote() {} },
    }
  );
  replay();
  return { record: records.get(42), descriptor: descriptors[0], descriptors, replay };
}

test("texture creation uses command word 7 for mip levels and preserves array layers", () => {
  const { record, descriptor, descriptors, replay } = createTextureRecord({ levels: 5, layers: 3 });
  assert.equal(descriptor.mipLevelCount, 5);
  assert.deepEqual(Array.from(descriptor.size), [64, 32, 3]);
  assert.equal(record.tex.mipLevelCount, 5);
  assert.equal(record.layers, 3);
  replay();
  assert.equal(descriptors.length, 1, "replayed creation keeps the existing texture");
});

test("legacy zero mip levels and array layers still create a one-level texture", () => {
  const { record, descriptor } = createTextureRecord({ levels: 0, layers: 0 });
  assert.equal(descriptor.mipLevelCount ?? 1, 1);
  assert.equal(record.tex.mipLevelCount, 1);
  assert.equal(record.layers, 1);
});

test("sampled bind groups expose every mip and array layer of the created texture", () => {
  const tex = texture(64, 32, 5, 3);
  const bindGroups = new Map();
  const objects = {
    textures: new Map([[42, { tex, format: "rgba8unorm", layers: 3, view2dArray: null }]]),
    bindGroups, samplers: new Map(), buffers: new Map(),
  };
  const heap = new Uint32Array(16);
  const blobPtr = 4;
  heap.set([0x57424731, 1, 1, 0, 1, 42, 0, 0], blobPtr / 4);
  const replay = vm.runInNewContext(
    `(${sourceBetween("function replayCreateBindGroup(", "// Day-33 grind:").trim()})`,
    {
      renderGpu: { device: { createBindGroup: (descriptor) => descriptor } },
      webGpuObjects: objects, moduleInstance: { HEAPU8: new Uint8Array(heap.buffer) },
      getFixedLayouts: () => ({ l1: {}, dummyTexView: {}, dummySampler: {} }),
      FILTERABLE_TEX_FORMATS: new Set(["rgba8unorm"]),
      // Depth and R32F bindings now use matching unfilterable layouts rather
      // than being swapped for the dummy texture.
      UNFILTERABLE_TEX_FORMATS: new Set(["r32float", "depth24plus", "depth32float", "depth24plus-stencil8"]),
      // The viewport dump is gated off by default; bind-group replay only
      // consults it for diagnostics.
      vpDiagDone: true,
      wgpuReplayClassifier: null, vpDiagBgTexByBinding: new Map(),
      self: {}, console: { log() {} },
    }
  );
  replay(100, blobPtr, 8 * 4);
  const view = bindGroups.get(100).entries.find(({ binding }) => binding === 0).resource;
  assert.equal(view.descriptor.dimension, "2d-array");
  assert.equal(view.baseMipLevel, 0);
  assert.equal(view.mipLevelCount, 5);
  assert.equal(view.baseArrayLayer, 0);
  assert.equal(view.arrayLayerCount, 3);
  replay(101, blobPtr, 8 * 4);
  assert.equal(tex.views.length, 1, "sampled views are reused across bind groups");
});

test("framebuffer color and depth attachments select only the base mip and one layer", () => {
  const passSource = sourceBetween("colorView = ct.tex.createView(", "desc.depthStencilAttachment = ds;");
  for (const name of ["ct", "dt"]) {
    const call = passSource.match(new RegExp(`${name}\\.tex\\.createView\\([\\s\\S]*?\\)`));
    assert.ok(call, `framebuffer ${name} view call exists`);
    const tex = texture(64, 32, 5, 3);
    const view = vm.runInNewContext(call[0], { [name]: { tex } });
    assert.equal(view.baseMipLevel, 0, name);
    assert.equal(view.mipLevelCount, 1, name);
    assert.equal(view.baseArrayLayer, 0, name);
    assert.equal(view.arrayLayerCount, 1, name);
  }
});

function blitHarness() {
  const buffers = [], copies = [], passes = [], groups = [];
  const encoder = {
    copyTextureToTexture(...args) { copies.push(args); },
    beginRenderPass(descriptor) {
      const pass = {
        descriptor,
        setPipeline() {}, setBindGroup() {},
        setViewport(...args) { this.viewport = args; },
        draw(count) { this.vertices = count; },
        end() { this.ended = true; },
      };
      passes.push(pass);
      return pass;
    },
  };
  const device = {
    createBuffer(descriptor) {
      const bytes = new ArrayBuffer(descriptor.size);
      const buffer = { bytes, getMappedRange: () => bytes, unmap() {} };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup(descriptor) { groups.push(descriptor); return descriptor; },
  };
  const blit = vm.runInNewContext(
    `(${sourceBetween("function blitTexture(", "// DIAGNOSTIC (revertible):").trim()})`,
    {
      renderGpu: { device }, ensureBlitPipeline: () => ({}),
      blitState: { bgl: {}, sampler: {} }, self: {}, console: { log() {} },
    }
  );
  return { blit: (...args) => blit(encoder, ...args), buffers, copies, passes, groups };
}

test("sampled blits normalize source rectangles against the selected mip dimensions", () => {
  const h = blitHarness();
  const s = { tex: texture(64, 32, 7, 3), format: "rgba8unorm" };
  const d = { tex: texture(64, 64, 7, 4), format: "bgra8unorm" };
  h.blit(s, d, 4, 2, 8, 4, 3, 5, 12, 8, 2, 2, 3, 1);
  assert.deepEqual(Array.from(new Float32Array(h.buffers[0].bytes)), [0.5, 0.5, 0.25, 0.25]);
  assert.deepEqual(s.tex.views[0].descriptor, {
    dimension: "2d-array", baseArrayLayer: 2, arrayLayerCount: 1,
    baseMipLevel: 2, mipLevelCount: 1,
  });
  assert.deepEqual(d.tex.views[0].descriptor, {
    dimension: "2d", baseArrayLayer: 3, arrayLayerCount: 1,
    baseMipLevel: 1, mipLevelCount: 1,
  });
  assert.equal(h.groups[0].entries[0].resource, s.tex.views[0]);
  assert.equal(h.passes[0].descriptor.colorAttachments[0].view, d.tex.views[0]);
  assert.deepEqual(h.passes[0].viewport, [3, 5, 12, 8, 0, 1]);
  assert.equal(h.passes[0].vertices, 3);
  assert.equal(h.passes[0].ended, true);
  assert.equal(h.copies.length, 0);
});

test("sampled blits clamp thin mip dimensions to one pixel", () => {
  const h = blitHarness();
  h.blit(
    { tex: texture(8, 2, 4), format: "rgba8unorm" },
    { tex: texture(8, 8, 4), format: "bgra8unorm" },
    0, 0, 1, 1, 0, 0, 2, 2, 0, 3, 0, 1
  );
  assert.deepEqual(Array.from(new Float32Array(h.buffers[0].bytes)), [1, 1, 0, 0]);
});

test("exact texture copies preserve source and destination mip, layer, and rectangle", () => {
  const h = blitHarness();
  const s = { tex: texture(64, 32, 6, 4), format: "rgba8unorm" };
  const d = { tex: texture(64, 64, 6, 4), format: "rgba8unorm" };
  h.blit(s, d, 4, 2, 8, 4, 1, 3, 8, 4, 2, 1, 3, 2);
  assert.equal(h.copies.length, 1);
  const [source, destination, size] = h.copies[0];
  assert.equal(source.texture, s.tex);
  assert.equal(destination.texture, d.tex);
  // Spread vm-created objects into the host realm for strict comparisons.
  assert.equal(source.mipLevel, 1);
  assert.deepEqual({ ...source.origin }, { x: 4, y: 2, z: 2 });
  assert.equal(destination.mipLevel, 2);
  assert.deepEqual({ ...destination.origin }, { x: 1, y: 3, z: 3 });
  assert.deepEqual({ ...size }, { width: 8, height: 4, depthOrArrayLayers: 1 });
  assert.equal(h.buffers.length, 0);
  assert.equal(h.passes.length, 0);
});

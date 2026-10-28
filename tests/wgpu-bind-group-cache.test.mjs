// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBindGroupCache, requestedWgpuBindGroupCache } from "../src/wgpu-bind-group-cache.js";

// A device double: every createBindGroup returns a new object and is counted.
function device() {
  const created = [];
  return { created, createBindGroup(desc) { const g = { desc }; created.push(g); return g; } };
}

test("bind group cache: the same layout and resource objects give the same group", () => {
  const dev = device(), cache = createBindGroupCache();
  const layout = {}, view = {}, sampler = {}, buffer = {};
  const entries = () => [{ binding: 0, resource: view }, { binding: 8, resource: sampler }, { binding: 9, resource: { buffer, offset: 0, size: 256 } }];
  const a = cache.get(dev, layout, entries());
  const b = cache.get(dev, layout, entries());
  assert.equal(a, b);
  assert.equal(dev.created.length, 1);
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, evictions: 0, size: 1, capacity: 4096 });
});

test("bind group cache: another layout, view, sampler, buffer, offset, size or binding is another group", () => {
  const dev = device(), cache = createBindGroupCache();
  const layout = {}, view = {}, sampler = {}, buffer = {};
  const base = { layout, view, sampler, buffer, offset: 0, size: 256, binding: 0 };
  const make = (o) => cache.get(dev, o.layout, [{ binding: o.binding, resource: o.view }, { binding: 8, resource: o.sampler }, { binding: 9, resource: { buffer: o.buffer, offset: o.offset, size: o.size } }]);
  const first = make(base);
  for (const change of [{ layout: {} }, { view: {} }, { sampler: {} }, { buffer: {} }, { offset: 256 }, { size: 128 }, { binding: 1 }]) {
    assert.notEqual(make({ ...base, ...change }), first, JSON.stringify(Object.keys(change)));
  }
  // A buffer bound whole ({ buffer }) is not the same as a sized window.
  assert.notEqual(cache.get(dev, layout, [{ binding: 9, resource: { buffer } }]), cache.get(dev, layout, [{ binding: 9, resource: { buffer, offset: 0, size: 256 } }]));
  assert.equal(make(base), first, "still cached");
});

test("bind group cache: a resource recreated under the same core id is a new object, hence a new group", () => {
  const dev = device(), cache = createBindGroupCache();
  const layout = {}, textures = new Map([[7, { view: {} }]]);
  const group = () => cache.get(dev, layout, [{ binding: 0, resource: textures.get(7).view }]);
  const before = group();
  textures.set(7, { view: {} }); // id 7 destroyed and created again
  assert.notEqual(group(), before);
});

test("bind group cache: bounded, least recently used first out", () => {
  const dev = device(), cache = createBindGroupCache({ capacity: 2 });
  const layout = {}, v1 = {}, v2 = {}, v3 = {};
  const g = (v) => cache.get(dev, layout, [{ binding: 0, resource: v }]);
  const a = g(v1); g(v2);
  assert.equal(g(v1), a, "v1 used again: most recent");
  g(v3); // evicts v2
  assert.equal(cache.stats().evictions, 1);
  assert.equal(g(v1), a, "v1 kept");
  const created = dev.created.length;
  g(v2);
  assert.equal(dev.created.length, created + 1, "v2 was evicted");
  assert.throws(() => createBindGroupCache({ capacity: 0 }), RangeError);
});

test("bind group cache: ?wgpubgcache=1 only, off by default, reaches the worker's replay", async (t) => {
  assert.equal(requestedWgpuBindGroupCache(""), false);
  assert.equal(requestedWgpuBindGroupCache("?wgpubgcache=1"), true);
  assert.equal(requestedWgpuBindGroupCache("?wgpubgcache=true"), false);
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  for (const value of [true, false]) {
    const adapter = new UpstreamWorkerAdapter({ wgpuBindGroupCache: value });
    let posted = null;
    adapter.worker = { postMessage(message) { posted = message; queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true })); } };
    const originalWindow = globalThis.window;
    globalThis.window = { location: { href: "http://127.0.0.1:8080/", search: "" } };
    t.after(() => { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
    await adapter.load();
    assert.equal(posted.payload.wgpuBindGroupCache, value);
  }
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(host, /this\.wgpuBindGroupCache = requestedWgpuBindGroupCache\(window\.location\.search\);/);
  assert.match(host, /\n {12}wgpuBindGroupCache: this\.wgpuBindGroupCache,\n/);
  assert.match(worker, /\n {8}wgpuBindGroupCache: payload\.wgpuBindGroupCache,\n/);
  assert.match(worker, /webGpuObjects\.bindGroupCache = requestedWgpuBindGroupCache === true \? createBindGroupCache\(\) : null;/);
  assert.match(worker, /const bindGroupCache = webGpuObjects\.bindGroupCache;\n\s+webGpuObjects\.bindGroups\.set\(id, bindGroupCache\n\s+\? bindGroupCache\.get\(renderGpu\.device, layout, entries\)\n\s+: renderGpu\.device\.createBindGroup\(\{ layout, entries \}\)\);/);
});

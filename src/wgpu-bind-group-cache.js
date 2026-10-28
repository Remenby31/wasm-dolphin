// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Bind groups reused across the core's create-bind-group records (opt-in,
// ?wgpubgcache=1). The core asks for ~2,000 new bind groups a second during
// a race, most of them identical to an earlier one. Under WebKit each one
// costs memory in the page's process until a garbage collection
// (research/deep-ios-host.md §B.4). A record whose layout and resources are
// the same objects as an earlier one gets that earlier GPUBindGroup.
//
// The key is made of object identities (layout, texture view, sampler,
// buffer + offset + size), never of the core's ids: a texture or buffer
// recreated under the same id is a new object, hence a new key. A new device
// has new layouts, hence new keys. The cache is bounded (least recently used
// first out); an evicted group stays valid for the records that hold it.

export const BIND_GROUP_CACHE_CAPACITY = 4096;

export function createBindGroupCache({ capacity = BIND_GROUP_CACHE_CAPACITY } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (object) => {
    if (object === null || typeof object !== "object") return `~${String(object)}`;
    let id = ids.get(object);
    if (id === undefined) {
      id = nextId++;
      ids.set(object, id);
    }
    return id;
  };
  const groups = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0 };

  function keyOf(layout, entries) {
    let key = String(idOf(layout));
    for (const entry of entries) {
      const resource = entry.resource;
      key += `|${entry.binding}:`;
      if (resource && typeof resource === "object" && "buffer" in resource && !("dimension" in resource)) {
        key += `b${idOf(resource.buffer)}@${resource.offset ?? 0}+${resource.size ?? "*"}`;
      } else {
        key += idOf(resource);
      }
    }
    return key;
  }

  return {
    // The group for (layout, entries): an earlier identical one, else a new one.
    get(device, layout, entries) {
      const key = keyOf(layout, entries);
      const cached = groups.get(key);
      if (cached) {
        stats.hits += 1;
        groups.delete(key);
        groups.set(key, cached);
        return cached;
      }
      const group = device.createBindGroup({ layout, entries });
      stats.misses += 1;
      groups.set(key, group);
      if (groups.size > capacity) {
        groups.delete(groups.keys().next().value);
        stats.evictions += 1;
      }
      return group;
    },
    clear() { groups.clear(); },
    stats: () => ({ ...stats, size: groups.size, capacity }),
  };
}

// ?wgpubgcache=1: reuse identical bind groups; anything else: off.
export function requestedWgpuBindGroupCache(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpubgcache") === "1";
}

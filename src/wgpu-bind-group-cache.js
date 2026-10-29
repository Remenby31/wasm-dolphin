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
// A destroyed resource (forget) drops every cached group that binds it, so
// the cache never keeps a texture or buffer alive after the core freed it;
// a lost device empties it (clear).

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
  // key -> { group, objects }; object -> keys of the groups that bind it.
  const groups = new Map();
  const keysByObject = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0, forgotten: 0 };

  function keyOf(layout, entries, objects) {
    let key = String(idOf(layout));
    objects.push(layout);
    for (const entry of entries) {
      const resource = entry.resource;
      key += `|${entry.binding}:`;
      if (resource && typeof resource === "object" && "buffer" in resource && !("dimension" in resource)) {
        key += `b${idOf(resource.buffer)}@${resource.offset ?? 0}+${resource.size ?? "*"}`;
        objects.push(resource.buffer);
      } else {
        key += idOf(resource);
        if (resource && typeof resource === "object") objects.push(resource);
      }
    }
    return key;
  }

  function drop(key) {
    const entry = groups.get(key);
    if (!entry) return;
    groups.delete(key);
    for (const object of entry.objects) {
      const keys = keysByObject.get(object);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) keysByObject.delete(object);
    }
  }

  return {
    // The group for (layout, entries): an earlier identical one, else a new one.
    get(device, layout, entries) {
      const objects = [];
      const key = keyOf(layout, entries, objects);
      const cached = groups.get(key);
      if (cached) {
        stats.hits += 1;
        groups.delete(key);
        groups.set(key, cached);
        return cached.group;
      }
      const group = device.createBindGroup({ layout, entries });
      stats.misses += 1;
      groups.set(key, { group, objects });
      for (const object of objects) {
        let keys = keysByObject.get(object);
        if (!keys) keysByObject.set(object, (keys = new Set()));
        keys.add(key);
      }
      if (groups.size > capacity) {
        drop(groups.keys().next().value);
        stats.evictions += 1;
      }
      return group;
    },
    // A resource the core destroyed: every cached group binding it goes.
    forget(object) {
      const keys = keysByObject.get(object);
      if (!keys) return 0;
      const count = keys.size;
      for (const key of [...keys]) drop(key);
      stats.forgotten += count;
      return count;
    },
    clear() {
      groups.clear();
      keysByObject.clear();
    },
    stats: () => ({ ...stats, size: groups.size, objects: keysByObject.size, capacity }),
  };
}

// The engine's own default: on under JavaScriptCore. Each new GPUBindGroup
// costs Safari's page memory until a garbage collection; with the cache, the
// mapped transport and 4 slots, a race held 100-102 % over 180 s where the
// default path fell to 30-38 % past ~60 s (research/deep-ios-host.md).
export function defaultWgpuBindGroupCache(engine) {
  return engine === "jsc";
}

// ?wgpubgcache=1|0 forces it on or off, else the engine's default.
export function requestedWgpuBindGroupCache(
  search = globalThis.location?.search ?? "",
  fallback = false
) {
  const value = new URLSearchParams(search).get("wgpubgcache");
  if (value === "1") return true;
  if (value === "0") return false;
  return fallback === true;
}

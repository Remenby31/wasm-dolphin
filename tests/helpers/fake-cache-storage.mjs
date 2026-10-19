// CacheStorage as the browser has it, in memory. Entries keep the stored
// Response's bytes and headers; `failPut` simulates a full quota.
export function fakeCacheStorage() {
  const caches = new Map();
  const storage = {
    failPut: null,
    caches,
    async open(name) {
      if (!caches.has(name)) {
        const entries = new Map();
        caches.set(name, {
          entries,
          async put(url, response) {
            if (storage.failPut) {
              const error = storage.failPut(name, url);
              if (error) throw error;
            }
            entries.set(String(url), { body: new Uint8Array(await response.arrayBuffer()), headers: [...response.headers] });
          },
          async match(url) {
            const hit = entries.get(String(url?.url ?? url));
            return hit ? new Response(hit.body.slice(), { headers: hit.headers }) : undefined;
          },
          async delete(url) {
            return entries.delete(String(url?.url ?? url));
          },
          async keys() {
            return [...entries.keys()].map((url) => ({ url }));
          }
        });
      }
      return caches.get(name);
    },
    async has(name) {
      return caches.has(name);
    },
    async delete(name) {
      return caches.delete(name);
    },
    async keys() {
      return [...caches.keys()];
    }
  };
  return storage;
}


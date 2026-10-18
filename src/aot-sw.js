// Service Worker part of the region cache (plan piste 3, P6; see aot-cache.js).
//
// A classic script with no imports, so that a site's own Service Worker can
// pull it in with importScripts(). It adds one fetch listener and answers only
// URLs with a "/__salon-aot/" segment, from CacheStorage, never the network:
// every other request is left alone and keeps its COOP/COEP/CORP headers.
// A response that comes straight from cache.match() is what lets V8 keep the
// optimized code of a module compiled with compileStreaming().
//
// Registered on its own (engine server without a site), as
// "aot-sw.js?standalone=1": it then also takes control of open pages at once.
(function salonAotServiceWorker() {
  "use strict";
  var SEGMENT = "/__salon-aot/";
  var CACHE_PREFIX = "salon-aot-v1-";
  var NAME_RE = /^salon-aot-v1-[0-9a-f]{40}$/;
  var CORP = { "cross-origin-resource-policy": "same-origin" };

  function headers(extra) {
    var out = { "x-salon-aot-sw": "1" };
    for (var k in CORP) out[k] = CORP[k];
    for (var e in extra || {}) out[e] = extra[e];
    return out;
  }

  function answer(request, url) {
    var rest = url.pathname.slice(url.pathname.indexOf(SEGMENT) + SEGMENT.length);
    if (rest === "ping") return Promise.resolve(new Response(null, { status: 204, headers: headers() }));
    var slash = rest.indexOf("/");
    var name = slash > 0 ? rest.slice(0, slash) : "";
    if (!NAME_RE.test(name) || name.indexOf(CACHE_PREFIX) !== 0) {
      return Promise.resolve(new Response("not an aot cache", { status: 404, headers: headers() }));
    }
    return caches.has(name).then(function (exists) {
      if (!exists) return null;
      return caches.open(name).then(function (cache) {
        return cache.match(request.url);
      });
    }).then(function (hit) {
      return hit || new Response("missing", { status: 404, headers: headers() });
    }, function () {
      return new Response("cache unavailable", { status: 503, headers: headers() });
    });
  }

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;
    var url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return;
    }
    if (url.origin !== self.location.origin || url.pathname.indexOf(SEGMENT) < 0) return;
    event.respondWith(answer(request, url));
  });

  var standalone = false;
  try {
    standalone = new URL(self.location.href).searchParams.get("standalone") === "1";
  } catch (e) {
    standalone = false;
  }
  if (standalone) {
    self.addEventListener("install", function () {
      self.skipWaiting();
    });
    self.addEventListener("activate", function (event) {
      event.waitUntil(self.clients.claim());
    });
  }
})();

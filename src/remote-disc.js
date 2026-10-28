// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A disc read in place over HTTP range requests, for measurements in a
// browser that cannot be handed a local file: Safari driven by WebDriver
// gives the page a File it cannot read (NotReadableError, Safari 26.6). A
// plain descriptor { remoteDisc: url, name, size } crosses postMessage like
// a File (the descriptor itself, never its Blob-like: functions do not
// clone); each worker that reads the disc turns it into a Blob-like whose
// slice() fetches its range synchronously (sync XHR: workers only) and
// returns a real Blob, which FileReaderSync and WORKERFS read as usual.
//
// Server prerequisites: it answers each range with 206 and the exact
// Content-Range asked for, and with Cache-Control: no-store, so the browser
// keeps no copy of the disc. Only this machine's server is accepted
// (loopback), unless the harness hooks are on (anyHost): a link can never
// make a player's engine read a disc from a third-party host, whatever the
// page lets through.

export function isRemoteDisc(x) {
  return !!x && typeof x === "object" && typeof x.remoteDisc === "string" && !(typeof Blob === "function" && x instanceof Blob);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function remoteDiscAllowed(file, { anyHost = false } = {}) {
  let url;
  try {
    url = new URL(file.remoteDisc);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return anyHost || LOOPBACK.has(url.hostname);
}

// The disc as a Blob-like (the descriptor), or the File itself.
export function asDiscBlob(file, { request = () => new XMLHttpRequest(), anyHost = false } = {}) {
  if (!isRemoteDisc(file)) return file;
  if (!remoteDiscAllowed(file, { anyHost })) throw new Error(`remote disc refused: ${String(file.remoteDisc).slice(0, 100)} is not on this machine`);
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`remote disc: bad size ${file.size}`);
  const read = (start, end) => {
    if (end <= start) return new Blob([]);
    const xhr = request();
    xhr.open("GET", file.remoteDisc, false);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", `bytes=${start}-${end - 1}`);
    xhr.send();
    const body = xhr.response;
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(xhr.getResponseHeader?.("Content-Range") ?? "");
    if (xhr.status !== 206 || !body || body.byteLength !== end - start || !range || Number(range[1]) !== start || Number(range[2]) !== end - 1) {
      throw new Error(`remote disc: range ${start}-${end - 1} answered ${xhr.status} (${range ? range[0] : "no Content-Range"}) with ${body?.byteLength ?? 0} bytes`);
    }
    return new Blob([body]);
  };
  // Blob.slice's arguments: integers, negative from the end, NaN as 0.
  const clamp = (v, d) => {
    let n = v === undefined ? d : Math.trunc(Number(v));
    if (Number.isNaN(n)) n = 0;
    return Math.min(size, Math.max(0, n < 0 ? size + n : n));
  };
  return {
    name: String(file.name ?? "disc.iso"),
    size,
    type: "",
    lastModified: Number(file.lastModified ?? 0),
    lastModifiedDate: new Date(Number(file.lastModified ?? 0)),
    slice: (a, b) => read(clamp(a, 0), clamp(b, size)),
    arrayBuffer: async () => read(0, size).arrayBuffer(),
  };
}

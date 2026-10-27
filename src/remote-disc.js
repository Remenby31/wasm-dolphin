// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A disc read in place over HTTP range requests, for measurements in a
// browser that cannot be handed a local file: Safari driven by WebDriver
// gives the page a File it cannot read (NotReadableError, Safari 26.6). A
// plain descriptor { remoteDisc: url, name, size } crosses postMessage like
// a File; each worker that reads the disc turns it into a Blob-like whose
// slice() fetches its range synchronously (sync XHR: workers only) and
// returns a real Blob, which FileReaderSync and WORKERFS read as usual.
// The server answers 206 with Cache-Control: no-store, so the browser keeps
// no copy of the disc.

export function isRemoteDisc(x) {
  return !!x && typeof x === "object" && typeof x.remoteDisc === "string" && !(typeof Blob === "function" && x instanceof Blob);
}

// The disc as a Blob-like (the descriptor), or the File itself.
export function asDiscBlob(file, { request = () => new XMLHttpRequest() } = {}) {
  if (!isRemoteDisc(file)) return file;
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
    if (xhr.status !== 206 || !body || body.byteLength !== end - start) {
      throw new Error(`remote disc: range ${start}-${end - 1} answered ${xhr.status} with ${body?.byteLength ?? 0} bytes`);
    }
    return new Blob([body]);
  };
  const clamp = (v, d) => {
    const n = v === undefined ? d : Math.trunc(Number(v));
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

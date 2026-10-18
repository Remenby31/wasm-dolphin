#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Wrap a GameCube .dol in a minimal GCM disc image the emulator can boot:
// disc header + bi2 + a tiny apploader (apploader/apploader.c) whose section
// table is patched here, the DOL, an empty FST, and padding to 17 MiB
// (the app ignores images smaller than 16 MiB).
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const TABLE_MAGIC = 0x48425442; // "HBTB"
const MAX_SECTIONS = 32;
const DOL_OFFSET = 0x20000;
const APPLOADER_OFFSET = 0x2440;
const MIN_IMAGE_BYTES = 17 << 20;
const GC_DISC_MAGIC = 0xc2339f3d;

const align = (value, to) => Math.ceil(value / to) * to;

export function parseDol(dol) {
  const view = new DataView(dol.buffer, dol.byteOffset, dol.byteLength);
  if (dol.byteLength < 0x100) throw new Error("DOL too small");
  const u32 = (offset) => view.getUint32(offset);
  const sections = [];
  for (let i = 0; i < 18; i += 1) {
    const offset = u32(i * 4);
    const address = u32(0x48 + i * 4);
    const size = u32(0x90 + i * 4);
    if (size) sections.push({ offset, address, size });
  }
  return { sections, bssAddress: u32(0xd8), bssSize: u32(0xdc), entry: u32(0xe0) };
}

export function patchApploader(apploader, table) {
  if (table.sections.length > MAX_SECTIONS) throw new Error(`more than ${MAX_SECTIONS} sections`);
  const out = new Uint8Array(align(apploader.byteLength, 32));
  out.set(apploader);
  const view = new DataView(out.buffer);
  let at = -1;
  for (let i = 0; i + 4 <= out.byteLength; i += 4) {
    if (view.getUint32(i) === TABLE_MAGIC) {
      if (at !== -1) throw new Error("apploader has more than one section table");
      at = i;
    }
  }
  if (at === -1) throw new Error("apploader section table magic not found");
  if (at + 12 + MAX_SECTIONS * 12 > out.byteLength) throw new Error("apploader section table truncated");
  view.setUint32(at + 4, table.sections.length);
  view.setUint32(at + 8, table.entry);
  table.sections.forEach((s, i) => {
    const base = at + 12 + i * 12;
    view.setUint32(base, s.ram);
    view.setUint32(base + 4, s.len);
    view.setUint32(base + 8, s.off);
  });
  return out;
}

export function buildGcm({ dol, apploader, gameId = "HBXX", maker = "01", name = "homebrew", date = "2026/10/17" }) {
  if (!/^[A-Z0-9]{4}$/.test(gameId)) throw new Error("gameId must be 4 chars [A-Z0-9]");
  const parsed = parseDol(dol);
  const sections = parsed.sections.map((s) => ({ ram: s.address, len: align(s.size, 32), off: DOL_OFFSET + s.offset }));
  const fstOffset = align(DOL_OFFSET + dol.byteLength, 0x8000);
  const fst = new Uint8Array(16);
  new DataView(fst.buffer).setUint32(0, 0x01000000); // root dir entry
  new DataView(fst.buffer).setUint32(8, 1); // 1 entry: just the root
  const zeroOffset = align(fstOffset + fst.byteLength, 0x8000);
  // BSS is "loaded" from a run of zero bytes on the disc.
  if (parsed.bssSize) sections.push({ ram: parsed.bssAddress, len: align(parsed.bssSize, 32), off: zeroOffset });
  const app = patchApploader(apploader, { sections, entry: parsed.entry });
  if (APPLOADER_OFFSET + 0x20 + app.byteLength >= DOL_OFFSET) throw new Error("apploader too large");

  const size = Math.max(MIN_IMAGE_BYTES, zeroOffset + parsed.bssSize + 0x8000);
  const img = new Uint8Array(size);
  const view = new DataView(img.buffer);
  img.set(new TextEncoder().encode(gameId + maker), 0);
  view.setUint32(0x1c, GC_DISC_MAGIC);
  img.set(new TextEncoder().encode(name).subarray(0, 0x3df), 0x20);
  view.setUint32(0x420, DOL_OFFSET);
  view.setUint32(0x424, fstOffset);
  view.setUint32(0x428, fst.byteLength);
  view.setUint32(0x42c, fst.byteLength);
  view.setUint32(0x440 + 0x18, 1); // bi2 region: NTSC-U
  img.set(new TextEncoder().encode(date), APPLOADER_OFFSET);
  view.setUint32(APPLOADER_OFFSET + 0x10, 0x81200000); // entry point
  view.setUint32(APPLOADER_OFFSET + 0x14, app.byteLength);
  img.set(app, APPLOADER_OFFSET + 0x20);
  img.set(dol, DOL_OFFSET);
  img.set(fst, fstOffset);
  return img;
}

function main() {
  const { values } = parseArgs({
    options: {
      dol: { type: "string" },
      apploader: { type: "string" },
      out: { type: "string" },
      id: { type: "string", default: "HBXX" },
      name: { type: "string", default: "homebrew" }
    }
  });
  if (!values.dol || !values.apploader || !values.out) {
    console.error("usage: mkgcm.mjs --dol x.dol --apploader apploader.bin --out x.iso [--id HBXX] [--name text]");
    process.exit(2);
  }
  const img = buildGcm({
    dol: readFileSync(values.dol),
    apploader: readFileSync(values.apploader),
    gameId: values.id,
    name: values.name
  });
  // Write the data part only, then extend with truncate: the zero padding
  // becomes a hole, so a 17 MiB image takes ~1 MiB on disk.
  let end = img.byteLength;
  while (end > 0 && img[end - 1] === 0) end -= 1;
  writeFileSync(values.out, img.subarray(0, end));
  truncateSync(values.out, img.byteLength);
  console.log(`${values.out}: ${img.byteLength} bytes`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

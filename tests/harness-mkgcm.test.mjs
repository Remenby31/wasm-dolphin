// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { buildGcm, parseDol, TABLE_MAGIC } from "../harness/homebrew/mkgcm.mjs";

function fakeDol() {
  const dol = new Uint8Array(0x100 + 0x40 + 0x20);
  const v = new DataView(dol.buffer);
  v.setUint32(0x00, 0x100); v.setUint32(0x48, 0x80003100); v.setUint32(0x90, 0x40); // text0
  v.setUint32(0x1c, 0x140); v.setUint32(0x64, 0x80010000); v.setUint32(0xac, 0x20); // data0
  v.setUint32(0xd8, 0x80020000); v.setUint32(0xdc, 0x1000); v.setUint32(0xe0, 0x80003100);
  return dol;
}

function fakeApploader() {
  const app = new Uint8Array(64 + 12 + 32 * 12);
  new DataView(app.buffer).setUint32(64, TABLE_MAGIC);
  return app;
}

test("DOL sections, BSS and entry are parsed", () => {
  const d = parseDol(fakeDol());
  assert.equal(d.sections.length, 2);
  assert.equal(d.entry, 0x80003100);
  assert.equal(d.bssSize, 0x1000);
});

test("GCM image: header, apploader table patched, DOL in place, ≥ 16 MiB", () => {
  const img = buildGcm({ dol: fakeDol(), apploader: fakeApploader(), gameId: "HBTS", name: "test" });
  const v = new DataView(img.buffer);
  assert.ok(img.byteLength > 16 << 20);
  assert.equal(new TextDecoder().decode(img.subarray(0, 6)), "HBTS01");
  assert.equal(v.getUint32(0x1c), 0xc2339f3d);
  assert.equal(v.getUint32(0x420), 0x20000); // DOL offset
  assert.equal(v.getUint32(0x2450), 0x81200000); // apploader entry
  const table = 0x2460 + 64;
  assert.equal(v.getUint32(table), TABLE_MAGIC);
  assert.equal(v.getUint32(table + 4), 3); // text, data, bss
  assert.equal(v.getUint32(table + 8), 0x80003100);
  assert.deepEqual([v.getUint32(table + 12), v.getUint32(table + 16), v.getUint32(table + 20)], [0x80003100, 0x40, 0x20100]);
  assert.equal(v.getUint32(0x20000), 0x100); // DOL header copied
});

test("an apploader without the section table is refused", () => {
  assert.throws(() => buildGcm({ dol: fakeDol(), apploader: new Uint8Array(64) }), /magic not found/);
});

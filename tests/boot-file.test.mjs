import assert from "node:assert/strict";
import test from "node:test";

import { bootFileKind, checkExecutable } from "../src/boot-file.js";

function dol({ entry = 0x80003100, offset = 0x100, size = 0x40 } = {}) {
  const head = new Uint8Array(0x100);
  const view = new DataView(head.buffer);
  view.setUint32(0x00, offset); // text0 file offset
  view.setUint32(0x48, 0x80003000); // text0 address
  view.setUint32(0x90, size); // text0 size
  view.setUint32(0xe0, entry);
  return head;
}

function elf({ machine = 20, klass = 1, data = 2 } = {}) {
  const head = new Uint8Array(0x100);
  head.set([0x7f, 0x45, 0x4c, 0x46, klass, data], 0);
  head[18] = machine >> 8;
  head[19] = machine & 0xff;
  new DataView(head.buffer).setUint32(24, 0x80004000);
  return head;
}

test("the extension decides between a disc and an executable, as in Dolphin", () => {
  assert.equal(bootFileKind("padtest.DOL"), "dol");
  assert.equal(bootFileKind("demo.elf"), "elf");
  assert.equal(bootFileKind("game.iso"), "disc");
  assert.equal(bootFileKind("game.rvz"), "disc");
});

test("a DOL is accepted when its sections fit the file and its entry is in RAM", () => {
  assert.deepEqual(checkExecutable("dol", dol(), 0x140), { kind: "dol", entryPoint: 0x80003100 });
  assert.throws(() => checkExecutable("dol", dol(), 0x120), /text section 0 lies outside the file/);
  assert.throws(() => checkExecutable("dol", dol({ entry: 0x1234 }), 0x140), /not in GameCube RAM/);
  assert.throws(() => checkExecutable("dol", new Uint8Array(0x100), 0x100), /no sections/);
});

test("an ELF must be 32-bit big-endian PowerPC", () => {
  assert.deepEqual(checkExecutable("elf", elf(), 0x1000), { kind: "elf", entryPoint: 0x80004000 });
  assert.throws(() => checkExecutable("elf", elf({ machine: 62 }), 0x1000), /machine 62, not PowerPC/);
  assert.throws(() => checkExecutable("elf", elf({ data: 1 }), 0x1000), /32-bit big-endian/);
  assert.throws(() => checkExecutable("elf", dol(), 0x1000), /bad magic/);
});

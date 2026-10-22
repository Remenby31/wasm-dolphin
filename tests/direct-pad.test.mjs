import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DIRECT_PAD_LAYOUT, DIRECT_PAD_PORTS, DIRECT_PAD_SLOTS, DirectPad, SLOT } from "../src/direct-pad.js";

const root = resolve(import.meta.dirname, "..");
const compiler = process.env.CXX || "c++";
const hasCompiler = spawnSync(compiler, ["--version"]).status === 0;

// The SI poll side (dolphin_web_direct_pad.h), natively: a tap shorter than a
// poll interval is reported until a poll of a later frame; the press counter
// counts it once; a page that never wrote a port falls back; an unplugged
// port reports nothing.
const program = String.raw`
#include <cstdio>
#include "dolphin_web_direct_pad.h"
using namespace DolphinWeb::DirectPad;
int main() {
  static Block block{};
  auto* p = block.slots[1];
  TapLatch latch;
  bool direct = false;
  std::uint32_t reported = 0;
  int fallbacks = 0;
  auto fallback = [&] { ++fallbacks; State s; s.connected = true; s.mask = 0x10; return s; };
  PollPort(p, latch, 0, 1.0, fallback, &reported, &direct);
  std::printf("%d %u %d\n", direct, reported, fallbacks);           // not written: fallback
  // Page: connected, nothing held, seq 7; then a tap of A (bit 0) already released.
  p[SEQ] = 2; p[CONNECTED] = 1; p[MASK] = 0; p[INPUT_SEQ] = 7; StoreF64(p + RX_TIME, 1000.5); p[ENABLED] = 1;
  p[TAPS] |= 1u;
  PollPort(p, latch, 10, 1001.0, fallback, &reported, &direct);   // frame 10
  std::printf("%d %u %u %.1f\n", direct, reported, p[APPLIED_SEQ].load(), LoadF64(p + APPLIED_RX_TIME));
  PollPort(p, latch, 10, 1002.0, fallback, &reported, &direct);   // same frame: still held
  std::printf("%u\n", reported);
  PollPort(p, latch, 11, 1003.0, fallback, &reported, &direct);   // next frame: reported once more, then released
  std::printf("%u\n", reported);
  PollPort(p, latch, 11, 1004.0, fallback, &reported, &direct);
  std::printf("%u %u %u %.1f\n", reported, p[PRESSES + 0].load(), p[POLL_COUNT].load(), LoadF64(p + EDGE_POLL_TIME));
  // A writer mid-update (odd seq): the poll falls back rather than read a torn state.
  p[SEQ] = 3;
  PollPort(p, latch, 12, 1005.0, fallback, &reported, &direct);
  std::printf("%d %d\n", direct, fallbacks);
  p[SEQ] = 4; p[CONNECTED] = 0; p[TAPS] |= 2u;
  PollPort(p, latch, 13, 1006.0, fallback, &reported, &direct);
  std::printf("%u %u\n", reported, p[TAPS].load());
}
`;

test("SI poll side: direct read, tap hold across a frame boundary, counters", { skip: !hasCompiler && "no C++ compiler" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "direct-pad-"));
  try {
    writeFileSync(join(dir, "main.cpp"), program);
    const exe = join(dir, "main");
    const built = spawnSync(compiler, ["-std=c++20", "-I", join(root, "core/upstream"), join(dir, "main.cpp"), "-o", exe], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(exe, { encoding: "utf8" });
    assert.deepEqual(run.stdout.trim().split("\n"), [
      "0 16 1",          // fallback state (mask 0x10), not direct
      "1 1 7 1000.5",    // tap reported at once, seq and reception time echoed
      "1",               // held through the frame
      "1",               // reported by a poll of the next frame
      "0 1 5 1001.0",    // then released; one press counted at poll time 1001; five polls
      "0 2",             // torn read → fallback
      "0 0"              // unplugged: nothing reported, taps consumed
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page side writes the header's layout", () => {
  const header = readFileSync(join(root, "core/upstream/dolphin_web_direct_pad.h"), "utf8");
  const num = (name) => Number(header.match(new RegExp(`${name}\\s*=\\s*(\\d+)`))[1]);
  assert.equal(DIRECT_PAD_LAYOUT, num("DIRECT_PAD_LAYOUT"));
  assert.equal(DIRECT_PAD_PORTS, num("DIRECT_PAD_PORTS"));
  assert.equal(DIRECT_PAD_SLOTS, num("DIRECT_PAD_SLOTS"));
  for (const [name, index] of Object.entries(SLOT)) assert.equal(index, num(name), name);

  const memory = new SharedArrayBuffer(4096);
  const pad = new DirectPad(memory, 512, DIRECT_PAD_LAYOUT);
  pad.write(2, { mask: 0x101, stickX: 1, stickY: 2, cStickX: 3, cStickY: 4, triggerLeft: 5, triggerRight: 6, analogA: 7, analogB: 300 }, { inputSeq: 9, rxTime: 12.25 });
  pad.tap(2, 0x1001); // bit 12 is not a button: dropped
  const v = new Int32Array(memory, 512);
  const b = 2 * DIRECT_PAD_SLOTS;
  assert.equal(v[b + SLOT.SEQ] & 1, 0);
  assert.equal(v[b + SLOT.ENABLED], 1);
  assert.equal(v[b + SLOT.MASK], 0x101);
  assert.equal(v[b + SLOT.AXES0] >>> 0, 0x04030201);
  assert.equal(v[b + SLOT.AXES1] >>> 0, 0xff070605);
  assert.equal(v[b + SLOT.TAPS], 1);
  assert.equal(v[b + SLOT.INPUT_SEQ], 9);
  assert.equal(new Float64Array(memory, 512)[(b + SLOT.RX_TIME) / 2], 12.25);
  pad.write(2, null, { connected: false });
  assert.equal(v[b + SLOT.CONNECTED], 0);
  assert.equal(v[b + SLOT.MASK], 0);
  assert.throws(() => new DirectPad(memory, 4, DIRECT_PAD_LAYOUT), RangeError);
  assert.throws(() => new DirectPad(memory, 512, DIRECT_PAD_LAYOUT + 1), RangeError);
});

// A tap of a button still held by the latch is queued, not merged: the game
// reads two presses with a release between them. ComposeMask: taps add
// buttons only, an unplugged port reports nothing.
const latchProgram = String.raw`
#include <cstdio>
#include "dolphin_web_direct_pad.h"
using namespace DolphinWeb::DirectPad;
int main() {
  TapLatch latch;
  // Two taps of A (bit 0) inside one window; polls at two per window.
  std::uint32_t taps[] = {1, 1, 0, 0, 0, 0, 0, 0};
  int edges = 0;
  std::uint32_t prev = 0;
  for (int poll = 0; poll < 8; ++poll) {
    const std::uint32_t r = latch.Poll(0, taps[poll], poll / 2) & 1;
    if (r && !prev) ++edges;
    std::printf("%u", r);
    prev = r;
  }
  State s; s.connected = true; s.mask = 1u << 13;   // a digital stick bit kept as is
  std::printf(" %d %x %x", edges, ComposeMask(s, 0x1001u), ComposeMask(State{}, 0xfffu));
}
`;

test("SI poll side: a second tap during the hold is reported after a release, not merged", { skip: !hasCompiler && "no C++ compiler" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "direct-pad-latch-"));
  try {
    writeFileSync(join(dir, "main.cpp"), latchProgram);
    const exe = join(dir, "main");
    const built = spawnSync(compiler, ["-std=c++20", "-I", join(root, "core/upstream"), join(dir, "main.cpp"), "-o", exe], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(exe, { encoding: "utf8" });
    // pressed through window 0 and the first poll of window 1, released for
    // window 1's rest, pressed again through window 2 and into 3: two edges.
    assert.equal(run.stdout.trim(), "11101110 2 2001 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The gold-standard case: a burst lost across a gap that covered three
// presses of A. The next packet's counter says 3: the poll must report three
// separate presses, not one.
const countsProgram = String.raw`
#include <cstdio>
#include "dolphin_web_direct_pad.h"
using namespace DolphinWeb::DirectPad;
int main() {
  static Block block{};
  auto* p = block.slots[1];
  p[SEQ] = 2; p[CONNECTED] = 1; p[MASK] = 0; p[ENABLED] = 1;
  p[TAPS] = 3u;                 // A (button 0): 3 presses
  p[TAPS_HIGH] = 2u << 4;       // D_DOWN (button 9): 2 presses
  TapLatch latch;
  bool direct = false;
  std::uint32_t reported = 0;
  auto none = [] { return State{}; };
  for (int poll = 0; poll < 24; ++poll)
    PollPort(p, latch, poll / 2, poll, none, &reported, &direct);
  std::printf("%u %u %u %u", p[PRESSES + 0].load(), p[PRESSES + 9].load(), p[TAPS].load(), p[TAPS_HIGH].load());
}
`;

test("SI poll side: three presses revealed at once are three presses for the game", { skip: !hasCompiler && "no C++ compiler" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "direct-pad-counts-"));
  try {
    writeFileSync(join(dir, "main.cpp"), countsProgram);
    const exe = join(dir, "main");
    const built = spawnSync(compiler, ["-std=c++20", "-I", join(root, "core/upstream"), join(dir, "main.cpp"), "-o", exe], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(exe, { encoding: "utf8" });
    // 3 edges of A, 2 of D_DOWN, both counter words consumed.
    assert.equal(run.stdout.trim(), "3 2 0 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page side: per-button tap counts, 4 bits each, added and saturated", () => {
  const memory = new SharedArrayBuffer(4096);
  const pad = new DirectPad(memory, 512, DIRECT_PAD_LAYOUT);
  const v = new Int32Array(memory, 512);
  const b = 1 * DIRECT_PAD_SLOTS;
  pad.tap(1, 0b1);                                   // mask: A once
  pad.tap(1, [2, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0]);  // A twice more, D_DOWN 3
  assert.equal(v[b + SLOT.TAPS] & 0xf, 3);
  assert.equal((v[b + SLOT.TAPS_HIGH] >>> 4) & 0xf, 3);
  pad.tap(1, [20]);                                  // saturates at 15
  assert.equal(v[b + SLOT.TAPS] & 0xf, 15);
  assert.equal((v[b + SLOT.TAPS] >>> 4) & 0xf, 0, "no carry into B");
});

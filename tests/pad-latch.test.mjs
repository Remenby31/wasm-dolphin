import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const compiler = process.env.CXX || "c++";
const hasCompiler = spawnSync(compiler, ["--version"]).status === 0;

// RunBuffer checks isConnected, then GetData polls again in the same SI
// command (same emulated tick). An unplug landing between the two must not be
// seen by the second poll, or the game gets an uninitialized answer.
const program = String.raw`
#include <cstdio>
#include "dolphin_web_pad_latch.h"
struct Poll { bool connected; int mask; };
int main() {
  Poll host{true, 1};
  int reads = 0;
  DolphinWeb::PadLatch<Poll> latch;
  auto read = [&] { ++reads; return host; };
  const Poll run_buffer = latch.Poll(100, read);
  host = {false, 0};                       // unplugged between the two polls
  const Poll get_data = latch.Poll(100, read);
  const Poll next_command = latch.Poll(101, read);
  std::printf("%d %d %d %d %d\n", run_buffer.connected, get_data.connected, get_data.mask,
              next_command.connected, reads);
}
`;

test("one SI command sees one controller state, even across an unplug", { skip: !hasCompiler && "no C++ compiler" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pad-latch-"));
  try {
    writeFileSync(join(dir, "main.cpp"), program);
    const exe = join(dir, "main");
    const built = spawnSync(compiler, ["-std=c++20", "-I", join(root, "core/upstream"), join(dir, "main.cpp"), "-o", exe], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(exe, { encoding: "utf8" });
    // Both polls of tick 100 report connected with the same state; the
    // unplug shows at tick 101; the host state is read once per tick.
    assert.equal(run.stdout.trim(), "1 1 1 0 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the core polls each port through the per-tick latch", async () => {
  const { readFile } = await import("node:fs/promises");
  const core = await readFile(join(root, "core/upstream/dolphin_web_discio.cpp"), "utf8");
  assert.match(core, /s_pad_latches\[pad_num\]\.Poll\(ticks,/);
  assert.match(core, /GetCoreTiming\(\)\.GetTicks\(\)/);
});

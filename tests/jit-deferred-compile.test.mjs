// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
let root = directory;
while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
assert.ok(existsSync(join(root, "package.json")), "repository root exists");

// The proposed test runs against its neighboring proposed sources. Once moved
// into tests/, it exercises the patched vendor sources without another edit.
const sourceDirectory = existsSync(join(directory, "CachedInterpreter.cpp"))
  ? directory
  : join(root, "vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter");
const sourcePath = join(sourceDirectory, "CachedInterpreter.cpp");
const headerPath = join(sourceDirectory, "WasmDeferredCompileQueue.h");
const compiler = process.platform === "win32"
  ? join(process.env.USERPROFILE ?? "", "emsdk/upstream/bin/clang++.exe")
  : "clang++";
const nativeSkip = !existsSync(sourcePath) || !existsSync(headerPath)
  ? "patched CachedInterpreter sources are unavailable"
  : process.platform === "win32" && !existsSync(compiler)
    ? "pinned native clang++ is unavailable"
    : false;

async function interpreterSource() {
  return (await readFile(sourcePath, "utf8")).replaceAll("\r\n", "\n");
}

function between(source, first, next) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, `actual source seam: ${first}`);
  return source.slice(start, end);
}

function matchOne(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `one actual ${label}`);
  return matches[0][0];
}

function compileAndRun(name, source) {
  const temporaryRoot = resolve(tmpdir());
  const work = mkdtempSync(join(temporaryRoot, "wasm-dolphin-deferred-"));
  const input = join(work, `${name}.cpp`);
  const executable = join(work, process.platform === "win32" ? `${name}.exe` : name);
  try {
    writeFileSync(input, source);
    const compile = spawnSync(compiler, [
      "-std=c++20", "-O2", ...(process.platform === "win32" ? [] : ["-pthread"]),
      "-I", sourceDirectory, input, "-o", executable,
    ], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(compile.status, 0,
      [compile.error?.message, compile.stderr, compile.stdout].filter(Boolean).join("\n"));
    const run = spawnSync(executable, [], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0,
      [run.error?.message, run.stderr, run.stdout].filter(Boolean).join("\n"));
  } finally {
    assert.equal(dirname(resolve(work)), temporaryRoot, "cleanup stays in the temporary directory");
    assert.ok(basename(work).startsWith("wasm-dolphin-deferred-"));
    rmSync(work, { recursive: true, force: true });
  }
}

sourceContractTest("actual deferred queue and retry helper preserve replacement blocks and bound each drain", {
  skip: nativeSkip,
}, async () => {
  const source = await interpreterSource();
  const retry = between(source, "void RetryDeferredWasmBlocks(CachedInterpreter& cpu)\n{",
    "\nbool s_wasm_jit_direct_only");
  const budget = matchOne(source, /constexpr u32 COMPILE_THROTTLE_MAX_PER_SLICE = \d+;/g,
    "compile budget");
  const queues = matchOne(source,
    /std::unordered_map<const CachedInterpreter\*, DeferredJit::Queue> s_deferred_wasm_queues;/g,
    "per-interpreter queue declaration");
  compileAndRun("queue", String.raw`
#include "WasmDeferredCompileQueue.h"
#include <atomic>
#include <cassert>
#include <map>
#include <utility>
#include <vector>
using u32 = std::uint32_t;
enum CPUEmuFeatureFlags : u32 {};
using Key = std::pair<u32, u32>;
struct Block { u32 address, features; const void* normalEntry; };
struct BlockCache {
  std::map<Key, Block> blocks;
  std::vector<Key> erased;
  Block* GetBlockFromStartAddress(u32 address, CPUEmuFeatureFlags features) {
    const auto found = blocks.find({address, static_cast<u32>(features)});
    return found == blocks.end() ? nullptr : &found->second;
  }
  void EraseSingleBlock(const Block& block) {
    const Key key{block.address, block.features};
    erased.push_back(key);
    assert(blocks.erase(key) == 1);
  }
  void Put(u32 address, u32 features, const void* entry) {
    blocks.insert_or_assign(Key{address, features}, Block{address, features, entry});
  }
};
struct CachedInterpreter {
  BlockCache cache;
  BlockCache* GetBlockCache() { return &cache; }
};
bool s_wasm_jit_enabled = true;
// Off-thread compiles (patch 0074): off here, the retry helper skips them.
std::atomic<bool> s_wasm_off_thread_compile{false};
static void RetryOffThreadWasmBlocks(CachedInterpreter&) {}
${budget}
${queues}
${retry}
int main() {
  int old_entry = 0, replacement = 0;
  DeferredJit::Queue queue;
  std::vector<DeferredJit::Entry> drained;
  auto record = [&](const DeferredJit::Entry& entry) { drained.push_back(entry); };

  // A duplicate changes its payload without changing queue size or order.
  queue.Defer(4, 1, &old_entry);
  queue.Defer(4, 1, &replacement);
  queue.Defer(4, 2, &old_entry);
  assert(queue.Pending() == 2 && queue.Stored() == 2);
  queue.Drain(0, record);
  assert(drained.empty() && queue.Pending() == 2);
  queue.Drain(1, record);
  assert(drained.size() == 1 && drained[0].features == 1 &&
         drained[0].normal_entry == &replacement && queue.Stored() == 1);
  queue.Drain(1, record);
  assert(drained.size() == 2 && drained[1].features == 2 && queue.Empty());

  // Replacing a block at the same arena address cancels its obsolete request.
  queue.Defer(8, 1, &old_entry);
  queue.Recompiled(8, 1);
  queue.Drain(8, record);
  assert(drained.size() == 2 && queue.Stored() == 0);
  for (u32 i = 0; i < 10000; ++i) {
    queue.Defer(8, 1, &old_entry);
    queue.Recompiled(8, 1);
  }
  assert(queue.Stored() == 0 && queue.Pending() == 0);
  queue.Defer(8, 1, &old_entry);
  queue.Recompiled(8, 1);
  queue.Defer(8, 1, &old_entry);
  queue.Drain(1, record);
  assert(drained.size() == 3 && queue.Empty());

  // A reset discards pending work, including identical reused pointer values.
  queue.Defer(12, 0, &old_entry);
  queue.Clear();
  queue.Drain(8, record);
  assert(drained.size() == 3 && queue.Pending() == 0 && queue.Stored() == 0);
  queue.Defer(0xfffffffc, 0xffffffff, &old_entry);
  queue.Defer(0xfffffffc, 0, &replacement);
  assert(queue.Pending() == 2);
  queue.Clear();

  // Run the actual production retry helper against a minimal block-cache seam.
  CachedInterpreter cpu, other;
  cpu.cache.Put(16, 1, &replacement);
  cpu.cache.Put(20, 1, &old_entry);
  s_deferred_wasm_queues[&cpu].Defer(16, 1, &old_entry); // pointer replaced
  s_deferred_wasm_queues[&cpu].Defer(24, 1, &old_entry); // externally invalidated
  s_deferred_wasm_queues[&cpu].Defer(20, 1, &old_entry);
  s_deferred_wasm_queues[&cpu].Recompiled(20, 1); // same-pointer replacement
  RetryDeferredWasmBlocks(cpu);
  assert(cpu.cache.erased.empty() && cpu.cache.blocks.size() == 2);
  assert(s_deferred_wasm_queues.count(&cpu) == 0);

  // Address/feature pairs and interpreter owners remain independent.
  cpu.cache.Put(28, 1, &old_entry);
  cpu.cache.Put(28, 2, &replacement);
  other.cache.Put(28, 1, &old_entry);
  s_deferred_wasm_queues[&cpu].Defer(28, 1, &old_entry);
  s_deferred_wasm_queues[&other].Defer(28, 1, &old_entry);
  RetryDeferredWasmBlocks(cpu);
  assert(cpu.cache.blocks.count(Key{28, 1}) == 0);
  assert(cpu.cache.blocks.count(Key{28, 2}) == 1);
  assert(other.cache.blocks.count(Key{28, 1}) == 1);
  assert(s_deferred_wasm_queues.count(&other) == 1);

  const auto erased_before = cpu.cache.erased.size();
  const u32 count = COMPILE_THROTTLE_MAX_PER_SLICE + 3;
  for (u32 i = 0; i < count; ++i) {
    cpu.cache.Put(100 + i * 4, 0, &old_entry);
    s_deferred_wasm_queues[&cpu].Defer(100 + i * 4, 0, &old_entry);
  }
  RetryDeferredWasmBlocks(cpu);
  assert(cpu.cache.erased.size() == erased_before + COMPILE_THROTTLE_MAX_PER_SLICE);
  assert(s_deferred_wasm_queues.at(&cpu).Pending() == 3);
  assert(s_deferred_wasm_queues.at(&cpu).Stored() == 3);
  RetryDeferredWasmBlocks(cpu);
  assert(s_deferred_wasm_queues.count(&cpu) == 0);

  // Disabled JIT discards retry requests without deleting native fallbacks.
  s_wasm_jit_enabled = false;
  RetryDeferredWasmBlocks(other);
  assert(s_deferred_wasm_queues.count(&other) == 0);
  assert(other.cache.blocks.count(Key{28, 1}) == 1);
}
`);
});

sourceContractTest("actual policy setter defers cache changes to the CPU between callbacks", {
  skip: nativeSkip,
}, async () => {
  const source = await interpreterSource();
  const policy = between(source, "namespace\n{\nvoid ApplyRequestedWasmPolicy(CachedInterpreter& cpu)",
    '\nextern "C" void SetPpcProfileEnabled');
  const declarations = between(source, "bool s_wasm_jit_enabled = false;",
    "\n// All accesses are on the owning CPU thread.");
  const directOnly = matchOne(source, /bool s_wasm_jit_direct_only = true;/g, "effective tier declaration");
  const resets = [...policy.matchAll(/\b(s_fast_\w+) = (false|0);/g)];
  assert.ok(resets.length > 0, "actual policy invalidates verified helper state");
  const helperDeclarations = resets.map(([, name, value]) =>
    `${value === "false" ? "bool" : "u32"} ${name} = 1;`).join("\n");
  const resetAssertions = resets.map(([, name]) => `assert(${name} == 0);`).join("\n");
  const dirtyHelpers = resets.map(([, name]) => `${name} = 1;`).join("\n");
  compileAndRun("policy", String.raw`
#include <atomic>
#include <cassert>
#include <thread>
using u32 = unsigned;
struct CachedInterpreter {
  const std::thread::id owner = std::this_thread::get_id();
  int clears = 0, cached_callbacks = 4;
  bool callback_active = false;
  void ClearCache() {
    assert(std::this_thread::get_id() == owner);
    assert(!callback_active);
    ++clears;
    cached_callbacks = 0;
  }
};
namespace {
${declarations}
${directOnly}
${helperDeclarations}
}
${policy}
void RequestFromHost(int requested) {
  std::thread host([=] { SetPpcWasmJitEnabled(requested); });
  host.join();
}
int main() {
  CachedInterpreter cpu, other;
  ApplyRequestedWasmPolicy(cpu);
  assert(cpu.clears == 1 && !s_wasm_jit_enabled);

  cpu.cached_callbacks = 7;
  cpu.callback_active = true;
  RequestFromHost(1);
  assert(cpu.clears == 1 && cpu.cached_callbacks == 7 && !s_wasm_jit_enabled);
  assert(s_applied_wasm_policy.load() == 0);
  cpu.callback_active = false;
  ApplyRequestedWasmPolicy(cpu);
  assert(cpu.clears == 2 && cpu.cached_callbacks == 0 && s_wasm_jit_enabled);
  assert(s_wasm_jit_direct_only && s_applied_wasm_policy.load() == 1);
  ${resetAssertions}

  RequestFromHost(1);
  ApplyRequestedWasmPolicy(cpu);
  assert(cpu.clears == 2);
  cpu.cached_callbacks = 8;
  RequestFromHost(2);
  assert(s_wasm_jit_direct_only && cpu.cached_callbacks == 8);
  ApplyRequestedWasmPolicy(cpu);
  assert(cpu.clears == 3 && cpu.cached_callbacks == 0 && !s_wasm_jit_direct_only);

  cpu.cached_callbacks = 9;
  RequestFromHost(0);
  assert(s_wasm_jit_enabled && cpu.cached_callbacks == 9);
  ApplyRequestedWasmPolicy(cpu);
  assert(cpu.clears == 4 && cpu.cached_callbacks == 0 && !s_wasm_jit_enabled);
  assert(s_applied_wasm_policy.load() == 0);

  // Requests describe the latest policy, not commands to mutate active code.
  RequestFromHost(2);
  RequestFromHost(0);
  ApplyRequestedWasmPolicy(cpu);
  assert(cpu.clears == 4 && !s_wasm_jit_enabled);
  RequestFromHost(1);
  ApplyRequestedWasmPolicy(cpu);
  ${dirtyHelpers}
  ApplyRequestedWasmPolicy(other);
  assert(other.clears == 1 && other.cached_callbacks == 0 && s_wasm_policy_owner == &other);
  ${resetAssertions}
}
`);
});

sourceContractTest("actual helper-stat cache refreshes tier text with every activity counter unchanged", {
  skip: nativeSkip,
}, async () => {
  const source = await interpreterSource();
  const getter = between(source, 'extern "C" const char* GetPpcWasmHelperStats()', '\nextern "C"');
  assert.doesNotMatch(getter, /\bs_wasm_jit_(direct_only|enabled)\b/,
    "host getter must not read CPU-owned policy booleans");
  assert.equal([...getter.matchAll(/s_applied_wasm_policy\.load\(/g)].length, 1,
    "cache decision and formatting share one policy snapshot");
  const prefix = between(getter, 'extern "C" const char* GetPpcWasmHelperStats()',
    "  std::vector<std::pair<u32, u32>> hot_keys;");
  const formatter = matchOne(getter, /^  out << \(applied_policy < 2 \? "tier:guarded " : "tier:mixed "\);$/gm,
    "tier formatter");
  const appliedDeclaration = matchOne(source, /std::atomic<int> s_applied_wasm_policy\{0\};/g,
    "published policy declaration");
  const names = [...new Set(prefix.match(/\bs_[a-zA-Z0-9_]+/g))]
    .filter((name) => name !== "s_applied_wasm_policy");
  compileAndRun("stats", String.raw`
#include <atomic>
#include <cassert>
#include <sstream>
#include <string>
using u32 = unsigned;
using u64 = unsigned long long;
struct JitFallbackDispatchStats { u64 hit = 0, empty_miss = 0, collision_miss = 0; };
JitFallbackDispatchStats GetJitFallbackDispatchStats() { return {}; }
${appliedDeclaration}
${names.map((name) => `u32 ${name} = 0;`).join("\n")}
${prefix}
  std::ostringstream out;
${formatter}
  stats = out.str();
  return stats.c_str();
}
int main() {
  s_applied_wasm_policy.store(1, std::memory_order_release);
  assert(std::string(GetPpcWasmHelperStats()) == "tier:guarded ");
  assert(std::string(GetPpcWasmHelperStats()) == "tier:guarded ");
  s_applied_wasm_policy.store(2, std::memory_order_release);
  assert(std::string(GetPpcWasmHelperStats()) == "tier:mixed ");
  s_applied_wasm_policy.store(1, std::memory_order_release);
  assert(std::string(GetPpcWasmHelperStats()) == "tier:guarded ");
}
`);
});

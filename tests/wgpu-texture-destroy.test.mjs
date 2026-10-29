// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// 0202: a destroyed WebGPUTexture takes its consumer-side GPUTexture with it.
// Dolphin's texture cache drops a texture unused for 64 frames (then 3 more
// in its pool); ~WebGPUTexture sent nothing, so the worker's texture map kept
// every texture ever created (~6 a second in a race, 964 after 135 s).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const native = "vendor/dolphin/Source/Core/VideoBackends/WebGPU/";
const compiler = process.platform === "win32" ? join(process.env.USERPROFILE ?? "", "emsdk/upstream/bin/clang++.exe") : "clang++";
const hasVendor = existsSync(join(root, native, "WebGPUGfx.cpp"));
const skip = !hasVendor ? `requires patched vendor source: ${native}`
  : spawnSync(compiler, ["--version"], { encoding: "utf8" }).status !== 0 ? `requires native C++ compiler: ${compiler}` : false;

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `native source seam: ${startMarker}`);
  return source.slice(start, end);
}

function checkSources(gfx, header, texture) {
  // The texture retires its id on destruction (never while the backend shuts down).
  assert.match(texture, /WebGPUTexture::~WebGPUTexture\(\)\n\{[\s\S]*?if \(m_bridge_id != 0 && g_gfx\)\n\s+static_cast<WebGPUGfx\*>\(g_gfx\.get\(\)\)->RetireTexture\(m_bridge_id\);\n\}/);
  // Unbound from every stage, retired, and destroyed between passes with tag 2.
  assert.match(gfx, /static constexpr u32 kDestroyTagTexture = 2;/);
  assert.match(gfx, /void WebGPUGfx::RetireTexture\(u32 bridge_id\)\n\{[\s\S]*?for \(u32& texture : m_tex_id\)[\s\S]*?texture = 0;[\s\S]*?m_retired_textures\.push_back\(bridge_id\);\n\}/);
  assert.match(gfx, /void WebGPUGfx::DestroyRetiredTextures\(\)\n\{[\s\S]*?if \(m_pass_open \|\| m_retired_textures\.empty\(\)\)\n\s+return;\n\s+for \(const u32 id : m_retired_textures\)\n\s+m_cmd_stream\.PushDestroy\(kDestroyTagTexture, id\);\n\s+m_retired_textures\.clear\(\);/);
  // At both pass ends, after the bind groups.
  assert.equal((gfx.match(/DestroyRetiredBindGroups\(\);\n\s+DestroyRetiredTextures\(\);/g) ?? []).length, 2);
  assert.match(header, /std::vector<u32> m_retired_textures;/);
  assert.match(header, /void RetireTexture\(u32 bridge_id\);/);
}

test("0202: the patch retires a destroyed texture and destroys it at the pass end", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0202-webgpu-destroy-freed-textures.patch");
  const added = (file) => patch.split(/^diff --git /m).find((p) => p.startsWith(`a/Source/Core/VideoBackends/WebGPU/${file}`))
    .split("\n").filter((l) => l.startsWith("+") || l.startsWith(" ")).map((l) => l.slice(1)).join("\n");
  assert.match(added("WebGPUTexture.cpp"), /RetireTexture\(m_bridge_id\)/);
  assert.match(added("WebGPUGfx.cpp"), /PushDestroy\(kDestroyTagTexture, id\)/);
  assert.match(added("WebGPUGfx.h"), /std::vector<u32> m_retired_textures;/);
});

sourceContractTest("0202: the patched vendor tree retires destroyed textures and destroys them between passes", async () => {
  checkSources(await read(`../${native}WebGPUGfx.cpp`), await read(`../${native}WebGPUGfx.h`), await read(`../${native}WebGPUTexture.cpp`));
});

sourceContractTest("0202: retired textures are unbound, destroyed once, only outside a pass (counted natively)", { skip }, () => {
  const gfx = readFileSync(join(root, native, "WebGPUGfx.cpp"), "utf8").replace(/\r\n/g, "\n");
  const code = between(gfx, "static constexpr u32 kDestroyTagTexture", "bool WebGPUGfx::EndPassIfOpen()");
  const directory = mkdtempSync(join(tmpdir(), "wgpu-texture-destroy-"));
  const source = join(directory, "main.cpp");
  const executable = join(directory, "texdestroy");
  writeFileSync(source, String.raw`
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <set>
#include <vector>
using u32 = std::uint32_t;
struct CommandStream {
  bool pass_open = false;
  u32 in_pass = 0;
  std::set<u32> destroyed;
  bool PushDestroy(u32 tag, u32 id) {
    assert(tag == 2);
    if (pass_open) ++in_pass;
    assert(destroyed.insert(id).second);
    return true;
  }
};
class WebGPUGfx {
public:
  u32 m_tex_id[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  bool m_pass_open = false;
  std::vector<u32> m_retired_textures;
  CommandStream m_cmd_stream;
  void RetireTexture(u32 bridge_id);
  void DestroyRetiredTextures();
};
${code}
int main() {
  WebGPUGfx gfx;
  gfx.m_pass_open = gfx.m_cmd_stream.pass_open = true;
  for (u32 i = 0; i < 8; ++i) gfx.m_tex_id[i] = 100 + (i % 2);  // two textures bound on 8 stages
  for (u32 id = 100; id < 400; ++id) {
    gfx.RetireTexture(id);
    gfx.DestroyRetiredTextures();  // refused: the pass is open
  }
  gfx.RetireTexture(0);  // never a destroy for id 0
  for (u32 i = 0; i < 8; ++i) assert(gfx.m_tex_id[i] == 0);  // unbound everywhere
  assert(gfx.m_cmd_stream.destroyed.empty() && gfx.m_retired_textures.size() == 300);
  gfx.m_pass_open = gfx.m_cmd_stream.pass_open = false;
  gfx.DestroyRetiredTextures();
  assert(gfx.m_retired_textures.empty() && gfx.m_cmd_stream.in_pass == 0);
  assert(gfx.m_cmd_stream.destroyed.size() == 300 && gfx.m_cmd_stream.destroyed.count(0) == 0);
  std::printf("destroyed %zu\n", gfx.m_cmd_stream.destroyed.size());
  return 0;
}
`);
  try {
    const build = spawnSync(compiler, ["-std=c++20", "-O0", source, "-o", executable], { encoding: "utf8", timeout: 120_000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(executable, [], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /destroyed 300/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

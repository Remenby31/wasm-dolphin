// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The block module's helper imports, declared in three places of the patched
// core that must agree: the import section BuildWasmCachedInterpreterBlock
// emits (EmitEnvFunctionImport and its type section), the C++ functions the
// JS glue hands over for them (DolphinWeb_CachedInterpreter*), and the table
// DolphinWeb_JitHelperSignature reports to the AOT region assembler
// (src/aot-orchestrator.js coreAssembleOptions). Patch 0196 removed four
// imports and left that table in the old order: fma was reported as an i32
// helper and every region calling it failed to validate, with nothing
// failing (2026-11-01). This reads all three and compares every import.

import assert from "node:assert/strict";
import { join } from "node:path";
import { readVendorFileSync, sourceContractTest, vendorSourceRoot } from "./helpers/source-contract.mjs";

const source = readVendorFileSync(join(vendorSourceRoot, "Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp"));

const VALTYPE = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64" };
const CTYPE = { int: "i32", u32: "i32", s32: "i32", u16: "i32", u8: "i32", bool: "i32", u64: "i64", s64: "i64", float: "f32", double: "f64" };

function after(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `missing ${marker}`);
  return text.slice(at);
}

// "params>results" of a type section entry {0x60, n, params..., m, results...}.
function sigOfFuncType(bytes) {
  assert.equal(bytes[0], 0x60, "a function type");
  const n = bytes[1];
  const params = bytes.slice(2, 2 + n).map((b) => VALTYPE[b]);
  const m = bytes[2 + n];
  const results = bytes.slice(3 + n, 3 + n + m).map((b) => VALTYPE[b]);
  assert.equal(bytes.length, 3 + n + m, "nothing after the results");
  return `${params.join(",")}>${results.join(",")}`;
}

// The block module's declarations: [{ name, sig }] in import order.
export function declaredImports(text) {
  const build = after(text, "std::vector<u8> BuildWasmCachedInterpreterBlock(");
  const typeLines = [...build.slice(0, build.indexOf("EmitSection(bytes, 1, types);"))
    .matchAll(/types\.insert\(types\.end\(\), \{([^}]*)\}\);/g)];
  const types = typeLines.map((m) => sigOfFuncType(m[1].split(",").map((x) => Number(x.trim()))));
  const typeCount = /types\.push_back\((0x[0-9a-f]+)\);/.exec(build);
  assert.equal(Number(typeCount[1]), types.length, "type section count");
  const section = build.slice(build.indexOf("std::vector<u8> imports;"), build.indexOf('EmitName(imports, "env");'));
  const imports = [...section.matchAll(/EmitEnvFunctionImport\(imports, "(\w+)", (\d+)\);/g)]
    .map((m) => ({ name: m[1], sig: types[Number(m[2])] }));
  const importCount = /imports\.push_back\((0x[0-9a-f]+)\);/.exec(section);
  assert.equal(Number(importCount[1]), imports.length + 1, "import count: the helpers and the memory");
  return imports;
}

export function importNames(text) {
  const m = /WASM_IMPORT_NAMES = \{([^}]*)\};/.exec(text);
  assert.ok(m, "WASM_IMPORT_NAMES");
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
}

// DolphinWeb_JitHelperSignature's answer for every index until it says null.
export function reportedSignatures(text) {
  const body = after(text, "DolphinWeb_JitHelperSignature(u32 index)");
  const fn = body.slice(0, body.indexOf("\n}\n"));
  const types = [.../TYPES = \{([^}]*)\};/.exec(fn)[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  const typeOf = /TYPE_OF = \{([^}]*)\};/.exec(fn)[1].split(",").map((x) => x.trim()).filter(Boolean).map(Number);
  return typeOf.map((t) => types[t]);
}

// The C++ function behind each helper (the JS glue's wasmTable.get of its
// address) and its wasm signature.
export function prototypeSignatures(text, names) {
  const fnOf = Object.fromEntries([...text.matchAll(/const auto (\w+)_index = static_cast<int>\(\s*reinterpret_cast<std::uintptr_t>\(&(\w+)\)\);/g)]
    .map((m) => [m[1], m[2]]));
  const out = {};
  for (const name of names) {
    const fn = fnOf[name] ?? `DolphinWeb_CachedInterpreter${name[0].toUpperCase()}${name.slice(1)}`;
    const proto = new RegExp(`extern "C" (\\w+) ${fn}\\(([^)]*)\\)`).exec(text);
    assert.ok(proto, `prototype of ${fn} (${name})`);
    const params = proto[2].split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const type = p.split(/\s+/)[0];
      assert.ok(type in CTYPE, `${fn}: parameter type ${type}`);
      return CTYPE[type];
    });
    const result = proto[1] === "void" ? "" : CTYPE[proto[1]];
    assert.ok(result !== undefined, `${fn}: return type ${proto[1]}`);
    out[name] = `${params.join(",")}>${result}`;
  }
  return out;
}

sourceContractTest("every helper import agrees across the import section, its C++ function and DolphinWeb_JitHelperSignature", () => {
  const declared = declaredImports(source);
  assert.ok(declared.length >= 10, `the import section was read (${declared.length})`);
  const names = importNames(source);
  assert.deepEqual(names, declared.map((d) => d.name), "WASM_IMPORT_NAMES is the import section's order");
  const prototypes = prototypeSignatures(source, names);
  for (const { name, sig } of declared) assert.equal(prototypes[name], sig, `${name}: declared ${sig}, its C++ function is ${prototypes[name]}`);
  const reported = reportedSignatures(source);
  assert.equal(reported.length, declared.length, "DolphinWeb_JitHelperSignature answers for exactly the imports");
  declared.forEach(({ name, sig }, i) => assert.equal(reported[i], sig, `index ${i} (${name}): reported ${reported[i]}, declared ${sig}`));
});

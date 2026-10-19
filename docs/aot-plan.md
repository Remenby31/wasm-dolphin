# Ahead-of-time code discovery and the compilation plan

Track 3 of the CPU roadmap translates the user's game to WASM on first launch.
It has two parts with an interface between them:

- **Discovery** (this document, `src/aot-*.js`): finds the guest code ahead of
  time, in the browser, from the user's own disc. Output: a *compilation plan*.
- **Region compiler** (JIT agent): compiles PowerPC regions to WASM, ahead of
  time from the plan or on the fly when the guest reaches code the plan does
  not know.

The plan holds addresses, edges and fingerprints. It never holds guest bytes,
so it can be cached, dropped or rebuilt at any time. **Whatever the plan
misses or gets wrong stays the JIT's job**: a region whose fingerprint does
not match guest memory is ignored, an address absent from the plan is
compiled on the fly as today.

Status of the interface: v1 agreed with the region compiler (2026-10-18). The
compiler re-decodes guest memory itself and only takes the plan as advice:
region entries, outside entries, compile order. Consumer side pending.

## Pipeline

```
disc File ──► aot-disc.js   DOL, apploader, RELs (FST)       no copy, read in place
          ──► aot-image.js  sections at their load addresses
          ──► aot-discovery.js
                wave 0  recursive descent from roots (entry point, calls,
                        jump tables, constant indirect calls, hints, profile)
                wave 1  code addresses built by lis/addi|ori, code pointers
                        in data (vtables, callbacks, .ctors); speculative
                wave 2  gaps between known code that decode as functions;
                        speculative
          ──► aot-plan.js   functions → regions, FNV-1a 64 fingerprints
          ──► aot-rel.js    RELs: (section, offset) plan, relocated when
                            OSLink has linked the module
```

`planDisc(read, { profile, hints })` in `src/aot-recomp.js` runs it all;
`tools/aot-plan.mjs` runs the same code from the command line.

Speculative candidates (waves 1 and 2), hint-sheet entries and profile
blocks are walked on trial first and kept only if every instruction reached
is a valid Gekko instruction inside an executable section and no branch
leaves the image. Hint and profile roots are tried after static discovery
and only where it found no code: a profile block inside a known function
adds nothing (it does not split the function), it only counts toward that
region's `profileHits`. A wrong guess costs a useless compile, never a wrong
execution: the guest decides what runs.

Bounds, so a hostile disc cannot make the analysis allocate or loop without
limit (a refused input means no plan, the JIT runs the game as today):
executables (DOL, apploader, each REL) ≤ 24 MiB, ≤ 256 RELs and 64 MiB of
RELs in total, FST ≤ 16 MiB with its entry count capped by its size, names
≤ 255 bytes, directory depth ≤ 32. Sections of a DOL or REL must not share
file bytes, an image holds ≤ 4 MiB of code (measured games: ~3 MiB) and
≤ 24 MiB in all, and discovery stops past 400 000 blocks (a game: ~150 000).
REL relocation records read in total ≤ file size / 8 (imports sharing a run
are refused). Speculative walks share a budget of 32 instructions per
executable word (a real disc uses under one); addresses whose straight-line
walk ends on invalid code and rejected candidates are remembered; each code
word is scanned for a lis/addi constant once (8-instruction window), the
data once. Worst cases measured on an M4 Pro: ~0.5 s and ~500 MiB at the
4 MiB bound (tests/aot-hostile.test.mjs).

### Jump tables

At an unconditional `bctr` the discovery slices backwards (straight-line code,
40 instructions, then a second chance that crosses unconditional `b` with a
256-instruction window for a base kept in a non-volatile register):

| Shape | Typical compiler | Table entry |
| --- | --- | --- |
| `lis/addi rB; slwi rI,rX,2; lwzx rC,rB,rI; mtctr rC; bctr` | CodeWarrior | absolute address (`kind: "abs"`) |
| `lwzx rT,rB,rI; add rC,rT,rB; mtctr rC; bctr` | GCC | offset from the table (`kind: "rel"`) |
| `add rX,rB,rI; lwz rC,d(rX); mtctr rC; bctr` | both | absolute |

The bound comes from the `cmplwi rX,N` that guards the switch (`bgt` keeps
`N`, `bge` excludes it: `bound: "cmplwi"`). Without it the table is read
while entries are code within ±64 KiB of the site, at most 512 entries
(`bound: "scan"`). A bounded table whose entries are not all code is
rejected. `bctrl`/`blrl` whose target is a lis/addi constant become direct
calls; everything else is listed in `indirectSites` and left to the JIT.

## Plan format `salon-aot-plan/1`

JSON. Columns are flat arrays (one entry per block/edge) to keep it small.

```js
{
  schema: "salon-aot-plan/1",
  analyzer: 2,                       // bump when discovery changes its output; validatePlan refuses others
  hash: "fnv1a64",                   // fingerprint algorithm, see below
  disc: { gameId: "GXXE01", dolHash: "<fnv1a64 of the DOL file>" },
  hints: null | { name, entries },  // hint sheet applied, if any
  identity: { dolHash, apploaderHash, rels: [{ path, hash }], profileHash, hintsHash },
                                     // every input of the plan: a cached plan is reused only for the same
  modules: [                         // code at fixed addresses
    {
      id: 0 | 1 | 0x100 + relId,     // DOL, apploader, linked REL
      kind: "dol" | "apploader" | "rel",
      blocks: { start: [u32], end: [u32], func: [i32] },   // [start, end), end exclusive
      edges:  { from: [blockIdx], to: [blockIdx], kind: [EDGE] },
      functions: [{ entry, confidence, sources: [str], flags, ranges: [[start, end]],
                    extraEntries: [u32], profileHits, hash, sha256 }],
      jumpTables: [{ site, table, count, kind: "abs"|"rel", targets: [u32], bound: "cmplwi"|"scan"|"hint" }],
      indirectSites: [{ site, kind: "bctr"|"bctrl"|"bcctr"|"blrl", resolved: [u32] | null }],
      stats: { blocks, functions, codeBytes, execBytes, rejectedCandidates }
    }
  ],
  rels: [ /* REL modules not linked yet, see below */ ],
  dynamic: [{ start, end, mode: "virt"|"real", source: "profile"|"hint" }]  // code outside any module
}
```

- **Addresses** are effective addresses (`0x8xxxxxxx`, BAT-mapped as games
  use them). Code the profile saw in real mode (exception vectors at
  `0x00000500`...) is kept under `dynamic` with `mode: "real"`; the mode is
  recorded, never inferred from the address.
- **Blocks** end after every branch, including `bl` (the return address
  starts a block), `sc`, `rfi` and traps, and before every branch target.
  Sorted, disjoint, per module.
- **Edges** (`EDGE` in `aot-discovery.js`): `0 fall`, `1 branch`, `2 cond`,
  `3 call`, `4 tail` (unconditional `b` to another function's entry),
  `5 table`, `6 indirect` (resolved constant `bctr`).
- **Functions = regions**, the unit of compilation: one entry, the blocks
  reachable from it without crossing a call or another entry, their merged
  `ranges`, and `hash`. The compiler may split or merge them.
- **`extraEntries`**: addresses inside the region reached from outside it
  that the compiler cannot infer from the code: jump-table targets, resolved
  indirect targets, code pointers (data words, lis/addi constants). Return
  points after an internal `bl` are not listed.
- **`flags`**: bit0 real mode (IR=0), others reserved.
- **`profileHits`**: profile blocks inside the region, weighted by the number
  of sessions that ran them.
- **Confidence** (lower is surer): `0` root (entry point, call target,
  jump-table target), `1` code pointer (data word or lis/addi constant) or
  hint-sheet entry, `2` gap filling, `3` profile only.
- **Compile order** (`orderedRegions`): `profileHits` descending, then
  confidence, then size ascending. The binary is written in that order.

### Fingerprint

`hash` = FNV-1a 64 over the guest bytes of `ranges`, in memory (big-endian)
order, ranges ascending: offset basis `0xcbf29ce484222325`, prime
`0x100000001b3`, as 16 lowercase hex digits. Reference values are in
`tests/aot-plan.test.mjs`.

`sha256` = SHA-256 of the same bytes in the same order (64 lowercase hex).
It is the identity of the region in the persistent cache: FNV-1a 64 is the
fast check, not collision resistant across disc revisions, and the disc key
does not cover RELs.

One cache entry is one assembled module: a group of up to ~100 functions
(`groupRegions`, `assembleRegion` in `src/aot-region-module.js`). Its key
(`regionModuleKey`, decided 2026-10-19), from `_DolphinWeb_AotKeyParts`:
`region-v1:<compilerVersion, 8 hex>:<codegenMask, 8 hex>:<sha256>`, where
`<sha256>` is the SHA-256 of the members in module order, written
`<entry hex>:<member sha256>;` each. A change in any member's guest code, in
membership or in order gives another key; it ends in `:` + 64 hex as the
cache requires (`isHashedAotKey`). The optimiser's `bootKeys()` returns these
module keys, in compile order.

Before compiling a region ahead of time, and before reusing a cached module
for it, the compiler re-hashes guest memory over `ranges`. Different hash:
the region is skipped and the JIT handles that code as today. This covers
code patched by the game, a different disc revision, and a stale cache.

### Binary regions for the core

`encodePlanRegions(plan)` (u32 little-endian), for a consumer that only needs
the regions:

```
"SAOTPLN1", u32 version = 1, u32 regionCount, u32 reserved
per region, in compile order:
  u32 module, u32 entry, u32 confidence, u32 flags, u32 hashHi, u32 hashLo,
  u32 rangeCount, rangeCount x (u32 start, u32 end),
  u32 extraEntryCount, extraEntryCount x u32
```

The worker passes it to the core through `_DolphinWeb_AotLoadPlan(ptr, len)`
(region compiler); the core compiles in buffer order under its budget. The
worker keeps the rest: JSON, REL relocation, profile order. Jump-table
contents are never baked into compiled code (`bctr` reads CTR at run time),
so the fingerprint covers `ranges` only.

## REL modules (OSLink)

A REL's load address is only known once `OSLink` has linked it. Discovery
places section `i` at a synthetic `0xa0000000 + i * 0x01000000`, applies the
module's relocations against itself (synthetic) and against the DOL
(absolute). A call relocated against another REL is pointed out of the image
(`bla 0`) so it is not read as `bl .`; such words are masked in `moduleHash`. The plan
entry stores `(section, offset)` pairs:

```js
{ kind: "rel", relId, name, moduleHash,
  sections: [{ index, size, exec, bss, relocWords: [offset] }],
  blocks: { section: [], start: [], end: [], func: [] },
  functions: [{ section, entry, confidence, sources, extraEntries: [[section, off]], ranges: [[section, start, end]] }],
  jumpTables: [{ site: [section, off], count, targets: [[section, off]] }], ... }
```

At run time `readLinkedModules(read32)` walks the OS module list
(`0x800030c8` head, `+0x04` next, `+0x0c` section count, `+0x10` section
table, which OSLink turns into absolute addresses) and
`relocateModulePlan(relPlan, linked, read32)` returns an absolute module, or
`null` when the linked module is not the planned one: `moduleHash` is
FNV-1a 64 over the executable sections with every relocated word zeroed, so
it does not depend on the load address. Region hashes of the relocated module
are computed from guest memory right after linking. When to poll the list
(each OSLink, or on a JIT miss in heap memory) belongs to the consumer.

## Profile of earlier sessions

`aot-profile.js`. Per disc key, OPFS file `aot-profile/<key>.bin`
(little-endian):

```
"SAOTPRF2", u32 version = 2, u32 sessions, 8 bytes gameId, 8 bytes dolHash,
u32 count, count x (u32 start, u32 end, u16 seen, u16 flags)
```

`seen` counts the sessions that ran the block, `flags` bit0 = real mode. A
profile recorded for another DOL under the same key is ignored on load and
replaced on record. Writes go through `navigator.locks`
(`salon-aot-profile:<key>.bin`) so two tabs do not lose a session. Overlapping
blocks of the same mode merge; adjacent blocks keep their own start, since
each start is an entry. Past 1 M blocks the least seen are dropped.

Sources of blocks: `blocksFromCoreDump(u32 triplets)` for
`_DolphinWeb_JitDumpBlocks(out, capacity)` (start, PPC byte length, flags:
bit0 executed, bit1 compiled, bit2 real mode; region compiler PR), called
periodically and at pause/exit since the block cache is cleared on some
events; or `blocksFromPcSamples(pcs)` for a PC sampler.

## Per-game hint sheets `salon-aot-hints/1`

Optional, data only, for one exact DOL. Entries are walked on trial like
code pointers (confidence 1) and can mark an entry inside code already found. **No sheet for a commercial game is
published in this repository**: users load their own (file picker, URL).

```json
{
  "schema": "salon-aot-hints/1",
  "name": "short label",
  "match": { "gameId": "GXXE01", "dolHash": "<fnv1a64 of the DOL>" },
  "entryPoints": ["0x80012340"],
  "notCode": [["0x80300000", "0x80300100"]],
  "jumpTables": [{ "site": "0x80045678", "table": "0x80340000", "count": 12, "kind": "abs" }],
  "dynamicCode": [["0x80001800", "0x80001900"]],
  "notes": "≤ 120 characters"
}
```

`parseHints` accepts only these fields, word-aligned 32-bit addresses (number
or `"0x…"`), ranges and short strings, and rejects anything else (unknown
field, byte strings, oversized arrays). A sheet whose `match` differs from the
disc is ignored (`loadHints` returns `null`).

## Measured (2026-10-18)

Static discovery of a commercial disc (DOL 3.4 MiB, 2.9 MiB of code): 0.6-0.9 s
in Node on an M4 Pro (1-2.6 s with the machine loaded, hashing included),
99.8 % of the text sections. Against decomp-toolkit on the same DOL: 13,310
of its 13,434 functions found as entries, 123 more as block starts, 1 missing;
its 299 jump tables all found with the same size.

Coverage of the code actually run, measured with
`harness/probes/aot-coverage.mjs`, through the harness's guest-PC sampler
(`src/harness-pc-sampler.js`, PowerPCState.pc read from the shared heap). It sees the PC
where the core stores it, at block dispatch, so the unit that counts is the
**distinct PC**, an entry into compiled code. Time shares are dominated by
hot and idle loops and only given as a secondary figure.

| Scene recorded | Static only, distinct PCs (time) | Profile from | With profile |
| --- | --- | --- | --- |
| Race A, 20 s (26,570 PCs) | 99.959 % (99.84 %) | boot + attract mode | 100 % |
| Race B, other window, 30 s (28,926 PCs) | 99.962 % (99.84 %) | boot + attract mode | 100 % |
| Race B | | race A | 100 % |
| Attract mode, 40 s (12,599 PCs) | 99.913 % (99.90 %) | races A + B | 100 % |
| Early boot, 25 s (9,388 PCs) | 99.851 % (99.87 %) | attract mode + race A | 99.968 % |
| Homebrew GX scene, 25 s | 99.20 % (99.79 %) | | |
| Homebrew CPU fuzzer, 25 s | 26.9 % (95.2 %) | | (code generated at run time) |

Every PC the static plan misses on the commercial disc is in low memory:
exception vectors the OS copies there (run in real mode), plus 3 boot-time
PCs no other scene runs. The profile is applied across scenes (recorded on
menus, measured on a race and the other way round), so the 100 % is not the
profile replaying its own scene; on this disc its only contribution is those
vectors. Only one race savestate exists locally: the second race window is
the same track later in the race, not another track.

Precision: a race runs ~2,400 of the ~14,200 planned functions (~19,700 of
151,000 blocks). Compiling the whole plan ahead of time is ~6x the work the
race needs; the profile gives the compile order.

## Agreed with the region compiler

1. Region unit: the plan's function; the compiler splits very large ones and
   may merge. It always re-decodes guest memory.
2. Addresses: effective, plus an explicit real-mode flag.
3. Transport: binary regions to the core (`_DolphinWeb_AotLoadPlan`), the
   rest in the worker.
4. Fingerprint per region over `ranges`; run-time invalidation (icbi, writes
   to a 32-byte line of a region) is the compiler's.
5. Profile source: `_DolphinWeb_JitDumpBlocks`, delivered with the region
   compiler.

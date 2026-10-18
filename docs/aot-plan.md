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

Status of the interface: v1 proposed by discovery, consumer side pending in
the region compiler. Open points at the end.

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

Speculative candidates (waves 1 and 2) are walked on trial first and kept only
if every instruction reached is a valid Gekko instruction inside an executable
section and no branch leaves the image. A wrong guess costs a useless compile,
never a wrong execution: the guest decides what runs.

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
  analyzer: 1,                       // bump when discovery changes its output
  hash: "fnv1a64",                   // fingerprint algorithm, see below
  disc: { gameId: "GXXE01", dolHash: "<fnv1a64 of the DOL file>" },
  hints: null | { name, entries },  // hint sheet applied, if any
  modules: [                         // code at fixed addresses
    {
      id: 0, kind: "dol" | "apploader" | "rel",
      blocks: { start: [u32], end: [u32], func: [i32] },   // [start, end), end exclusive
      edges:  { from: [blockIdx], to: [blockIdx], kind: [EDGE] },
      functions: [{ entry, confidence, sources: [str], ranges: [[start, end]], hash }],
      jumpTables: [{ site, table, count, kind: "abs"|"rel", targets: [u32], bound: "cmplwi"|"scan"|"hint" }],
      indirectSites: [{ site, kind: "bctr"|"bctrl"|"bcctr"|"blrl", resolved: [u32] | null }],
      stats: { blocks, functions, codeBytes, execBytes, rejectedCandidates }
    }
  ],
  rels: [ /* REL modules not linked yet, see below */ ],
  dynamic: [{ start, end, source: "profile"|"hint" }]  // code seen outside any module
}
```

- **Addresses** are effective addresses (`0x8xxxxxxx`, BAT-mapped as games
  use them). Code the profile saw in real mode (exception vectors at
  `0x00000500`...) is kept under `dynamic` with its physical address.
- **Blocks** end after every branch, including `bl` (the return address
  starts a block), `sc`, `rfi` and traps, and before every branch target.
  Sorted, disjoint, per module.
- **Edges** (`EDGE` in `aot-discovery.js`): `0 fall`, `1 branch`, `2 cond`,
  `3 call`, `4 tail` (unconditional `b` to another function's entry),
  `5 table`, `6 indirect` (resolved constant `bctr`).
- **Functions = regions**, the unit of compilation: one entry, the blocks
  reachable from it without crossing a call or another entry, their merged
  `ranges`, and `hash`.
- **Confidence** (lower is surer): `0` root (entry point, call target,
  jump-table target, hint), `1` code pointer (data word or lis/addi constant),
  `2` gap filling, `3` profile only. A consumer short on time compiles by
  confidence then size.

### Fingerprint

`hash` = FNV-1a 64 over the guest bytes of `ranges`, in memory (big-endian)
order, ranges ascending: offset basis `0xcbf29ce484222325`, prime
`0x100000001b3`, as 16 lowercase hex digits. Reference values are in
`tests/aot-plan.test.mjs`.

Before compiling a region ahead of time, and before reusing a cached module
for it, the compiler re-hashes guest memory over `ranges`. Different hash:
the region is skipped and the JIT handles that code as today. This covers
code patched by the game, a different disc revision, and a stale cache.

### Binary regions for the core

`encodePlanRegions(plan)` (u32 little-endian), for a consumer that only needs
the regions:

```
"SAOTPLN1", u32 version = 1, u32 regionCount, u32 reserved
per region: u32 module, u32 entry, u32 confidence, u32 hashHi, u32 hashLo,
            u32 rangeCount, rangeCount x (u32 start, u32 end)
```

## REL modules (OSLink)

A REL's load address is only known once `OSLink` has linked it. Discovery
places section `i` at a synthetic `0xa0000000 + i * 0x01000000`, applies the
module's relocations against itself (synthetic) and against the DOL
(absolute), and leaves relocations against other RELs unapplied. The plan
entry stores `(section, offset)` pairs:

```js
{ kind: "rel", relId, name, moduleHash,
  sections: [{ index, size, exec, bss, relocWords: [offset] }],
  blocks: { section: [], start: [], end: [], func: [] },
  functions: [{ section, entry, confidence, sources, ranges: [[section, start, end]] }],
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

`aot-profile.js`. Per disc key, OPFS file `aot-profile/<key>.bin`:
`"SAOTPRF1"`, u32 version, u32 sessions, u32 count, count x (u32 start,
u32 end), sorted. Overlapping blocks merge; adjacent blocks keep their own
start, since each start is an entry. At plan time, profile blocks inside a
module become roots (confidence 3 when nothing else found them), the others
go to `dynamic`.

Sources of blocks: `blocksFromCoreDump(u32 pairs start, length)` for a dump
of the JIT block cache (to be exposed by the core, see open points), or
`blocksFromPcSamples(pcs)` for a PC sampler.

## Per-game hint sheets `salon-aot-hints/1`

Optional, data only, for one exact DOL. **No sheet for a commercial game is
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

Coverage of the code actually run, measured with a dense sampler of the
emulated PC (a worker reading `PowerPCState.pc` from the shared heap in a
tight loop, ~150 M reads/s; it sees the PC where the core stores it, at block
dispatch):

| Scene | Static only (time / distinct PCs) | Static + profile of other runs |
| --- | --- | --- |
| Race, 20 s, JIT on (3 runs) | 99.81-99.83 % / 99.96 % | 100 % |
| Race, 20 s, interpreter | 99.88 % / 99.96 % | 100 % |
| Boot to attract mode, 70 s | 99.75 % / 99.87 % | 100 % |
| Homebrew GX scene, 25 s | 99.79 % / 99.20 % | — |
| Homebrew CPU fuzzer, 25 s | 95.2 % / 26.9 % | — (code generated at run time) |

What static discovery misses is code that is not in the disc's executables:
exception vectors the OS copies to low memory (run in real mode), a boot
stub the emulator writes, code generated at run time. The profile catches
the first two; the JIT handles all of it.

Precision: a race runs ~2,400 of the ~14,200 planned functions (~19,700 of
151,000 blocks). Compiling the whole plan ahead of time is ~6x the work the
race needs; the profile is the natural priority order.

## Open points with the region compiler

1. A core export listing the blocks compiled/executed (start, length), to feed
   the profile without a sampler.
2. Region unit: the plan offers functions; the compiler may split or merge
   (superblocks along `fall`/`branch` edges) as it likes.
3. Plan transport: JSON in the worker, or the binary regions passed to the
   core.

// Ahead-of-time code discovery over a guest image (DOL or REL): recursive
// descent from the known entry points, jump tables, constant indirect
// targets, code pointers found in data, then heuristic gap filling. The
// output is a compilation plan (see aot-plan.js and docs/aot-plan.md). What
// stays unknown is left to the JIT: discovery only adds hints, it never
// decides what the guest executes.
import {
  FLOW_BRANCH, FLOW_INDIRECT, FLOW_RETURN, SPR_CTR, SPR_LR,
  bcCondition, cmplwi, constStep, decodeFlow, fallsThrough, isAdd, isLwzx, isMtspr,
  isValidInstruction, mayWriteGpr, rA, rB, rD, simm, slwi2Source
} from "./aot-ppc.js";

// Confidence of a function entry, lower is surer.
export const CONF_ROOT = 0; // entry point, call target, jump table, hint
export const CONF_POINTER = 1; // address found in data or built by lis/addi
export const CONF_GAP = 2; // undiscovered gap that decodes as code
export const CONF_PROFILE = 3; // seen executing in a previous session only

const F_CODE = 1, F_LEADER = 2, F_ENTRY = 4, F_CONST_SCANNED = 8;

const SLICE_WINDOW = 40; // instructions scanned backward by a slice
const CONST_SCAN_WINDOW = 8; // for code addresses built by lis/addi
const WIDE_WINDOW = 256; // second chance for a table base kept in a saved register
// r0 and r3-r12 do not survive a call (PowerPC EABI).
// Sorted, merged copy of [start, end) ranges, and a binary-search membership test.
export function mergeSorted(ranges) {
  const out = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
export function inRanges(sorted, a) {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a < sorted[m][0]) hi = m - 1;
    else if (a >= sorted[m][1]) lo = m + 1;
    else return true;
  }
  return false;
}

const isVolatile = (r) => r === 0 || (r >= 3 && r <= 12);
const SCAN_TABLE_MAX = 512;
// Speculative walks share a budget of instructions proportional to the size
// of the executable sections: total work stays linear on hostile or
// degenerate images. Real discs use a fraction of it (stats.trialSteps).
const TRIAL_BUDGET_PER_WORD = 32;
// Blocks of the whole image: a real game has ~150 000; each costs memory in
// the plan, so a pathological image (a branch every other word) is refused.
export const MAX_BLOCKS = 400000;

class Flags {
  constructor(image) {
    this.image = image;
    this.parts = image.execSegments.map((s) => ({ start: s.start, end: s.end, f: new Uint8Array((s.end - s.start) >>> 2) }));
  }
  part(addr) {
    const parts = this.parts;
    let lo = 0, hi = parts.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (addr < parts[m].start) hi = m - 1;
      else if (addr >= parts[m].end) lo = m + 1;
      else return parts[m];
    }
    return null;
  }
  get(addr) {
    const p = this.part(addr);
    return p ? p.f[(addr - p.start) >>> 2] : 0;
  }
  set(addr, bits) {
    const p = this.part(addr);
    if (p) p.f[(addr - p.start) >>> 2] |= bits;
  }
}

export function discover(image, {
  entryPoints = [], // [{ addr, source, confidence?, trial? }]; trial roots (profile, hints) are walked on trial
  pointerScan = true,
  constScan = true,
  gapFill = true,
  maxTableEntries = SCAN_TABLE_MAX,
  exclude = [], // [[start, end)] never treated as code (hint sheets)
  knownTables = [] // [{ site, table, count, kind? }] from hint sheets
} = {}) {
  const flags = new Flags(image);
  const entries = new Map(); // addr -> { confidence, sources:Set }
  const jumpTables = new Map(); // site -> table
  const indirectSites = new Map(); // site -> { kind, resolved }
  let leaderCount = 0;
  const doomed = new Set(); // addresses whose straight-line walk ends on invalid code
  const tableWords = new Set(); // jump table words in data, not code pointers
  const codePointers = new Set(); // code addresses taken as values (entries from outside)
  const badStops = new Set();
  const stats = { rejectedCandidates: 0, budgetExhausted: false };
  const execWords = image.execSegments.reduce((n, s) => n + ((s.end - s.start) >>> 2), 0);
  const trialBudgetTotal = execWords * TRIAL_BUDGET_PER_WORD;
  let trialBudget = trialBudgetTotal;

  const read = (a) => image.read32(a);
  const excludeRanges = mergeSorted(exclude);
  const excluded = (a) => inRanges(excludeRanges, a);
  const isCodeAddr = (a) => image.isExec(a) && !excluded(a);

  function addEntry(addr, confidence, source) {
    const e = entries.get(addr);
    if (e) {
      e.confidence = Math.min(e.confidence, confidence);
      e.sources.add(source);
    } else {
      entries.set(addr, { confidence, sources: new Set([source]) });
    }
  }

  // Backward slices walk straight-line code only: they stop at an instruction
  // that cannot fall through (b, blr, bctr, rfi), whose successor is reached
  // some other way, and at calls, which clobber volatile registers.
  // With crossJumps, an unconditional `b` is crossed: compilers load loop
  // invariants (a switch table base) and then jump to the loop test.
  // `reg`: the register being traced; a call does not end the slice of a
  // non-volatile register.
  const sliceStop = (w, a, crossJumps = false, reg = 0) => {
    const flow = decodeFlow(w, a);
    if (!flow) return false;
    if (crossJumps && flow.kind === FLOW_BRANCH && !flow.link && !flow.conditional) return false;
    if (flow.link) return isVolatile(reg) || flow.kind !== FLOW_BRANCH;
    return !fallsThrough(flow);
  };

  // Constant value of `reg` just before instruction `at`, or null.
  function resolveConst(reg, at, depth = 0, crossJumps = false, window = crossJumps ? WIDE_WINDOW : SLICE_WINDOW) {
    if (depth > 4) return null;
    for (let a = at - 4, n = 0; n < window && image.isExec(a); a -= 4, n++) {
      const w = read(a);
      const step = constStep(w);
      if (step && step.dst === reg) {
        if (step.op === "addis" || step.op === "addi") {
          const base = step.src === 0 ? 0 : resolveConst(step.src, a, depth + 1, crossJumps, window);
          if (base === null) return null;
          return (base + (step.op === "addis" ? step.imm << 16 : step.imm)) >>> 0;
        }
        const base = resolveConst(step.src, a, depth + 1, crossJumps, window);
        if (base === null) return null;
        if (step.op === "mr") return base;
        return (base | (step.op === "oris" ? step.imm << 16 : step.imm)) >>> 0;
      }
      if (mayWriteGpr(w, reg) || sliceStop(w, a, crossJumps, reg)) return null;
    }
    return null;
  }

  // Index of the instruction writing `reg` before `at` (within the window), with its address.
  function defOf(reg, at) {
    for (let a = at - 4, n = 0; n < SLICE_WINDOW && image.isExec(a); a -= 4, n++) {
      const w = read(a);
      if (mayWriteGpr(w, reg) || (constStep(w)?.dst === reg)) return { a, w };
      if (sliceStop(w, a)) return null;
    }
    return null;
  }

  // Register moved into CTR/LR right before an indirect branch at `site`.
  function sprSource(site, spr) {
    for (let a = site - 4, n = 0; n < SLICE_WINDOW && image.isExec(a); a -= 4, n++) {
      const w = read(a);
      if (isMtspr(w, spr)) return { reg: rD(w), at: a };
      if (sliceStop(w, a)) return null;
    }
    return null;
  }

  // Bound of a switch on `idxReg`: cmplwi idx, N followed by a conditional branch.
  function switchBound(idxReg, at) {
    for (let a = at - 4, n = 0; n < SLICE_WINDOW && image.isExec(a); a -= 4, n++) {
      const w = read(a);
      const c = cmplwi(w);
      if (c && c.reg === idxReg) {
        // The branch consuming this compare decides whether N itself is in range.
        for (let b = a + 4; b < at; b += 4) {
          const cond = bcCondition(read(b));
          if (cond && cond.crf === c.crf) {
            // bgt default (gt true) or ble table: N in range. bge default (lt false): N excluded.
            if (cond.bit === 0 && !cond.ifTrue) return c.imm;
            return c.imm + 1;
          }
        }
        return c.imm + 1;
      }
      if (mayWriteGpr(w, idxReg) || sliceStop(w, a)) return null;
    }
    return null;
  }

  function resolveJumpTable(site) {
    const src = sprSource(site, SPR_CTR);
    if (!src) return null;
    const def = defOf(src.reg, src.at);
    if (!def) return null;
    let baseReg, idxReg, offset = 0, kind = "abs", load = def;
    if (isAdd(def.w) && rD(def.w) === src.reg) {
      // GCC: lwzx rT, rBase, rIdx; add rC, rT, rBase -- entries relative to the table.
      for (const [t, b] of [[rA(def.w), rB(def.w)], [rB(def.w), rA(def.w)]]) {
        const ld = defOf(t, def.a);
        if (ld && isLwzx(ld.w) && rD(ld.w) === t && (rA(ld.w) === b || rB(ld.w) === b)) {
          load = ld;
          baseReg = b;
          idxReg = rA(ld.w) === b ? rB(ld.w) : rA(ld.w);
          kind = "rel";
          break;
        }
      }
      if (kind !== "rel") return null;
    } else if (isLwzx(def.w) && rD(def.w) === src.reg) {
      baseReg = rA(def.w);
      idxReg = rB(def.w);
    } else if ((def.w >>> 26) === 32 && rD(def.w) === src.reg) {
      // lwz rC, d(rX) with rX = add(base, scaled index)
      offset = simm(def.w);
      const addDef = defOf(rA(def.w), def.a);
      if (!addDef || !isAdd(addDef.w)) return null;
      baseReg = rA(addDef.w);
      idxReg = rB(addDef.w);
    } else {
      return null;
    }
    let base = null;
    for (const crossJumps of [false, true]) {
      base = resolveConst(baseReg, load.a, 0, crossJumps);
      if (base === null && kind === "abs") {
        base = resolveConst(idxReg, load.a, 0, crossJumps);
        if (base !== null) [baseReg, idxReg] = [idxReg, baseReg];
      }
      if (base !== null) break;
    }
    if (base === null) return null;
    const table = (base + offset) >>> 0;
    let count = null, bound = "scan";
    const idxDef = defOf(idxReg, load.a);
    if (idxDef) {
      const scaledFrom = slwi2Source(idxDef.w);
      if (scaledFrom >= 0 && rA(idxDef.w) === idxReg) {
        count = switchBound(scaledFrom, idxDef.a);
        if (count !== null) bound = "cmplwi";
      }
    }
    const limit = Math.min(count ?? maxTableEntries, maxTableEntries);
    const seg = image.segmentAt(site);
    const targets = [];
    for (let i = 0; i < limit; i++) {
      const word = read(table + i * 4);
      const t = word === undefined ? undefined : kind === "rel" ? (table + (word | 0)) >>> 0 : word;
      const inRange = t !== undefined && isCodeAddr(t) && seg && t >= seg.start && t < seg.end;
      if (!inRange || !isValidInstruction(read(t))) {
        if (count !== null) return null; // a bounded table must be all code
        break;
      }
      if (count === null && Math.abs(t - site) > 0x10000) break;
      targets.push(t);
    }
    if (!targets.length) return null;
    return { site, table, count: targets.length, targets, bound, kind };
  }

  // Walk from `starts`. With commit=false nothing is recorded unless the walk
  // stays on valid instructions inside executable sections.
  function walk(starts, confidence, source, commit) {
    const local = new Set();
    const leaders = new Set(starts);
    const calls = [];
    const tables = [];
    const indirect = [];
    const stack = [...starts];
    let bad = false;
    // Straight-line prefix of the first start: if the walk fails inside it,
    // every address of the prefix leads to the failure, whatever comes later.
    const prefix = [];
    let inPrefix = true;
    const committed = (a) => (flags.get(a) & F_CODE) !== 0;
    walking: while (stack.length) {
      let a = stack.pop();
      for (;;) {
        if (!isCodeAddr(a) || doomed.has(a)) { bad = true; break; }
        if (committed(a) || local.has(a)) break;
        const w = read(a);
        if (!isValidInstruction(w)) { bad = true; if (commit) badStops.add(a); break; }
        local.add(a);
        if (!commit && --trialBudget < 0) { bad = true; stats.budgetExhausted = true; break walking; }
        if (inPrefix) prefix.push(a);
        const flow = decodeFlow(w, a);
        if (!flow) { a += 4; continue; }
        inPrefix = false;
        if (flow.kind === FLOW_BRANCH) {
          if (isCodeAddr(flow.target)) {
            leaders.add(flow.target);
            stack.push(flow.target);
            if (flow.link) calls.push(flow.target);
          } else if (!flow.link) {
            bad = !commit || bad; // branch out of the image: fine for known code, suspicious for a guess
          }
        } else if (flow.kind === FLOW_INDIRECT || (flow.kind === FLOW_RETURN && flow.link)) {
          const spr = flow.kind === FLOW_INDIRECT ? SPR_CTR : SPR_LR;
          if (flow.kind === FLOW_INDIRECT && !flow.link && !flow.conditional) {
            const t = jumpTables.get(a) || resolveJumpTable(a);
            if (t) {
              tables.push(t);
              for (const target of t.targets) { leaders.add(target); stack.push(target); }
            } else {
              indirect.push({ site: a, kind: "bctr", resolved: null });
            }
          } else {
            const src = sprSource(a, spr);
            const value = src ? resolveConst(src.reg, src.at) : null;
            const kind = flow.kind === FLOW_INDIRECT ? (flow.link ? "bctrl" : "bcctr") : "blrl";
            if (value !== null && isCodeAddr(value)) {
              indirect.push({ site: a, kind, resolved: [value] });
              leaders.add(value);
              stack.push(value);
              if (flow.link) calls.push(value);
            } else {
              indirect.push({ site: a, kind, resolved: null });
            }
          }
        }
        if (fallsThrough(flow)) { leaders.add(a + 4); a += 4; continue; }
        break;
      }
      if (bad && !commit) break;
      inPrefix = false;
    }
    if (bad && inPrefix) for (const a of prefix) doomed.add(a);
    if (!commit && bad) return false;
    for (const a of local) flags.set(a, F_CODE);
    for (const a of leaders) flags.set(a, F_LEADER);
    leaderCount += leaders.size;
    if (leaderCount > MAX_BLOCKS) throw new Error(`discovery: more than ${MAX_BLOCKS} blocks`);
    for (const s of starts) { flags.set(s, F_ENTRY); addEntry(s, confidence, source); }
    for (const c of calls) { flags.set(c, F_ENTRY); addEntry(c, confidence, `${source}:call`); }
    for (const t of tables) {
      if (jumpTables.has(t.site)) continue;
      jumpTables.set(t.site, t);
      for (let i = 0; i < t.count; i++) tableWords.add((t.table + i * 4) >>> 0);
    }
    for (const s of indirect) if (!indirectSites.has(s.site)) indirectSites.set(s.site, s);
    return true;
  }

  for (const k of knownTables) {
    const targets = [];
    for (let i = 0; i < k.count; i++) {
      const word = read(k.table + i * 4);
      const t = word === undefined ? undefined : k.kind === "rel" ? (k.table + (word | 0)) >>> 0 : word;
      if (t !== undefined && isCodeAddr(t)) targets.push(t);
    }
    if (targets.length) jumpTables.set(k.site, { site: k.site, table: k.table, count: targets.length, targets, bound: "hint", kind: k.kind ?? "abs" });
  }

  // Wave 0: roots. Trial roots (profile, hint sheets) wait until static
  // discovery is done, so that they only add code it did not find.
  const roots = entryPoints.filter((e) => isCodeAddr(e.addr));
  for (const e of roots) if (!e.trial) walk([e.addr], e.confidence ?? CONF_ROOT, e.source || "root", true);

  const inTableData = (a) => tableWords.has(a);
  const rejected = new Set();
  const tryCandidate = (addr, confidence, source) => {
    if (!isCodeAddr(addr) || (flags.get(addr) & F_CODE) || rejected.has(addr) || trialBudget < 0) return false;
    if (walk([addr], confidence, source, false)) return true;
    rejected.add(addr);
    stats.rejectedCandidates++;
    return false;
  };

  // Wave 1: code addresses built in code (lis/addi, lis/ori) and found in data.
  // Incremental: each code word is scanned for a constant once, the data once.
  let dataScanned = false;
  function pointerWave() {
    let added = 0;
    if (constScan) {
      for (const p of flags.parts) {
        for (let i = 0; i < p.f.length; i++) {
          if (!(p.f[i] & F_CODE) || (p.f[i] & F_CONST_SCANNED)) continue;
          p.f[i] |= F_CONST_SCANNED;
          const a = p.start + i * 4;
          const step = constStep(read(a));
          if (!step || step.op === "mr" || step.op === "addis" && step.src === 0) continue;
          // lis/addi pairs sit close together: a short window keeps the scan
          // linear on code made of nothing but additions.
          const value = resolveConst(step.dst, a + 4, 0, false, CONST_SCAN_WINDOW);
          if (value === null || !isCodeAddr(value)) continue;
          codePointers.add(value);
          if (tryCandidate(value, CONF_POINTER, "const")) added++;
        }
      }
    }
    if (pointerScan && !dataScanned) {
      dataScanned = true;
      for (const s of image.segments) {
        if (s.exec) continue;
        for (let off = 0; off + 4 <= s.bytes.byteLength; off += 4) {
          const v = s.view.getUint32(off, false);
          if (!isCodeAddr(v) || inTableData(s.start + off)) continue;
          codePointers.add(v);
          if (tryCandidate(v, CONF_POINTER, "data")) added++;
        }
      }
    }
    return added;
  }

  // Wave 2: gaps between known code that decode as functions.
  function gapWave() {
    let added = 0;
    for (const p of flags.parts) {
      let i = 0;
      while (i < p.f.length) {
        if (p.f[i] & F_CODE) { i++; continue; }
        let j = i;
        while (j < p.f.length && !(p.f[j] & F_CODE)) j++;
        // In the gap [i, j): try the first non-padding word, then prologues.
        let first = true;
        for (let k = i; k < j; k++) {
          if (p.f[k] & F_CODE) continue;
          const a = p.start + k * 4;
          const w = read(a);
          if (w === 0) { first = true; continue; }
          const prologue = (w & 0xffff8000) === 0x94218000 || w === 0x7c0802a6;
          if ((first || prologue) && tryCandidate(a, CONF_GAP, "gap")) added++;
          first = false;
        }
        i = j;
      }
    }
    return added;
  }

  const speculate = () => {
    // Rounds repeat only while something was added; each round costs the
    // new code (constants) plus one pass over the gaps.
    for (let round = 0; round < 32; round++) {
      let added = pointerScan || constScan ? pointerWave() : 0;
      if (gapFill) added += gapWave();
      if (!added) break;
    }
  };
  speculate();

  // Trial roots: an address already inside known code adds nothing (a
  // profile block in the middle of a function must not split it), except a
  // hint that explicitly names a function entry.
  let trialAdded = 0;
  for (const e of roots) {
    if (!e.trial) continue;
    if (flags.get(e.addr) & F_CODE) {
      if (e.forceEntry) { flags.set(e.addr, F_ENTRY | F_LEADER); addEntry(e.addr, e.confidence ?? CONF_POINTER, e.source); }
      continue;
    }
    if (tryCandidate(e.addr, e.confidence ?? CONF_PROFILE, e.source || "trial")) trialAdded++;
  }
  if (trialAdded) speculate();

  stats.trialSteps = trialBudgetTotal - Math.max(trialBudget, 0);
  // Pointers kept are those to accepted code (a rejected guess is not code).
  const pointers = [...codePointers].filter((a) => flags.get(a) & F_CODE).sort((a, b) => a - b);
  return { ...buildResult({ image, flags, entries, jumpTables, indirectSites, badStops, stats }), codePointers: pointers };
}

const EDGE_KIND = ["fall", "branch", "cond", "call", "tail", "table", "indirect"];
export const EDGE = Object.freeze(Object.fromEntries(EDGE_KIND.map((k, i) => [k, i])));

function buildResult({ image, flags, entries, jumpTables, indirectSites, badStops, stats }) {
  // Blocks: maximal runs of code split at leaders and after flow instructions.
  const blockStart = [], blockEnd = [];
  for (const p of flags.parts) {
    let cur = -1;
    for (let i = 0; i <= p.f.length; i++) {
      const a = p.start + i * 4;
      const isCode = i < p.f.length && (p.f[i] & F_CODE);
      if (cur >= 0 && (!isCode || (p.f[i] & F_LEADER))) {
        blockStart.push(cur); blockEnd.push(a); cur = -1;
      }
      if (!isCode) continue;
      if (cur < 0) cur = a;
      const flow = decodeFlow(image.read32(a), a);
      if (flow) { blockStart.push(cur); blockEnd.push(a + 4); cur = -1; }
    }
  }
  const index = new Map(blockStart.map((s, i) => [s, i]));
  const isEntry = (a) => entries.has(a);

  // Edges.
  const eFrom = [], eTo = [], eKind = [];
  const edge = (from, to, kind) => { eFrom.push(from); eTo.push(to); eKind.push(kind); };
  const succ = blockStart.map(() => []);
  for (let b = 0; b < blockStart.length; b++) {
    const last = blockEnd[b] - 4;
    const flow = decodeFlow(image.read32(last), last);
    const nextAddr = blockEnd[b];
    const intra = (to, kind) => { edge(b, to, kind); if (kind !== EDGE.call) succ[b].push(to); };
    if (!flow) {
      if (index.has(nextAddr)) intra(index.get(nextAddr), EDGE.fall);
      continue;
    }
    if (flow.kind === FLOW_BRANCH && index.has(flow.target)) {
      const t = index.get(flow.target);
      if (flow.link) edge(b, t, EDGE.call);
      else if (isEntry(flow.target) && !flow.conditional) edge(b, t, EDGE.tail);
      else intra(t, flow.conditional ? EDGE.cond : EDGE.branch);
    }
    const table = jumpTables.get(last);
    if (table) for (const t of table.targets) if (index.has(t)) intra(index.get(t), EDGE.table);
    const ind = indirectSites.get(last);
    if (ind?.resolved) for (const t of ind.resolved) if (index.has(t)) edge(b, index.get(t), flow.link ? EDGE.call : EDGE.indirect);
    if (fallsThrough(flow) && index.has(nextAddr)) intra(index.get(nextAddr), EDGE.fall);
  }

  // Functions: blocks reachable from an entry without crossing calls or other entries.
  const owner = new Int32Array(blockStart.length).fill(-1);
  const funcs = [];
  const sortedEntries = [...entries.keys()].filter((a) => index.has(a)).sort((a, b) => a - b);
  for (const entry of sortedEntries) {
    const f = funcs.length;
    const blocks = [];
    const stack = [index.get(entry)];
    while (stack.length) {
      const b = stack.pop();
      if (owner[b] !== -1) continue;
      if (blocks.length && isEntry(blockStart[b])) continue;
      owner[b] = f;
      blocks.push(b);
      for (const s of succ[b]) if (owner[s] === -1) stack.push(s);
    }
    if (!blocks.length) continue;
    const e = entries.get(entry);
    funcs.push({ entry, blocks: blocks.sort((x, y) => x - y), confidence: e.confidence, sources: [...e.sources] });
  }

  return {
    blocks: { start: blockStart, end: blockEnd, func: Array.from(owner) },
    edges: { from: eFrom, to: eTo, kind: eKind },
    functions: funcs,
    jumpTables: [...jumpTables.values()].sort((a, b) => a.site - b.site),
    indirectSites: [...indirectSites.values()].sort((a, b) => a.site - b.site),
    badStops: [...badStops].sort((a, b) => a - b),
    stats: {
      ...stats,
      blocks: blockStart.length,
      functions: funcs.length,
      codeBytes: blockStart.reduce((n, s, i) => n + blockEnd[i] - s, 0),
      execBytes: image.execSegments.reduce((n, s) => n + s.end - s.start, 0)
    }
  };
}

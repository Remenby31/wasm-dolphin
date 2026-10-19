// Region equivalence over N slices (plan piste 3, P4): every function of a
// plan is run from the same start state twice, once by a reference
// interpreter and once through assembled region modules (falling back to the
// interpreter for code no region holds, as the JIT would), and the final
// states must be identical. Slice k of N takes the region modules whose index
// is k modulo N, so N jobs cover a disc in parallel.
//
// Collaborators, injected so the core can replace the stand-ins:
//   translate(f) -> fragment | null      (core: _DolphinWeb_AotTranslateForTest)
//   interpretStep(st, read32)            (core: the oracle's interpreter)
//   layout { pc, lr, gpr }, stateBytes
import { orderedRegions } from "../../src/aot-plan.js";
import { assembleRegion, groupRegions } from "../../src/aot-region-module.js";

const STATE = 64;
const STOP = 0x00000100; // return address of the call under test: outside any code

function stateView(memory, layout) {
  const dv = () => new DataView(memory.buffer);
  return {
    get pc() { return dv().getUint32(STATE + layout.pc, true); },
    set pc(v) { dv().setUint32(STATE + layout.pc, v >>> 0, true); },
    get lr() { return dv().getUint32(STATE + layout.lr, true); },
    set lr(v) { dv().setUint32(STATE + layout.lr, v >>> 0, true); },
    gpr: (r) => dv().getInt32(STATE + layout.gpr + 4 * r, true),
    setGpr: (r, v) => dv().setInt32(STATE + layout.gpr + 4 * r, v | 0, true)
  };
}

function seedState(st, seed) {
  let s = seed >>> 0 || 1;
  for (let r = 0; r < 32; r++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    st.setGpr(r, s | 0);
  }
}

function snapshot(st) {
  return { pc: st.pc, lr: st.lr, gpr: Array.from({ length: 32 }, (_, r) => st.gpr(r)) };
}

export function regionSlices(plan, { slices, maxFunctions = 100 }) {
  const ordered = orderedRegions(plan);
  const groups = [];
  for (const m of plan.modules) {
    const order = ordered.filter((r) => r.module === m.id).map((r) => m.functions.indexOf(r.f)).filter((i) => i >= 0);
    for (const g of groupRegions(m, order, { maxFunctions })) groups.push(g.map((i) => m.functions[i]));
  }
  return Array.from({ length: slices }, (_, k) => groups.filter((_, i) => i % slices === k));
}

// Runs slice `slice` of `slices`. Every region module of the plan is
// assembled (calls cross regions), the functions of the slice are checked.
export function checkSlice({ plan, read32, slice, slices, translate, interpretStep, layout, stateBytes, maxFunctions = 100, maxSteps = 100000, seed = 1 }) {
  const all = regionSlices(plan, { slices: 1, maxFunctions })[0];
  const mine = new Set(regionSlices(plan, { slices, maxFunctions })[slice].flat());
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  if (STATE + stateBytes > memory.buffer.byteLength) throw new Error("state does not fit");
  const st = stateView(memory, layout);
  const regionAt = new Map(); // entry pc -> dispatcher
  const report = { slice, slices, functions: 0, translated: 0, checked: 0, equal: 0, regionRuns: 0, mismatches: [], skipped: [] };
  for (const group of all) {
    const fragments = [];
    for (const f of group) {
      const fragment = translate(f);
      if (fragment) fragments.push(fragment);
    }
    if (!fragments.length) continue;
    const { bytes } = assembleRegion(fragments, { helpers: {}, pcOffset: layout.pc, memoryPages: 1, memoryMinPages: 1 });
    const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
    for (const fr of fragments) for (const pc of fr.entries) regionAt.set(pc >>> 0, exports.f);
  }

  const runReference = () => {
    for (let n = 0; n < maxSteps; n++) {
      if (st.pc === STOP) return "stop";
      interpretStep(st, read32);
    }
    return "steps";
  };
  const runRegions = () => {
    let regionRuns = 0;
    for (let n = 0; n < maxSteps; n++) {
      if (st.pc === STOP) return { end: "stop", regionRuns };
      const f = regionAt.get(st.pc);
      if (!f) {
        interpretStep(st, read32); // code no region holds: the JIT's job
        continue;
      }
      regionRuns += 1;
      const code = f(STATE);
      if (code === 2) return { end: "halted", regionRuns };
      if (code === 1) throw new Error(`region refused its own entry ${st.pc.toString(16)}`);
    }
    return { end: "steps", regionRuns };
  };

  for (const f of plan.modules.flatMap((m) => m.functions)) {
    if (!mine.has(f)) continue;
    report.functions += 1;
    if (regionAt.has(f.entry >>> 0)) report.translated += 1;
    else continue;
    const start = (state) => {
      new Uint8Array(memory.buffer, STATE, stateBytes).fill(0);
      seedState(state, seed ^ f.entry);
      state.pc = f.entry;
      state.lr = STOP;
    };
    let expected;
    try {
      start(st);
      const end = runReference();
      if (end !== "stop") { report.skipped.push({ entry: f.entry, reason: end }); continue; }
      expected = snapshot(st);
    } catch (error) {
      report.skipped.push({ entry: f.entry, reason: String(error.message) });
      continue;
    }
    start(st);
    let got;
    try {
      const { end, regionRuns } = runRegions();
      got = { ...snapshot(st), end, regionRuns };
    } catch (error) {
      report.mismatches.push({ entry: f.entry, error: String(error.message) });
      continue;
    }
    report.checked += 1;
    report.regionRuns += got.regionRuns;
    const same = got.end === "stop" && got.pc === expected.pc && got.lr === expected.lr && got.gpr.every((v, r) => v === expected.gpr[r]);
    if (same) report.equal += 1;
    else report.mismatches.push({ entry: f.entry, expected, got });
  }
  return report;
}

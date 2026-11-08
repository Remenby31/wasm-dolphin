// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The PC kit's logic, pure (research/pc-windows-kit.md): the remote
// PowerShell call, the preflight checklist (the Windows traps and how each is
// seen), the CPU clamp's calibration search, a run's validity and the J1b
// verdict. harness/remote/pc-run.mjs does the I/O.

export const KIT_DIR = "C:\\salon-kit";
export const KIT_SCHEME = "5a10c0de-0b1d-4c1a-9e2f-12400c1a0001";
export const KIT_SCRIPT = `${KIT_DIR}\\salon-pc.ps1`;
export const JSON_MARK = "SALONKIT-JSON ";

// ---- remote PowerShell
// A literal for PowerShell (single quotes: nothing expands).
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
// A script as -EncodedCommand takes it (UTF-16LE, base64): no quoting
// through ssh and cmd.exe, Windows OpenSSH's default shell.
export const encodePs = (script) => Buffer.from(script, "utf16le").toString("base64");
const PARAM = /^[A-Z][A-Za-z]+$/;
// The remote command line of one salon-pc.ps1 action.
export function kitCommand(action, params = {}) {
  const parts = [`& ${psQuote(KIT_SCRIPT)} -Action ${psQuote(action)}`];
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (!PARAM.test(k)) throw new Error(`bad parameter name ${k}`);
    parts.push(`-${k} ${typeof v === "number" ? String(Math.trunc(v)) : psQuote(v)}`);
  }
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePs(parts.join(" "))}`;
}
// The action's result: the last "SALONKIT-JSON {...}" line.
export function parseKitJson(stdout) {
  const line = String(stdout ?? "").split(/\r?\n/).filter((l) => l.startsWith(JSON_MARK)).at(-1);
  if (!line) return null;
  return JSON.parse(line.slice(JSON_MARK.length));
}

// A job id: what salon-pc.ps1 accepts.
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function newJobId(kind, now = new Date()) {
  return `${kind}-${now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}`;
}

// No disc image ever leaves this Mac (PROGRAM.md, rule 2): the kit sends
// only its own tree, node, Playwright, films and the repository's homebrews.
export const DISC_EXT = /\.(iso|gcm|gcz|rvz|ciso|wbfs|wia|nkit|dol|elf|tgc)$/i;
export function assertSendable(file, { homebrewDirs = [] } = {}) {
  if (!DISC_EXT.test(file)) return;
  if (homebrewDirs.some((d) => file.startsWith(d.endsWith("/") ? d : `${d}/`))) return;
  throw new Error(`refused: ${file} looks like a disc image; the kit never copies one (the PC reads its own, --iso on the PC)`);
}

// ---- reference CPU (research/pc-windows-kit.md §2, sources there)
// Geekbench 6 single-core averages of the Geekbench Browser processor list
// (one snapshot for all, so the ratios hold); filled in PUBLIC_GB6.
export const REFERENCE_CPU = "Intel Core i5-12400";
export const GB6_SOURCE = "https://web.archive.org/web/20260718165829/https://browser.geekbench.com/processor-benchmarks";
export const PUBLIC_GB6 = Object.freeze({
  "Intel Core i5-12400": 2204, "Intel Core i5-12400F": 2216, "AMD Ryzen 5 5600": 2053,
  "Intel Core i7-12700K": 2559, "Intel Core i9-12900K": 2574, "Intel Core i5-13600K": 2675, "Intel Core i7-13700K": 2840,
  "Intel Core i9-13900K": 2983, "Intel Core i7-14700K": 2918, "Intel Core i9-14900K": 3046,
  "Intel Core Ultra 7 265K": 3062, "Intel Core Ultra 9 285K": 3195,
  "AMD Ryzen 7 5800X": 2192, "AMD Ryzen 7 5800X3D": 2114, "AMD Ryzen 7 7700X": 2971, "AMD Ryzen 7 7800X3D": 2719,
  "AMD Ryzen 7 9700X": 3345, "AMD Ryzen 7 9800X3D": 3333, "AMD Ryzen 9 5900X": 2198, "AMD Ryzen 9 5950X": 2205,
  "AMD Ryzen 9 7900X": 2943, "AMD Ryzen 9 7950X": 2974, "AMD Ryzen 9 7950X3D": 2925,
  "AMD Ryzen 9 9900X": 3333, "AMD Ryzen 9 9950X": 3384, "AMD Ryzen 9 9950X3D": 3392
});
// Best-core max turbo / boost, MHz (Intel ARK via Wayback, amd.com; sources
// in research/pc-windows-kit.md §2): the search's first probe is
// turbo × reference / host. The i5-12400's own: 4400.
export const MAX_TURBO_MHZ = Object.freeze({
  "Intel Core i5-12400": 4400, "Intel Core i7-12700K": 5000, "Intel Core i9-12900K": 5200, "Intel Core i5-13600K": 5100,
  "Intel Core i7-13700K": 5400, "Intel Core i9-13900K": 5800, "Intel Core i7-14700K": 5600, "Intel Core i9-14900K": 6000,
  "Intel Core Ultra 7 265K": 5500, "Intel Core Ultra 9 285K": 5700,
  "AMD Ryzen 7 5800X": 4700, "AMD Ryzen 7 5800X3D": 4500, "AMD Ryzen 7 7700X": 5400, "AMD Ryzen 7 7800X3D": 5000,
  "AMD Ryzen 7 9700X": 5500, "AMD Ryzen 7 9800X3D": 5200, "AMD Ryzen 9 5900X": 4800, "AMD Ryzen 9 5950X": 4900,
  "AMD Ryzen 9 7900X": 5600, "AMD Ryzen 9 7950X": 5700, "AMD Ryzen 9 7950X3D": 5700,
  "AMD Ryzen 9 9900X": 5600, "AMD Ryzen 9 9950X": 5700, "AMD Ryzen 9 9950X3D": 5700
});
// The reference class: 6 cores of the fastest class with SMT (the i5-12400
// has 6 P-cores, 12 threads, no E-core).
export const CLASS_CORES = 6;

export function gb6Of(cpuName, table = PUBLIC_GB6) {
  const norm = (s) => String(s).toLowerCase().replace(/\(r\)|\(tm\)|processor|cpu|\d+-core|@.*$/g, " ").replace(/\s+/g, " ").trim();
  const n = norm(cpuName);
  const hits = Object.keys(table).filter((k) => n.includes(norm(k).replace(/^intel |^amd /, "")));
  if (!hits.length) return null;
  const best = hits.sort((a, b) => b.length - a.length)[0];
  return { name: best, gb6: table[best] };
}

// The calibration's target: the host's own unclamped score scaled by the
// public single-core ratio reference / host.
export function calibrationTarget({ unclampedScore, hostGb6, referenceGb6 }) {
  if (!(unclampedScore > 0) || !(hostGb6 > 0) || !(referenceGb6 > 0)) throw new Error("calibrationTarget: scores must be positive");
  const ratio = referenceGb6 / hostGb6;
  return { ratio: Math.round(ratio * 1000) / 1000, target: Math.round(unclampedScore * ratio * 1000) / 1000, needed: ratio < 0.98 };
}

// ---- the calibration search
// points: [{ x, score }] (x: the knob, MHz or %; score rises with x).
// Next probe: inside a bracket, linear interpolation kept to its middle;
// outside, scaling x by target / score (speed ~ frequency). Done when a
// point is within tol of the target, the bracket is narrower than minStep,
// the next x repeats, or maxProbes is reached. best = closest point.
export function nextProbe(points, target, { lo, hi, tol = 0.02, step = 50, minStep = 100, maxProbes = 8 } = {}) {
  if (!points.length) throw new Error("nextProbe: no point");
  const err = (p) => Math.abs(p.score / target - 1);
  const best = [...points].sort((a, b) => err(a) - err(b))[0];
  const result = (done, next, why) => ({ done, next, best, why, errPct: Math.round(err(best) * 1000) / 10 });
  if (err(best) <= tol) return result(true, null, "within tolerance");
  if (points.length >= maxProbes) return result(true, null, "probe budget spent");
  const below = points.filter((p) => p.score < target).sort((a, b) => b.x - a.x)[0];
  const above = points.filter((p) => p.score > target).sort((a, b) => a.x - b.x)[0];
  let x;
  if (below && above && below.x < above.x) {
    if (above.x - below.x <= minStep) return result(true, null, "bracket narrower than the step");
    const f = (target - below.score) / (above.score - below.score);
    x = below.x + Math.min(0.8, Math.max(0.2, f)) * (above.x - below.x);
  } else {
    const ref = above ?? below;
    x = ref.x * (target / ref.score);
  }
  x = Math.min(hi, Math.max(lo, Math.round(x / step) * step));
  if (points.some((p) => p.x === x)) return result(true, null, x === lo || x === hi ? "at the knob's bound" : "next probe repeats");
  return result(false, x, "search");
}
// The knob did nothing: the lowest probe kept within `minDrop` of the top
// one although it asked for much less (a frequency cap the firmware ignores).
export function knobIneffective(points, { minDrop = 0.05, minAsk = 0.75 } = {}) {
  if (points.length < 2) return false;
  const s = [...points].sort((a, b) => a.x - b.x);
  const lo = s[0], top = s.at(-1);
  return lo.x <= minAsk * top.x && lo.score >= (1 - minDrop) * top.score;
}

// ---- the preflight checklist (research/pc-windows-kit.md §3)
// Each item: id, level (block: no measure; warn: measure, flagged; info),
// and what was seen. `check` is salon-pc.ps1 -Action check's result;
// `bench` (optional) pc-bench results per browser.
export function preflight(check, { browsers = ["chrome", "msedge"], bench = {}, needIso = null } = {}) {
  const items = [];
  const add = (id, level, ok, seen, fix = null) => items.push({ id, level: ok ? "ok" : level, seen, ...(ok ? {} : { fix }) });
  const os = check.os ?? {};
  add("windows-11", "warn", Number(os.build) >= 22000, `${os.caption ?? "?"} build ${os.build ?? "?"}`, "J1b's target is Windows 11");
  const bat = check.power?.battery ?? [];
  add("mains", "block", !bat.length || bat.every((b) => b.BatteryStatus !== 1), bat.length ? `battery ${bat.map((b) => `${b.EstimatedChargeRemaining}% status ${b.BatteryStatus}`).join(", ")}` : "no battery (desktop)", "plug the PC in: on battery Windows lowers the QoS and the frequency");
  add("kit-scheme-not-left", "block", !check.power?.kitSchemeActive, `active scheme ${check.power?.activeScheme}`, "a previous job left the clamp on: pc-run.mjs restore --job <that job>");
  const ovl = String(check.power?.overlayAc ?? "").toLowerCase();
  add("power-mode", "warn", !ovl || ovl === "00000000-0000-0000-0000-000000000000" || ovl === "ded574b5-45a0-4f42-8737-46345c09c238", `power mode overlay (AC) ${ovl || "none"}`, "Settings > System > Power: 'Balanced' or 'Best performance' on mains (best power efficiency throttles)");
  add("unlocked-session", "block", !check.session?.lockScreenUp && (check.session?.sessions ?? []).some((s) => /\|Active\||\|Actif\||\bActive\b|\bActif\b/i.test(s)), `sessions ${JSON.stringify(check.session?.sessions ?? [])}, lock screen ${check.session?.lockScreenUp ? "up" : "down"}`,
    "log on at the PC and leave the desktop unlocked (screen saver and sleep off for the session): a locked or hidden window is EcoQoS");
  for (const b of browsers) {
    const v = b === "msedge" ? check.browsers?.edge : check.browsers?.chrome;
    add(`browser-${b}`, "block", Boolean(v?.version), v ? `${v.version} (${v.path})` : "not installed", `install ${b === "msedge" ? "Edge" : "Chrome"} stable (the kit never installs a browser)`);
  }
  const gpus = check.gpus ?? [];
  const nvidia = gpus.filter((g) => /nvidia/i.test(g.name));
  add("gpu-dgpu", "warn", nvidia.length > 0, gpus.map((g) => `${g.name} (driver ${g.driver}, ${g.driverDate ?? "?"}, ${g.refreshHz ?? "?"} Hz)`).join("; ") || "none", "J1b targets an RTX 3060 class GPU: record what this one is");
  add("igpu-present", "info", gpus.length <= 1, `${gpus.length} display adapters`, "with an iGPU too, Chrome may composite on it: check the adapter of pc-bench/webgpu-adapter, set chrome.exe/msedge.exe to 'High performance' in Settings > Display > Graphics");
  const hz = Math.max(0, ...gpus.map((g) => Number(g.refreshHz) || 0));
  add("refresh-60", "warn", hz === 0 || (hz >= 59 && hz <= 61), `${hz || "?"} Hz`, "the J1a figures are at 60 Hz: set the screen to 60 Hz for the J1b runs (and record it), or measure 144 Hz separately");
  const pol = { ...(check.policies?.chromeMachine ?? {}), ...(check.policies?.chromeUser ?? {}) };
  add("chrome-jit-policy", "block", pol.DefaultJavaScriptJitSetting !== 2 && pol.DefaultJavaScriptOptimizerSetting !== 2 && pol.HardwareAccelerationModeEnabled !== 0,
    `Chrome policies ${JSON.stringify(pol)}`, "a policy blocks the JIT, the optimizer or the GPU: measure is meaningless");
  const epol = { ...(check.policies?.edgeMachine ?? {}), ...(check.policies?.edgeUser ?? {}) };
  if (browsers.includes("msedge")) {
    add("edge-esm-policy", "warn", epol.EnhanceSecurityMode == null || epol.EnhanceSecurityMode === 0, `Edge EnhanceSecurityMode ${epol.EnhanceSecurityMode ?? "unset"}`, "enhanced security runs Wasm in an interpreter: the bench says which mode ran");
  }
  const mem = check.memory ?? {};
  add("memory", "info", mem.totalGiB == null || mem.totalGiB <= 17, `${mem.totalGiB ?? "?"} GiB (free ${mem.freeGiB ?? "?"})`, "more than the 16 GB target: memory is not clamped (Salon commits ~1.5 GiB; noted, not corrected)");
  add("disk", "block", (check.disk?.freeGiB ?? 0) >= 5, `${check.disk?.freeGiB ?? "?"} GiB free on ${check.disk?.drive ?? "?"}:`, "free 5 GB for the kit (tree, node, profiles, results)");
  const aff = check.classAffinity;
  add("class-affinity", "block", Boolean(aff?.mask) && !aff.error, aff?.error ?? `${aff?.cores} cores / ${aff?.threads} threads, class ${aff?.efficiencyClass}${aff?.hybrid ? " (hybrid CPU: E-cores excluded)" : ""}, mask ${aff?.mask}`, "the CPU has fewer than 6 cores of its fastest class");
  add("smt", "warn", !aff || aff.threads === 2 * aff.cores, aff ? `${aff.threads} threads on ${aff.cores} cores` : "?", "no SMT on this CPU (e.g. Core Ultra 200S): 6 threads instead of the i5-12400's 12");
  add("gb6-known", "warn", Boolean(gb6Of(check.cpu?.name ?? "")), `${check.cpu?.name ?? "?"}`, "host CPU not in the public table: pass --host-gb6 <score> with its source");
  const busy = check.cpuBusy?.otherPctOfOneCore;
  add("idle", "warn", busy == null || busy < 25, `other processes ${busy ?? "?"} % of one core (${(check.cpuBusy?.top ?? []).map((t) => `${t.name} ${t.pct}`).join(", ")})`, "close what runs (updates, indexing, games launchers) before measuring");
  add("hvci", "info", true, `memory integrity ${check.security?.memoryIntegrity ?? "unknown"}`, null);
  add("hags", "info", true, `hardware-accelerated GPU scheduling ${check.hags === 2 ? "on" : check.hags === 1 ? "off" : "default"}`, null);
  for (const [b, r] of Object.entries(bench)) {
    const st = r?.perRun?.[0]?.state ?? r?.state;
    if (!st) continue;
    add(`page-visible-${b}`, "block", st.visibility === "visible", `visibility ${st.visibility}, focus ${st.focus}`, "the browser window is hidden or occluded: nothing in front of it, screen unlocked");
    add(`page-focus-${b}`, "warn", st.focus === true, `focus ${st.focus}`, "the window has no focus (QoS Medium): click into it once, or close what took the focus");
    const raf = st.rafMs?.p50;
    add(`raf-${b}`, "block", raf == null || raf < 25, `rAF p50 ${raf ?? "?"} ms`, "rAF at 30 Hz: an energy saver (browser or Windows) or a 30 Hz screen");
    const jit = (r?.perRun ?? [r]).map((x) => x.jit);
    add(`jit-${b}`, "block", jit.every((j) => j === "tier-up"), `tier-up ${jit.join(", ")}`, "no optimizing tier: Edge enhanced security (interpreter) or JavaScript optimization off; add the site exception and re-run");
  }
  if (needIso) add("iso-on-pc", "block", Boolean(check.iso?.exists), `${needIso}: ${check.iso?.exists ? `${check.iso.bytes} bytes` : "missing"}`, "put the disc on the PC yourself (never copied by the kit)");
  return { items, blocked: items.filter((i) => i.level === "block"), warnings: items.filter((i) => i.level === "warn") };
}
export function preflightMarkdown(p) {
  const mark = { ok: "✔", block: "✖ BLOCK", warn: "⚠ warn", info: "ℹ" };
  return ["| check | state | seen | fix |", "|---|---|---|---|", ...p.items.map((i) => `| ${i.id} | ${mark[i.level]} | ${String(i.seen).replace(/\|/g, "/")} | ${i.fix ?? ""} |`)].join("\n");
}

// ---- runs and the J1b verdict (research/pc-windows-protocol.md)
export const J1B = Object.freeze({ speedP5: 98, smoothP5: 95, phases: ["cinematic", "menu", "game"], minValidRuns: 3 });
// Sampler rows (salon-pc.ps1 sampler.jsonl) -> the run's contamination.
export const OTHER_CPU_MEDIAN_MAX = 25; // % of one core
export const OTHER_CPU_P95_MAX = 100;
export function samplerVerdict(rows, { affinity = null, scheme = null } = {}) {
  const other = rows.map((r) => r.otherPct).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => (other.length ? other[Math.min(other.length - 1, Math.floor(p * (other.length - 1) + 0.5))] : null);
  const reasons = [];
  if (!rows.length) reasons.push("no sampler row");
  if (q(0.5) != null && q(0.5) > OTHER_CPU_MEDIAN_MAX) reasons.push(`other processes ${q(0.5)} % of a core (median) > ${OTHER_CPU_MEDIAN_MAX}`);
  if (q(0.95) != null && q(0.95) > OTHER_CPU_P95_MAX) reasons.push(`other processes ${q(0.95)} % of a core (p95) > ${OTHER_CPU_P95_MAX}`);
  if (rows.some((r) => r.locked)) reasons.push("the lock screen came up");
  if (scheme && rows.some((r) => r.scheme && r.scheme !== scheme)) reasons.push(`the power scheme changed during the run (expected ${scheme})`);
  if (affinity && rows.some((r) => r.browserAffinity && r.browserAffinity !== affinity)) reasons.push(`a browser process ran outside the class affinity ${affinity}`);
  return { rows: rows.length, otherMedian: q(0.5), otherP95: q(0.95), contaminated: reasons.length > 0, reasons };
}
// One parcours summary.json (its runs) -> per phase kind the per-run p5s,
// their median over the valid runs, and pass/fail against J1B.
export function j1bTable(summaries, { usable = (a) => Boolean(a && !a.error && a.completion?.completed && !a.integrityFailed && !a.powerDrained), excluded = new Set() } = {}) {
  const rows = [];
  for (const { label, summary } of summaries) {
    const runs = (summary.runs ?? []).filter((r) => r.side === "candidate");
    const valid = runs.filter((r) => usable(r) && !excluded.has(`${label}#${r.run}`));
    for (const ph of J1B.phases) {
      const per = valid.map((r) => r.phases?.[ph]?.metrics).filter(Boolean);
      const med = (k) => { const v = per.map((m) => m[k]).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
      const speed = med("speedP5"), smooth = med("smoothP5");
      const enough = per.length >= J1B.minValidRuns;
      rows.push({
        label, phase: ph, runs: runs.length, validRuns: per.length, speedP5: speed, smoothP5: smooth,
        speedP5PerRun: per.map((m) => m.speedP5), smoothP5PerRun: per.map((m) => m.smoothP5), smoothUnreliable: per.some((m) => m.smoothReliable === false),
        verdict: !enough ? "too few valid runs" : speed >= J1B.speedP5 && smooth >= J1B.smoothP5 ? "pass" : "fail"
      });
    }
  }
  return rows;
}
export function j1bMarkdown(rows) {
  return ["| scene / browser | phase | valid runs | speed p5 (median) | smoothness p5 (median) | per run (speed / smooth) | verdict |", "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.label} | ${r.phase} | ${r.validRuns}/${r.runs} | ${r.speedP5 ?? "–"} | ${r.smoothP5 ?? "–"}${r.smoothUnreliable ? " (unreliable)" : ""} | ${r.speedP5PerRun.map((s, i) => `${s}/${r.smoothP5PerRun[i]}`).join(", ")} | ${r.verdict} |`)].join("\n");
}

// What a restore must give back: the snapshot's scheme active, the kit's
// scheme and task gone, the scheme list and the processor settings as before.
export function restoreDiff(before, after, job) {
  const d = [];
  if (!before) return ["no snapshot to compare with"];
  if (after.activeScheme !== before.activeScheme) d.push(`active scheme ${after.activeScheme}, was ${before.activeScheme}`);
  if ((after.schemes ?? []).includes(KIT_SCHEME)) d.push("the kit's power scheme still exists");
  const set = (x) => JSON.stringify([...(x ?? [])].sort());
  if (set(after.schemes) !== set(before.schemes)) d.push(`schemes ${set(after.schemes)}, were ${set(before.schemes)}`);
  if (JSON.stringify(after.processor) !== JSON.stringify(before.processor)) d.push(`processor settings ${JSON.stringify(after.processor)}, were ${JSON.stringify(before.processor)}`);
  if ((after.tasks ?? []).includes(job)) d.push(`scheduled task \\SalonKit\\${job} still registered`);
  return d;
}

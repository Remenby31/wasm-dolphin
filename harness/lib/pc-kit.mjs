// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The PC kit's logic, pure (research/pc-windows-kit.md): the remote
// PowerShell call, the preflight checklist (the Windows traps and how each is
// seen), the CPU clamp's calibration search, a run's validity and the J1b
// verdict. harness/remote/pc-run.mjs does the I/O.

// The kit's folder: %USERPROFILE%\salon-kit of the kit's standard account,
// read once at the start of a session (pc-run.mjs setKitDir).
export let KIT_DIR = "C:\\Users\\salonkit\\salon-kit";
export const KIT_PATH = /^[A-Za-z]:\\(?:[A-Za-z0-9 ._-]+\\)*salon-kit$/;
export function setKitDir(dir) {
  if (!KIT_PATH.test(dir)) throw new Error(`kit folder ${dir}: expected <drive>:\\...\\salon-kit (letters, digits, space . _ -)`);
  KIT_DIR = dir;
}
export const kitScript = () => `${KIT_DIR}\\salon-pc.ps1`;
export const KIT_SCHEME = "5a10c0de-0b1d-4c1a-9e2f-12400c1a0001";
export const JSON_MARK = "SALONKIT-JSON ";
export const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

// ---- the administrator's commands: a closed list (research/pc-windows-kit.md §1)
// The ONLY operations of the kit run as an administrator: these command
// lines, executable by absolute path, arguments constants, GUIDs matched
// by regex, the known processor-setting GUIDs, integers. No kit script, no
// node, no PowerShell module, no Add-Type. sshd runs them through
// "cmd.exe /d /c" (DefaultShell + DefaultShellCommandOption, checked by
// the preflight from the standard account: /d = no AutoRun).
const SYS = "C:\\Windows\\System32";
export const POWERCFG = `${SYS}\\powercfg.exe`;
export const SCHTASKS = `${SYS}\\schtasks.exe`;
const CMD = `${SYS}\\cmd.exe`;
export const BALANCED = "381b4222-f694-41f0-9685-ff5bb260df2e";
export const SUB_PROCESSOR = "54533251-82be-4824-96c1-47b60b740d00";
export const SETTINGS = Object.freeze({
  PROCFREQMAX: "75b0ae3f-bce0-45a7-8c89-c9611c25e100", PROCFREQMAX1: "75b0ae3f-bce0-45a7-8c89-c9611c25e101",
  PROCTHROTTLEMAX: "bc5038f7-23e0-4960-96da-33abaf5935ec", PROCTHROTTLEMAX1: "bc5038f7-23e0-4960-96da-33abaf5935ed",
  PERFBOOSTMODE: "be337238-0d82-4146-a960-4f3749d470c7"
});
// The boot task (SYSTEM, at startup): puts the snapshot's scheme back and
// deletes itself. The kit's scheme stays (inactive) until pc-run restore;
// the preflight blocks a new run while it exists. One clamp at a time, a
// fixed name. schtasks silently TRUNCATES a long /tr (CI windows-2025: a
// 260-character line was cut before its last command, documented limit
// 261): the line is kept under BOOT_TR_MAX.
export const BOOT_TASK = "SalonKitRestore";
export const BOOT_TR_MAX = 240;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const guid = (g) => { if (!GUID.test(String(g))) throw new Error(`not a GUID: ${g}`); return g; };
const notKit = (g) => { if (g === KIT_SCHEME) throw new Error("the way back cannot be the kit's own scheme"); return g; };
const uint = (n) => { if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error(`not an integer 0-100000: ${n}`); return String(n); };
export const ADMIN = Object.freeze({
  getActive: () => `${POWERCFG} /getactivescheme`,
  duplicate: (orig) => `${POWERCFG} /duplicatescheme ${guid(orig)} ${KIT_SCHEME}`,
  rename: () => `${POWERCFG} /changename ${KIT_SCHEME} SalonKitClamp`,
  setIndex: (acdc, name, value) => {
    if (acdc !== "ac" && acdc !== "dc") throw new Error(`setIndex: ac or dc, not ${acdc}`);
    if (!SETTINGS[name]) throw new Error(`setIndex: unknown setting ${name}`);
    return `${POWERCFG} /set${acdc}valueindex ${KIT_SCHEME} ${SUB_PROCESSOR} ${SETTINGS[name]} ${uint(value)}`;
  },
  activateKit: () => `${POWERCFG} /setactive ${KIT_SCHEME}`,
  activate: (orig) => `${POWERCFG} /setactive ${notKit(guid(orig))}`,
  deleteKit: () => `${POWERCFG} /delete ${KIT_SCHEME}`,
  bootTask: (orig) => `${SCHTASKS} /create /tn ${BOOT_TASK} /sc onstart /ru SYSTEM /rl highest /f /tr "${CMD} /d /c ${POWERCFG} /setactive ${notKit(guid(orig))} & ${SCHTASKS} /delete /tn ${BOOT_TASK} /f"`,
  queryBootTask: () => `${SCHTASKS} /query /tn ${BOOT_TASK}`,
  deleteBootTask: () => `${SCHTASKS} /delete /tn ${BOOT_TASK} /f`
});
// The closed list as exact patterns: assertAdmin refuses any other line.
const G = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const esc = (x) => x.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const P = esc(POWERCFG), S = esc(SCHTASKS), C = esc(CMD), K = esc(KIT_SCHEME);
const SETTING_ALT = Object.values(SETTINGS).map(esc).join("|");
export const ADMIN_PATTERNS = Object.freeze([
  new RegExp(`^${P} /getactivescheme$`),
  new RegExp(`^${P} /duplicatescheme ${G} ${K}$`),
  new RegExp(`^${P} /changename ${K} SalonKitClamp$`),
  new RegExp(`^${P} /set(ac|dc)valueindex ${K} ${esc(SUB_PROCESSOR)} (${SETTING_ALT}) \\d{1,6}$`),
  new RegExp(`^${P} /setactive (${K}|${G})$`),
  new RegExp(`^${P} /delete ${K}$`),
  new RegExp(`^${S} /create /tn ${BOOT_TASK} /sc onstart /ru SYSTEM /rl highest /f /tr "${C} /d /c ${P} /setactive ${G} & ${S} /delete /tn ${BOOT_TASK} /f"$`),
  new RegExp(`^${S} /query /tn ${BOOT_TASK}$`),
  new RegExp(`^${S} /delete /tn ${BOOT_TASK} /f$`)
]);
// OpenSSH's shell for the admin's commands: cmd.exe, option exactly "/d /c"
// (in "/c /d" the /d is text of the command and AutoRun still runs).
export function sshdShellOk(sh) {
  return /^C:\\Windows\\System32\\cmd\.exe$/i.test(String(sh?.defaultShell ?? "").trim()) && /^\/d \/c$/i.test(String(sh?.defaultShellCommandOption ?? "").trim());
}
// The snapshot scheme from the admin's own /getactivescheme (never from a
// file the standard account writes); never the kit's own.
export function origFromGetActive(out) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(out ?? ""));
  if (!m) throw new Error(`no scheme GUID in /getactivescheme: ${String(out).slice(0, 120)}`);
  const g = m[1].toLowerCase();
  if (g === KIT_SCHEME) throw new Error("the kit's scheme is active already: pc-run.mjs restore first");
  return g;
}
export function assertAdmin(line) {
  if (typeof line !== "string" || !ADMIN_PATTERNS.some((re) => re.test(line))) throw new Error(`refused: not one of the kit's administrator commands: ${String(line).slice(0, 160)}`);
  if (line.includes("/tr ") && line.slice(line.indexOf('"') + 1, -1).length > BOOT_TR_MAX) throw new Error(`schtasks /tr over ${BOOT_TR_MAX} characters (schtasks truncates silently)`);
  return line;
}

// ---- remote PowerShell
// A literal for PowerShell (single quotes: nothing expands).
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
// A script as -EncodedCommand takes it (UTF-16LE, base64): no quoting
// through ssh and cmd.exe, Windows OpenSSH's default shell.
export const encodePs = (script) => Buffer.from(script, "utf16le").toString("base64");
const PARAM = /^[A-Z][A-Za-z]+$/;
// The remote command line of one salon-pc.ps1 action, run by the kit's
// standard account (never elevated). With sha256 (the Mac's copy), the
// script on the PC is checked first: the measurement runs the code sent.
export function kitCommand(action, params = {}, { sha256 = null } = {}) {
  if (sha256 != null && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("kitCommand: bad sha256");
  const guard = sha256 ? `$f = ${psQuote(kitScript())}; if ((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash -ne ${psQuote(sha256.toUpperCase())}) { throw 'salon-pc.ps1 on the PC differs from the copy pc-run sent: refused' }; ` : "";
  const parts = [`${guard}& ${psQuote(kitScript())} -Action ${psQuote(action)}`];
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (!PARAM.test(k)) throw new Error(`bad parameter name ${k}`);
    parts.push(`-${k} ${typeof v === "number" ? String(Math.trunc(v)) : psQuote(v)}`);
  }
  return `${POWERSHELL} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePs(parts.join(" "))}`;
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
  // Never ok by default: an item whose probe failed (salon-pc.ps1's
  // probeErrors) or gave nothing is not ok. It blocks when the item blocks;
  // a warn or info item warns.
  const errs = check.probeErrors ?? {};
  const add = (id, level, ok, seen, fix = null, deps = []) => {
    const failed = deps.filter((d) => Object.keys(errs).some((k) => k === d || k.startsWith(`${d}.`)));
    if (failed.length) {
      ok = false;
      seen = `${seen} [unreadable: ${failed.map((d) => `${d}: ${errs[d] ?? Object.entries(errs).find(([k]) => k.startsWith(`${d}.`))?.[1]}`).join("; ")}]`;
    }
    if (failed.length && level === "info") level = "warn";
    items.push({ id, level: ok ? "ok" : level, seen, ...(ok ? {} : { fix }) });
  };
  const unread = "unreadable from the kit's account: see probeErrors, fix the probe or check by hand";
  const os = check.os ?? {};
  add("windows-11", "warn", Number(os.build) >= 22000, `${os.caption ?? "?"} build ${os.build ?? "?"}`, "J1b's target is Windows 11", ["os"]);
  const bat = check.power?.battery;
  const batOk = Array.isArray(bat) && bat.every((b) => b && b.BatteryStatus === 2);
  add("mains", "block", batOk, bat == null ? "battery state unknown" : bat.length ? `battery ${bat.map((b) => `${b?.EstimatedChargeRemaining ?? "?"}% status ${b?.BatteryStatus ?? "unknown"}`).join(", ")}` : "no battery (desktop)", bat == null ? `battery state ${unread}` : "plug the PC in: on battery Windows lowers the QoS and the frequency", ["battery"]);
  add("kit-not-elevated", "block", check.session?.elevated === false, `kit account ${check.session?.user ?? "?"}: ${check.session?.elevated ? "ELEVATED" : check.session?.elevated === false ? "standard" : "?"}`, "the kit's ssh must be a standard (non-administrator) account (salonkit): everything but the closed admin list runs there");
  const sh = check.sshd ?? {};
  const shellOk = sshdShellOk(sh);
  add("sshd-shell", "block", shellOk, `OpenSSH DefaultShell ${sh.defaultShell ?? "unset"}, DefaultShellCommandOption ${sh.defaultShellCommandOption ?? "unset"}`, "as admin, once: HKLM\\SOFTWARE\\OpenSSH DefaultShell = C:\\Windows\\System32\\cmd.exe and DefaultShellCommandOption = /d /c (no AutoRun before the admin commands)");
  const schemes = check.power?.schemes;
  add("kit-scheme-not-left", "block", Boolean(check.power?.activeScheme) && Array.isArray(schemes) && !check.power?.kitSchemeActive && !schemes.includes(KIT_SCHEME), `active scheme ${check.power?.activeScheme ?? "unknown"}${Array.isArray(schemes) ? "" : ", scheme list unknown"}`, "a previous job left the kit's scheme: pc-run.mjs restore --job <that job>", ["power", "schemes"]);
  const ovl = String(check.power?.overlayAc ?? "").toLowerCase();
  add("power-mode", "warn", !ovl || ovl === "00000000-0000-0000-0000-000000000000" || ovl === "ded574b5-45a0-4f42-8737-46345c09c238", `power mode overlay (AC) ${ovl || "none"}`, "Settings > System > Power: 'Balanced' or 'Best performance' on mains (best power efficiency throttles)");
  add("unlocked-session", "block", !check.session?.lockScreenUp && (check.session?.sessions ?? []).some((s) => /\|Active\||\|Actif\||\bActive\b|\bActif\b/i.test(s)), `sessions ${JSON.stringify(check.session?.sessions ?? null)}, lock screen ${check.session?.lockScreenUp ? "up" : "down"}`,
    "log on at the PC and leave the desktop unlocked (screen saver and sleep off for the session): a locked or hidden window is EcoQoS", ["sessions"]);
  for (const b of browsers) {
    const v = b === "msedge" ? check.browsers?.edge : check.browsers?.chrome;
    add(`browser-${b}`, "block", Boolean(v?.version), v ? `${v.version} (${v.path})` : "not installed", `install ${b === "msedge" ? "Edge" : "Chrome"} stable (the kit never installs a browser)`, [b === "msedge" ? "edge" : "chrome"]);
  }
  // only the adapters present now: a driver left for a card taken out
  // stays in the registry (present null: not known, never counted)
  const allGpus = check.gpus ?? [];
  const gpus = allGpus.filter((g) => g?.present === true);
  const smi = Array.isArray(check.nvidia) ? check.nvidia : [];
  const nvidia = [...gpus.filter((g) => /nvidia/i.test(g.name)), ...smi];
  add("gpu-dgpu", "warn", nvidia.length > 0, allGpus.map((g) => `${g.name} (driver ${g.driver}, ${g.driverDate ?? "?"}, ${g.present === true ? "present" : g.present === false ? "ABSENT" : "presence unknown"})`).join("; ") + (smi.length ? `; nvidia-smi: ${smi.map((g) => g.name).join(", ")}` : "") || "none", "J1b targets an RTX 3060 class GPU: record what this one is", ["gpus"]);
  add("igpu-present", check.gpus == null ? "warn" : "info", check.gpus != null && gpus.length <= 1, `${gpus.length} display adapters present`, "with an iGPU too, Chrome may composite on it: check the adapter of pc-bench/webgpu-adapter, set chrome.exe/msedge.exe to 'High performance' in Settings > Display > Graphics", ["gpus"]);
  const rates = [...(check.display ?? []), ...allGpus].map((g) => Number(g?.refreshHz) || 0).filter((x) => x > 0);
  add("refresh-60", "warn", rates.length > 0 && rates.every((hz) => hz >= 59 && hz <= 61), rates.length ? `${rates.join(", ")} Hz` : "refresh rate unknown", rates.length ? "the J1a figures are at 60 Hz: set the screen to 60 Hz for the J1b runs (and record it), or measure 144 Hz separately" : "refresh rate not readable by the kit's account: read it at the PC (Settings > Display > Advanced display) and record it", ["display"]);
  const pol = { ...(check.policies?.chromeMachine ?? {}), ...(check.policies?.chromeUser ?? {}) };
  add("chrome-jit-policy", "block", check.policies != null && pol.DefaultJavaScriptJitSetting !== 2 && pol.DefaultJavaScriptOptimizerSetting !== 2 && pol.HardwareAccelerationModeEnabled !== 0,
    check.policies == null ? "Chrome policies unknown" : `Chrome policies ${JSON.stringify(pol)}`, "a policy blocks the JIT, the optimizer or the GPU: measure is meaningless", ["policies"]);
  const epol = { ...(check.policies?.edgeMachine ?? {}), ...(check.policies?.edgeUser ?? {}) };
  if (browsers.includes("msedge")) {
    add("edge-esm-policy", "warn", epol.EnhanceSecurityMode == null || epol.EnhanceSecurityMode === 0, `Edge EnhanceSecurityMode ${epol.EnhanceSecurityMode ?? "unset"}`, "enhanced security runs Wasm in an interpreter: the bench says which mode ran", ["policies"]);
  }
  const mem = check.memory ?? {};
  add("memory", mem.totalGiB == null ? "warn" : "info", mem.totalGiB != null && mem.totalGiB <= 17, `${mem.totalGiB ?? "?"} GiB (free ${mem.freeGiB ?? "?"})`, "more than the 16 GB target (or unknown): memory is not clamped (Salon commits ~1.5 GiB; noted, not corrected)", ["memory"]);
  add("disk", "block", (check.disk?.freeGiB ?? 0) >= 5, `${check.disk?.freeGiB ?? "?"} GiB free on ${check.disk?.drive ?? "?"}:`, "free 5 GB for the kit (tree, node, profiles, results)", ["disk"]);
  const aff = check.classAffinity;
  add("class-affinity", "block", Boolean(aff?.mask) && !aff.error, aff?.error ?? `${aff?.cores} cores / ${aff?.threads} threads, class ${aff?.efficiencyClass}${aff?.hybrid ? " (hybrid CPU: E-cores excluded)" : ""}, mask ${aff?.mask}`, "the CPU has fewer than 6 cores of its fastest class", ["coreMap"]);
  add("smt", "warn", Boolean(aff?.mask) && aff.threads === 2 * aff.cores, aff?.mask ? `${aff.threads} threads on ${aff.cores} cores` : "?", "no SMT on this CPU (e.g. Core Ultra 200S): 6 threads instead of the i5-12400's 12", ["coreMap"]);
  add("gb6-known", "warn", Boolean(gb6Of(check.cpu?.name ?? "")), `${check.cpu?.name ?? "?"}`, "host CPU not in the public table: pass --host-gb6 <score> with its source", ["cpu"]);
  const busy = check.cpuBusy?.otherPctOfOneCore;
  const partial = check.cpuBusy?.partial === true;
  add("idle", "warn", busy != null && busy < 25 && !partial, `other processes ${busy ?? "?"} % of one core${partial ? " (PARTIAL: only the kit account's own processes seen)" : ""} (${(check.cpuBusy?.top ?? []).map((t) => `${t.name} ${t.pct}`).join(", ")})`, busy == null || partial ? "the other processes' CPU could not be read: check Task Manager at the PC before measuring" : "close what runs (updates, indexing, games launchers) before measuring", ["cpuBusy"]);
  add("hvci", "info", true, `memory integrity ${check.security?.memoryIntegrity ?? "unknown"}`, null);
  add("hags", "info", true, `hardware-accelerated GPU scheduling ${check.hags === 2 ? "on" : check.hags === 1 ? "off" : "default"}`, null);
  for (const [b, r] of Object.entries(bench)) {
    const st = r?.perRun?.[0]?.state ?? r?.state;
    if (!st) continue;
    add(`page-visible-${b}`, "block", st.visibility === "visible", `visibility ${st.visibility}, focus ${st.focus}`, "the browser window is hidden or occluded: nothing in front of it, screen unlocked");
    add(`page-focus-${b}`, "warn", st.focus === true, `focus ${st.focus}`, "the window has no focus (QoS Medium): click into it once, or close what took the focus");
    const raf = st.rafMs?.p50;
    add(`raf-${b}`, "block", raf == null || raf < 25, `rAF p50 ${raf ?? "?"} ms`, "rAF at 30 Hz: an energy saver (browser or Windows) or a 30 Hz screen");
    // r.jit: pc-bench classifyJit against this machine's Chrome and
    // Chrome-without-optimizer references (pc-run adds it)
    if (r?.jit) {
      const v = r.jit.verdict;
      const level = b === "chrome" ? "block" : "warn"; // Edge's mode is the Edge result itself (protocol §5)
      add(`jit-${b}`, level, v === "jit" || (b === "chrome" && v === "unknown"), `${v} (x${r.jit.factor ?? "?"} Chrome's hot ns; Liftoff reference x${r.jit.gap ?? "?"})`,
        v === "interpreter" ? "Wasm interpreted (Edge enhanced security): the site exception, then reload" : "the optimizing tier is off (JavaScript optimization setting or policy)");
    }
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
  // other processes read from the account's own only: the load is unknown
  if (rows.length && rows.every((r) => r.otherPartial)) reasons.push("other processes' CPU unreadable (the account sees only its own): load unknown");
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

// The steps' windows from the job's log (salon-pc.ps1 inner):
// "[ISO time] step NAME: node ..." then "[ISO time] step NAME: exit N".
export function stepWindows(logText) {
  const w = {};
  for (const l of String(logText ?? "").split(/\r?\n/)) {
    const m = /^\uFEFF?\[([^\]]+)\] step (\S+): (node |exit (-?\d+))/.exec(l);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (m[4] == null) w[m[2]] = { from: t, to: null, exit: null };
    else if (w[m[2]]) Object.assign(w[m[2]], { to: t, exit: Number(m[4]) });
  }
  return w;
}
// Sampler rows inside a window (a row is the 5 s ending at its time).
export const rowsIn = (rows, { from, to }) => rows.filter((r) => { const t = Date.parse(r.t); return t > from && (to == null || t - 5000 < to); });
// The bench at both ends of a series against the calibration's target
// (protocol §2: within ±3 %).
export const BENCH_HOLD_PCT = 3;
export function benchHold(score, target) {
  if (!(score > 0) || !(target > 0)) return { ok: false, offPct: null };
  const offPct = Math.round((score / target - 1) * 1000) / 10;
  return { ok: Math.abs(offPct) <= BENCH_HOLD_PCT, offPct };
}
// A cell's runs whose browser version is not the cell's most common one.
export function versionOutliers(runs) {
  const count = new Map();
  for (const r of runs) count.set(r.browserVersion ?? null, (count.get(r.browserVersion ?? null) ?? 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return runs.filter((r) => (r.browserVersion ?? null) !== top);
}

// What a restore must give back: the snapshot's scheme active, the kit's
// scheme gone, the scheme list and the processor settings as before, the
// job's task and processes gone, its TEMP gone, the boot task gone.
// before: the snapshot; after: cleanup's reading (+ bootTask from the
// admin's query: true while it exists).
export function restoreDiff(before, after, job) {
  const d = [];
  if (!before) return ["no snapshot to compare with"];
  const p = after.power ?? after;
  if (p.activeScheme !== before.activeScheme) d.push(`active scheme ${p.activeScheme}, was ${before.activeScheme}`);
  if ((p.schemes ?? []).includes(KIT_SCHEME)) d.push("the kit's power scheme still exists");
  const set = (x) => JSON.stringify([...(x ?? [])].sort());
  if (set(p.schemes) !== set(before.schemes)) d.push(`schemes ${set(p.schemes)}, were ${set(before.schemes)}`);
  if (JSON.stringify(p.processor) !== JSON.stringify(before.processor)) d.push(`processor settings ${JSON.stringify(p.processor)}, were ${JSON.stringify(before.processor)}`);
  if ((after.tasks ?? []).includes(job)) d.push(`scheduled task \\SalonKit\\${job} still registered`);
  if (after.bootTask) d.push(`the boot task ${BOOT_TASK} still exists`);
  // a process list the PC could not read is a difference: unknown, not "none left"
  if (after.jobProcesses == null) d.push("job processes unknown (not read): not verified gone");
  else if (after.jobProcesses.length) d.push(`job processes still running: ${after.jobProcesses.map((x) => `${x.name} ${x.pid}`).join(", ")}`);
  if (before.kitProcesses == null || after.kitProcesses == null) d.push(`kit processes unknown (not read ${before.kitProcesses == null ? "at the snapshot" : "after the cleanup"}): not verified restored`);
  else {
    const was = new Set(before.kitProcesses.map((x) => x.pid));
    const extra = after.kitProcesses.filter((x) => !was.has(x.pid));
    if (extra.length) d.push(`kit processes left: ${extra.map((x) => `${x.name} ${x.pid}`).join(", ")}`);
  }
  if (after.jobTmp) d.push("the job's TEMP folder is still there");
  return d;
}

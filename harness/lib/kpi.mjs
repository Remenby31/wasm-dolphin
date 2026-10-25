// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The program's KPI table (PROGRAM.md, « KPI du programme »), in its order.
// Pure: harness/kpi-report.mjs walks the result directories, hands every
// JSON it finds to `classify`, and attaches what each result served.
//
// Only trunk is reported: a result counts when the tree it measured (the
// `served` identity the harness records: commit, dirty) is a clean commit on
// origin/main's first-parent history. Branches, worktrees with local changes
// and plumbing checks (--no-lock) are left out. Each row reads one result,
// the newest of its kinds on trunk, and shows it (file, commit, date); it
// never falls back on an older result nor combines two. A result whose runs
// failed makes its row KO, with the reasons.
//
// Each row says where its value comes from: "measured" (a probe's file),
// "declared" (measures/kpi/manual.json, for what no probe measures yet: the
// PC extrapolation, the discovery coverage, the memory cost), or "n/a".

// What a result file is, from its content (never from its directory name).
import { gameFpsTarget } from "./matrix.mjs";

export function classify(json, file = "") {
  if (!json || typeof json !== "object") return null;
  if (json.locked === false) return null; // a plumbing check (--no-lock), not a measure
  if (json.probe === "race-perf" || (json.state && json.candidate && "change" in json && json.query)) return "race-perf";
  if (json.probe === "ttff") return "ttff";
  if (json.probe === "first-launch") return "first-launch";
  if (json.probe === "first-launch-ramp") return "first-launch-ramp";
  if (json.decision && json.correctness) return "gate";
  if (json.interpQuery && json.jitQuery && Array.isArray(json.results)) return "fuzz";
  if (json.spec?.name && /freeze/.test(json.spec.name) && Array.isArray(json.results)) return "freeze-loop";
  if ("perturb" in json && Array.isArray(json.runs) && json.runs.every((r) => "verdict" in r)) return "wgpu-freeze";
  return null;
}

// When a result was produced: its own date, else the file's.
export const resultTime = (r) => Date.parse(r.json.at ?? r.json.machine?.at ?? "") || r.mtimeMs || 0;

// One identity when every entry agrees, else null (a mixed result).
function single(list) {
  const got = list.filter(Boolean);
  if (!got.length || got.some((x) => x.commit !== got[0].commit || x.dirty !== got[0].dirty)) return null;
  return got[0];
}

// What each side of a result served ({ commit, dirty }), from the result or
// from the files next to it (`extra`, loaded by kpi-report: race-perf's
// run*.json, the gate's candidate/summary.json).
export function servedSides(r) {
  const j = r.json;
  switch (r.kind) {
    case "race-perf": {
      if (j.served) return j.served;
      const runs = r.extra?.runs ?? [];
      return Object.fromEntries(["candidate", "baseline"].map((n) => [n, single(runs.map((x) => x[n]?.served))]));
    }
    case "freeze-loop": return { candidate: single(j.results.map((x) => x.served)) };
    case "gate": return { candidate: single((r.extra?.candidate?.results ?? []).map((x) => x.served)) };
    default: return { candidate: j.served ?? null };
  }
}

// Configurations of the race-perf and TTFF rows (judge, 2026-10-22): the
// product is what the Salon site ships and is what the global status counts;
// the harness's own renderer queries ("default"/"aot") are trajectory rows.
// The site is told by its engine parameters, salon packages/core/src/
// emulator.ts BASE_PARAMS (pacing=tick, absent from the harness's renderer
// queries; the software renderer counts as the site too, as before), not by
// its renderer alone: it shipped video=software until 2026-10-24 and ships
// video=wgpu (renderer.ts WGPU_DEFAULT) with aot=1 (fast profile) since
// salon 9a3dfbf.
export const CONFIGS = {
  product: { aot: false, product: true, label: "site tel que livré (paramètres Salon), sans aot" },
  productAot: { aot: true, product: true, label: "site tel que livré (paramètres Salon), aot=1 (profil rapide depuis salon 9a3dfbf)" },
  default: { aot: false, product: false, label: "rendu matériel (video=wgpu), sans aot=1" },
  aot: { aot: true, product: false, label: "rendu matériel (video=wgpu), aot=1" }
};
const queryOf = (j, side, kind) => new URLSearchParams(String((kind === "ttff" || side !== "baseline" ? j.query : j.baselineQuery ?? j.query) ?? ""));
// The hardware rows take the harness's renderer queries (video=wgpu, or no
// video= for the harness default), never video=null, which renders nothing
// (2026-10-24: a video=null run filled the wgpu rows).
const sideVideo = (j, side, kind) => queryOf(j, side, kind).get("video");
export const sideIsProduct = (j, side, kind = "race-perf") => queryOf(j, side, kind).get("pacing") === "tick" || sideVideo(j, side, kind) === "software";
// The race rows read the race scene only: a race-perf run on another
// savestate (the heavy scene, heavy-*.sav) is not the race (2026-10-25: the
// night campaign's heavy runs, newer, filled the race speed and headroom rows).
export const raceScene = (j) => !/heavy/i.test(String(j?.state ?? "").split("/").pop());
export function fitsConfig(r, side, config) {
  if (!config || !["race-perf", "ttff", "first-launch-ramp"].includes(r.kind)) return true;
  if (r.kind === "race-perf" && !raceScene(r.json)) return false;
  const want = CONFIGS[config];
  const aot = r.kind === "ttff" ? ttffHasAot(r.json)
    : r.kind === "first-launch-ramp" ? queryOf(r.json, side, r.kind).get("aot") === "1"
    : sideHasAot(r.json, side);
  const video = sideVideo(r.json, side, r.kind);
  return aot === want.aot && video !== "null" && sideIsProduct(r.json, side, r.kind) === want.product;
}

// The side of `r` that measured trunk (candidate first) in `config`, or null.
export function trunkSide(r, trunk, { config = null } = {}) {
  const sides = servedSides(r);
  const onTrunk = (s) => s && s.dirty === false && typeof s.commit === "string" && trunk.has(s.commit);
  const order = r.kind === "race-perf" ? ["candidate", "baseline"] : ["candidate"];
  const side = order.find((n) => onTrunk(sides[n]) && fitsConfig(r, n, config));
  return side ? { side, commit: sides[side].commit } : null;
}

// Speed measured on this Mac's stock Chrome: an E-core wrapper or extra
// flags measure something else (the P9 extrapolation).
// What a side ran on, for comparing two summaries: the machine (spark-run
// stamps `host`; none = this Mac) and the Chrome arguments, shared and the
// side's own. Absent arguments are none: before PR #145 a Spark summary had
// none (race-multi recorded no chrome at all), after it the V8 flag; the two
// must never be compared.
export function setupOf(json, side = "candidate") {
  const args = [json?.chrome?.args ?? "", json?.chrome?.sideArgs?.[side] ?? ""].map((a) => String(a).trim()).filter(Boolean).join(" ");
  return { host: json?.host ?? null, chromePath: json?.chrome?.path ?? null, chromeArgs: args };
}

// Why two setups are not comparable ([] when they are).
export function setupDifferences(a, b) {
  const why = [];
  if (a.host !== b.host) why.push(`machine ${a.host ?? "Mac"} ≠ ${b.host ?? "Mac"}`);
  if (a.chromeArgs !== b.chromeArgs) why.push(`arguments Chrome « ${a.chromeArgs || "aucun"} » ≠ « ${b.chromeArgs || "aucun"} »`);
  if (a.chromePath && b.chromePath && a.chromePath !== b.chromePath) why.push(`Chrome ${a.chromePath} ≠ ${b.chromePath}`);
  return why;
}

// Trunk's race rows: this Mac's stock Chrome, no arguments (absoluteRace).
export const TRUNK_SETUP = Object.freeze({ host: null, chromePath: "chrome stable", chromeArgs: "" });

export const stockChrome = (json) => !json.chrome || (json.chrome.path === "chrome stable" && !json.chrome.args && !Object.keys(json.chrome.sideArgs ?? {}).length);

// Absolute numbers (race speed, p99, shares) come from night measures, run
// with a load limit of 6 at most (rule of 2026-10-20); day pairs at a higher
// limit only compare two sides and never feed trunk's rows. A summary that
// does not say its limit is left out too.
export const ABSOLUTE_MAX_LOAD = 6;
export const nightMeasure = (json) => Number.isFinite(json.maxLoad) && json.maxLoad <= ABSOLUTE_MAX_LOAD;
// Measured on another machine (harness/remote/spark-run.mjs stamps `host`):
// a relative pair only, never a number for trunk's rows.
export const thisMac = (json) => !json.host;
export const absoluteRace = (json) => thisMac(json) && stockChrome(json) && nightMeasure(json);

const med = (d) => d?.median ?? null;

// Whether a race-perf side ran with the region recompiler: aot=1 in its
// query, unless its core is known to have none (a core before P4 ignores
// aot=1 and runs as the default: its p4Why says it has no region stats).
export function sideHasAot(j, side) {
  const asked = new URLSearchParams(String((side === "baseline" ? j.baselineQuery ?? j.query : j.query) ?? "")).get("aot") === "1";
  const why = side === "baseline" ? j.baselineP4Why : j.p4Why;
  return asked && !/no DolphinWeb_JitRegionStats|engine without validationReadJitRegionStats/.test(String(why ?? ""));
}

// A TTFF run with the recompiler: aot=1 in its query, unless every launch saw
// it inactive (a core without it, or switched off).
export function ttffHasAot(j) {
  const asked = new URLSearchParams(String(j.query ?? "")).get("aot") === "1";
  const states = [j.aot?.cold?.states, j.aot?.warm?.states].flat().filter((x) => x !== undefined);
  return asked && !(states.length && states.every((st) => st == null || st === "disabled" || st === "unsupported"));
}

// The switches a race-perf side booted with (its own query: --baseline-query).
export function sideFlags(j, side) {
  const q = new URLSearchParams(String((side === "baseline" ? j.baselineQuery ?? j.query : j.query) ?? ""));
  return ["video", "speed", "aot", "jitoffthread", "aotcompiler"].filter((k) => q.has(k))
    .map((k) => (k === "aot" && q.get(k) === "1" && !sideHasAot(j, side) ? "aot=1 sans effet (cœur sans régions)" : `${k}=${q.get(k)}`)).join("&") || null;
}
const cold = (j, side) => j[side]?.cold ?? null;
// Headroom in % (race-perf --headroom), only where the throttle slept.
const headroomPct = (j, side) => {
  const c = cold(j, side);
  return c?.headroom?.median != null && c.headroomApplies ? Math.round(c.headroom.median * 1000) / 10 : null;
};
const headroomWhy = (j, side) => {
  const c = cold(j, side);
  if (!c?.headroom) return c?.headroomWhy ?? "pas de mesure --headroom";
  return c.headroomApplies ? null : "le jeu tourne sous 100 % (pas de sommeil du throttle) : voir la vitesse";
};
const p4Of = (j, side) => (side === "baseline" ? j.baselineP4 : j.p4);
const idleNote = (p) => [
  p?.idleCycleShare != null ? `idle skip : ${Math.round(p.idleCycleShare * 1000) / 10} % des cycles` : null,
  p?.idleTimeShare != null ? `attente : ${Math.round(p.idleTimeShare * 1000) / 10} % du temps, à part` : null
].filter(Boolean).join(" ; ") || null;
const p4Why = (j, side) => {
  if (p4Of(j, side) !== undefined) return (side === "baseline" ? j.baselineP4Why : j.p4Why) ?? "pas de compteurs P4 dans ce résultat";
  return "race-perf antérieure aux compteurs P4";
};
// race-perf runs that failed for another reason than the machine's load or
// the harness losing Chrome (infra).
const raceFailures = (j, side) => (j.failed ?? []).filter((f) => f.side === side && f.why !== "overloaded" && f.why !== "infra").map((f) => `run ${f.run} : ${f.why}`);
const launchFailures = (phase) => (phase?.failed ?? []).map((f) => `run ${f.run} : ${f.error}`);
// Why a TTFF phase has no value: runs left out (overloaded machine, Chrome lost by the harness).
const rampFailures = (j) => (j.failed ?? []).map((f) => `run ${f.run} : ${f.why}`);
const rampDetail = (j) => `images de jeu utiles depuis le début de la scène : 95 % à ${j.timeToFullMs?.median ?? "n/a"} ms, plateau ${j.plateauSpeed?.median ?? "?"} %, 90 % du plateau à ${j.timeToTail90Ms?.median ?? "n/a"} ms ; vitesse VI plateau ${j.vi?.plateauSpeed?.median ?? "?"} % ; régions ${j.regionsAt90?.median ?? "?"} à 90 % / ${j.regionsAtEnd?.median ?? "?"} en fin (${j.windowSec} s après la scène)`;
const ttffWhy = (j, phase) => [
  j.overloadedRuns?.length ? `runs ${j.overloadedRuns.join(", ")} lancées sur machine surchargée, exclues` : null,
  j[phase]?.infra?.length ? `runs ${j[phase].infra.map((x) => x.run).join(", ")} perdues par le harnais (pipe CDP), exclues` : null
].filter(Boolean).join(" ; ") || null;

// What the second aot=1 launch really ran with: the regions the core
// installed at boot (or the P7 install event on an older probe), and those it
// refused for another heap layout (0078).
function warmRegionNote(w) {
  const refused = (w?.layoutRefused ?? []).filter((n) => n > 0);
  if (w?.withRegionCache) return `régions installées au boot (${w.installedBy ?? "install event"}) : ${w.regionsInstalled.join(", ")}`;
  if (refused.length) return `SANS cache de régions : refusées pour une autre disposition du tas (${w.layoutRefused.join(", ")})`;
  return "SANS cache de régions : pas un vrai 2e lancement";
}

// A caveat is printed under its group's table, whatever the value: it is
// about what the row measures, not about one result.
// Dispatch (judge, 2026-10-21): with the stats on, each timed region call
// reads the clock about 4 times, partly counted outside the region, so the
// dispatch share overstates the real cost (cutting the round trips by 2.4
// gave about 1 % of speed).
const DISPATCH_CAVEAT = "indicateur gonflé par l'instrumentation : en mode stats, chaque appel de région chronométré ajoute environ 4 lectures d'horloge, dont une partie comptée hors région ; diviser par 2,4 les allers-retours n'a donné qu'environ 1 % de vitesse. À confronter à une mesure moins intrusive (fenêtre de stats à échantillonnage plus rare, `--region-sample`) avant d'en tirer un gain attendu.";

// The rows, in PROGRAM.md's order. `better`: "higher" | "lower" | "zero" | "true".
// read(json, side, kind) → value; failures(json, side, kind) → reasons that make the row KO.
export const KPI_ROWS = [
  { id: "pcSpeed", group: "North star", label: "Vitesse course, PC grand public milieu de gamme (modèle P9)", target: 95, unit: "%", better: "higher", from: "manual" },
  // The product config counts in the global status; the hardware renderer
  // and aot=1 are trajectory rows (counted: false: shown, verdict given, left
  // out of the counts). Judge, 2026-10-22.
  // The main KPI (judge, 2026-10-22): the headroom at speed=1
  // (research/deep-headroom-kpi.md), min of the CPU thread's Max and the GPU
  // bound, from race-perf --headroom; read only from a run that slept in the
  // throttle (headroomApplies), otherwise the game is under 100 % and the
  // speed row says it.
  // The product KPI (judge, 2026-10-23): with SyncOnSkipIdle off the
  // product's emulated time runs ahead of its rendering, so its speed and
  // headroom overstate it; what the player gets is the game images per host
  // second. Target: 95 % of the scene's native rate (matrix.mjs
  // SCENE_NATIVE_FRAMES_PER_VI, measured on a coupled reference).
  { id: "macGameFpsProduct", group: "Leviers", label: "Images de jeu utiles par seconde, Mac M4 Pro, config produit", target: null, targetOf: (j) => gameFpsTarget(j.state), unit: "i/s", better: "higher", from: "race-perf", config: "product", read: (j, s) => med(cold(j, s)?.gameFramesPerSecond), why: headroomWhy, failures: raceFailures },
  { id: "macGameFpsProductAot", group: "Leviers", label: "Images de jeu utiles par seconde, config produit avec aot=1 (trajectoire, hors statut global)", target: null, targetOf: (j) => gameFpsTarget(j.state), unit: "i/s", better: "higher", from: "race-perf", config: "productAot", counted: false, read: (j, s) => med(cold(j, s)?.gameFramesPerSecond), why: headroomWhy, failures: raceFailures },
  { id: "macHeadroomProduct", group: "Leviers", label: "Marge Mac M4 Pro, config produit (headroom à speed=1, découplée tant que SyncOnSkipIdle=false, hors statut global)", target: 160, unit: "%", better: "higher", from: "race-perf", config: "product", counted: false, read: headroomPct, why: headroomWhy, failures: raceFailures },
  { id: "macHeadroomProductAot", group: "Leviers", label: "Marge Mac M4 Pro, config produit avec aot=1 (trajectoire, hors statut global)", target: 160, unit: "%", better: "higher", from: "race-perf", config: "productAot", counted: false, read: headroomPct, why: headroomWhy, failures: raceFailures },
  { id: "macHeadroom", group: "Leviers", label: "Marge Mac M4 Pro, rendu matériel wgpu (KPI CPU/GPU en mode couplé)", target: 160, unit: "%", better: "higher", from: "race-perf", config: "default", read: headroomPct, why: headroomWhy, failures: raceFailures },
  { id: "macHeadroomAot", group: "Leviers", label: "Marge Mac M4 Pro, wgpu + aot=1 (trajectoire piste 3, hors statut global)", target: 160, unit: "%", better: "higher", from: "race-perf", config: "aot", counted: false, read: headroomPct, why: headroomWhy, failures: raceFailures },
  { id: "macSpeedProduct", group: "Leviers", label: "Vitesse course, Mac M4 Pro, config produit (vitesse mesurée, plafonnée par speed=, hors statut global)", target: 100, unit: "%", better: "higher", from: "race-perf", config: "product", counted: false, read: (j, s) => med(cold(j, s)?.speed), failures: raceFailures },
  { id: "macSpeedProductAot", group: "Leviers", label: "Vitesse course, Mac M4 Pro, config produit avec aot=1 (trajectoire, hors statut global)", target: 160, unit: "%", better: "higher", from: "race-perf", config: "productAot", counted: false, read: (j, s) => med(cold(j, s)?.speed), failures: raceFailures },
  { id: "macSpeed", group: "Leviers", label: "Vitesse course, Mac M4 Pro, rendu matériel wgpu (trajectoire, hors statut global)", target: 160, unit: "%", better: "higher", from: "race-perf", config: "default", counted: false, read: (j, s) => med(cold(j, s)?.speed), failures: raceFailures },
  { id: "macSpeedAot", group: "Leviers", label: "Vitesse course, Mac M4 Pro, wgpu + aot=1 (trajectoire piste 3, hors statut global)", target: 160, unit: "%", better: "higher", from: "race-perf", config: "aot", counted: false, read: (j, s) => med(cold(j, s)?.speed), failures: raceFailures },
  // Outside idle skip only (PROGRAM.md, 2026-10-20): a core without
  // idleCycles gives the raw share, shown in the reason, not as the KPI.
  { id: "regionCycleShare", group: "Leviers", label: "Part des cycles invités en régions, hors idle skip", target: 0.9, unit: "share", better: "higher", from: "race-perf", config: "aot", read: (j, s) => (p4Of(j, s)?.cycleBasis === "outside idle skip" ? p4Of(j, s).regionCycleShare : null), why: (j, s) => (p4Of(j, s)?.regionCycleShare != null ? `cœur sans idleCycles : part brute ${Math.round(p4Of(j, s).regionCycleShare * 1000) / 10} %, idle compris` : p4Why(j, s)), detail: (j, s) => idleNote(p4Of(j, s)), failures: raceFailures },
  { id: "regionTimeShare", group: "Leviers", label: "Part du temps CPU en code de région, hors attente", target: 0.9, unit: "share", better: "higher", from: "race-perf", config: "aot", read: (j, s) => p4Of(j, s)?.regionTimeShare ?? null, why: p4Why, detail: (j, s) => idleNote(p4Of(j, s)), failures: raceFailures },
  { id: "dispatchTimeShare", group: "Leviers", label: "Part du dispatch entre blocs, hors attente", target: 0.1, unit: "share", better: "lower", from: "race-perf", config: "aot", read: (j, s) => p4Of(j, s)?.dispatchTimeShare ?? null, why: p4Why, failures: raceFailures, caveat: DISPATCH_CAVEAT },
  { id: "discoveryCoverage", group: "Leviers", label: "Couverture de la découverte (PC distincts)", target: 99, unit: "%", better: "higher", from: "manual" },
  { id: "oracleDivergences", group: "Garde-fous", label: "Divergences à l'oracle (fuzz différentiel)", target: 0, unit: "", better: "zero", from: "fuzz", read: (j) => j.results.reduce((n, r) => n + (r.findings?.length ?? 0), 0) },
  { id: "gateGreen", group: "Garde-fous", label: "Gate de correction vert", target: true, unit: "", better: "true", from: "gate", read: (j) => Boolean(j.decision?.ok), detail: (j) => (j.decision?.ok ? null : j.decision?.reason ?? null) },
  { id: "freezes", group: "Garde-fous", label: "Gels sur 10 courses", target: 0, unit: "", better: "zero", from: ["freeze-loop", "wgpu-freeze"], read: (j, s, kind) => (kind === "freeze-loop" ? j.results.filter((r) => r.checks?.coreFreeze?.status === "fail").length : j.runs.filter((r) => r.verdict === "frozen").length), detail: (j, s, kind) => `sur ${(kind === "freeze-loop" ? j.results : j.runs).length} courses`, failures: (j, s, kind) => (kind === "freeze-loop" ? j.results.filter((r) => r.checks?.coreFreeze?.status === "unjudged").map((r) => `run ${r.run} non jugé`) : j.runs.filter((r) => r.verdict === "unjudged" || r.verdict === "crash").map((r) => `run ${r.run} : ${r.verdict}`)) },
  { id: "raceFrameP99Product", group: "Garde-fous", label: "p99 frame course, config produit", target: 33, unit: "ms", better: "lower", from: "race-perf", config: "product", read: (j, s) => med(cold(j, s)?.presentP99Ms), failures: raceFailures },
  { id: "raceFrameP99", group: "Garde-fous", label: "p99 frame course, rendu matériel wgpu (trajectoire, hors statut global)", target: 33, unit: "ms", better: "lower", from: "race-perf", config: "default", counted: false, read: (j, s) => med(cold(j, s)?.presentP99Ms), failures: raceFailures },
  { id: "raceFrameP99Aot", group: "Garde-fous", label: "p99 frame course, wgpu + aot=1 (hors statut global)", target: 33, unit: "ms", better: "lower", from: "race-perf", config: "aot", counted: false, read: (j, s) => med(cold(j, s)?.presentP99Ms), failures: raceFailures },
  { id: "aotcompilerMemory", group: "Garde-fous", label: "Surcoût mémoire aotcompiler", target: 150, unit: "Mo", better: "lower", from: "manual" },
  { id: "optimisationMs", group: "Expérience joueur", label: "Durée d'optimisation au 1er lancement", target: 60000, unit: "ms", better: "lower", from: "first-launch", read: (j) => j.p7?.durationMs ?? null, why: (j) => j.p7Why ?? null, failures: (j) => (j.p7?.failedFirst ?? []).map((f) => `run ${f.run} : ${f.why}`) },
  { id: "secondLaunchRecompiled", group: "Expérience joueur", label: "Régions recompilées au 2e lancement", target: 0, unit: "", better: "zero", from: "first-launch", read: (j) => j.p7?.secondLaunchCompiled ?? null, why: (j) => j.p7Why ?? null, failures: (j) => [...(j.p7?.failedFirst ?? []), ...(j.p7?.failedSecond ?? [])].map((f) => `run ${f.run} : ${f.why}`) },
  // First-launch ramp (first-launch-ramp.mjs): a fresh profile, aot=1, time
  // from the scene's start to 90 % of its native useful game frames per
  // second, held 5 s. Only results on that metric: the first version read
  // the VI speed, which the decoupled product holds at 100 % whatever the
  // game frames do (2026-10-23). Target 15 s; the heavy scene is CPU-bound under 90 % (2026-10-23: ~60 %),
  // so it stays out of the global status and its detail gives the plateau.
  { id: "firstLaunchRampRace", group: "Expérience joueur", label: "Rampe du 1er lancement, config produit (profil vierge, aot=1) : temps jusqu'à 90 % des images de jeu utiles, course", target: 15000, unit: "ms", better: "lower", from: "first-launch-ramp", config: "productAot", match: (j) => j.scene === "race" && j.metric === "game", read: (j) => j.timeTo90Ms?.median ?? null, detail: rampDetail, failures: rampFailures },
  { id: "firstLaunchRampHeavy", group: "Expérience joueur", label: "Rampe du 1er lancement, config produit (profil vierge, aot=1) : temps jusqu'à 90 % des images de jeu utiles, scène lourde (hors statut global)", target: 15000, unit: "ms", better: "lower", from: "first-launch-ramp", config: "productAot", counted: false, match: (j) => j.scene === "heavy" && j.metric === "game", read: (j) => j.timeTo90Ms?.median ?? null, detail: rampDetail, failures: rampFailures },
  // The target product once the wgpu freeze fix (0116) is in (judge, 2026-10-23).
  { id: "firstLaunchRampRaceWgpu", group: "Expérience joueur", label: "Rampe du 1er lancement, rendu matériel wgpu + aot=1 (profil vierge) : temps jusqu'à 90 % des images de jeu utiles, course (hors statut global)", target: 15000, unit: "ms", better: "lower", from: "first-launch-ramp", config: "aot", counted: false, match: (j) => j.scene === "race" && j.metric === "game", read: (j) => j.timeTo90Ms?.median ?? null, detail: rampDetail, failures: rampFailures },
  { id: "firstLaunchRampHeavyWgpu", group: "Expérience joueur", label: "Rampe du 1er lancement, rendu matériel wgpu + aot=1 (profil vierge) : temps jusqu'à 90 % des images de jeu utiles, scène lourde (hors statut global)", target: 15000, unit: "ms", better: "lower", from: "first-launch-ramp", config: "aot", counted: false, match: (j) => j.scene === "heavy" && j.metric === "game", read: (j) => j.timeTo90Ms?.median ?? null, detail: rampDetail, failures: rampFailures },
  { id: "ttffColdProduct", group: "Expérience joueur", label: "Time-to-first-frame, à froid, config produit", target: 10000, unit: "ms", better: "lower", from: "ttff", config: "product", read: (j) => med(j.cold?.firstContentMs), why: (j) => ttffWhy(j, "cold"), failures: (j) => launchFailures(j.cold) },
  { id: "ttffWarmProduct", group: "Expérience joueur", label: "Time-to-first-frame, à chaud, config produit", target: 10000, unit: "ms", better: "lower", from: "ttff", config: "product", read: (j) => med(j.warm?.firstContentMs), why: (j) => ttffWhy(j, "warm"), failures: (j) => launchFailures(j.warm) },
  { id: "ttffCold", group: "Expérience joueur", label: "Time-to-first-frame, à froid, rendu matériel wgpu (hors statut global)", target: 10000, unit: "ms", better: "lower", from: "ttff", config: "default", counted: false, read: (j) => med(j.cold?.firstContentMs), why: (j) => ttffWhy(j, "cold"), failures: (j) => launchFailures(j.cold) },
  { id: "ttffWarm", group: "Expérience joueur", label: "Time-to-first-frame, à chaud, rendu matériel wgpu (hors statut global)", target: 10000, unit: "ms", better: "lower", from: "ttff", config: "default", counted: false, read: (j) => med(j.warm?.firstContentMs), why: (j) => ttffWhy(j, "warm"), failures: (j) => launchFailures(j.warm) },
  { id: "ttffColdAot", group: "Expérience joueur", label: "Time-to-first-frame, à froid, aot=1 (hors statut global)", target: 10000, unit: "ms", better: "lower", from: "ttff", config: "aot", counted: false, read: (j) => med(j.cold?.firstContentMs), failures: (j) => launchFailures(j.cold) },
  // The second launch counts as such only with the region cache installed at boot.
  { id: "ttffWarmAot", group: "Expérience joueur", label: "Time-to-first-frame, 2e lancement, aot=1 (avec cache de régions, hors statut global)", target: 10000, unit: "ms", better: "lower", from: "ttff", config: "aot", counted: false, read: (j) => med(j.warm?.firstContentMs), detail: (j) => warmRegionNote(j.aot?.warm), failures: (j) => launchFailures(j.warm) },
];

export function meets(row, value) {
  if (value == null || typeof value === "string") return null;
  switch (row.better) {
    case "higher": return value >= row.target;
    case "lower": return value <= row.target;
    case "zero": return value === 0;
    case "true": return value === true;
    default: return null;
  }
}

// results: [{ kind, json, file, mtimeMs, extra? }]; trunk: Set of the
// commits of origin/main's first-parent history; manual: { id → { value,
// source, at, note } } or { error } when the file could not be read.
export function kpiTable(results, manual = {}, { trunk = new Set(), accept = { "race-perf": absoluteRace, "first-launch-ramp": absoluteRace } } = {}) {
  return KPI_ROWS.map((row) => {
    const base = { id: row.id, group: row.group, label: row.label, target: row.target, unit: row.unit, better: row.better, counted: row.counted !== false, caveat: row.caveat ?? null };
    if (row.from === "manual") {
      if (manual.error) return { ...base, value: null, status: "n/a", nature: "n/a", why: manual.error };
      const m = manual[row.id];
      if (!m || m.value == null) return { ...base, value: null, status: "n/a", nature: "n/a", why: "non mesuré, absent de manual.json" };
      if (typeof m.value !== "number" || !Number.isFinite(m.value)) return { ...base, value: null, status: "n/a", nature: "n/a", why: `manual.json : valeur non numérique (${JSON.stringify(m.value)})` };
      return { ...base, value: m.value, status: statusOf(meets(row, m.value)), nature: "declared", source: m.source ?? null, at: m.at ?? null, detail: m.note ?? null };
    }
    const kinds = [row.from].flat();
    const ofKinds = results.filter((r) => kinds.includes(r.kind) && (!row.match || row.match(r.json)));
    const all = ofKinds.filter((r) => !accept[r.kind] || accept[r.kind](r.json));
    const refused = ofKinds.length - all.length;
    const onTrunk = all.map((r) => ({ r, t: trunkSide(r, trunk, { config: row.config }) })).filter((x) => x.t).sort((a, b) => resultTime(b.r) - resultTime(a.r));
    if (!onTrunk.length && row.config && all.some((r) => trunkSide(r, trunk))) {
      return { ...base, value: null, status: "n/a", nature: "n/a", why: `aucune ${kinds.join(" / ")} en ${CONFIGS[row.config].label} sur trunk` };
    }
    if (!onTrunk.length) return { ...base, value: null, status: "n/a", nature: "n/a", why: `aucun résultat ${kinds.join(" / ")} sur un commit propre de trunk (${all.length} hors trunk ignoré(s)${refused ? `, ${refused} hors règle ignoré(s) : Chrome non standard ou mesure de jour, max-load > ${ABSOLUTE_MAX_LOAD}` : ""})` };
    const { r, t } = onTrunk[0];
    const source = { source: r.file, commit: t.commit, side: t.side, at: new Date(resultTime(r)).toISOString(), flags: r.kind === "race-perf" ? sideFlags(r.json, t.side) : null };
    const value = row.read(r.json, t.side, r.kind);
    const failures = row.failures?.(r.json, t.side, r.kind) ?? [];
    if (failures.length) return { ...base, value, status: "KO", nature: "measured", ...source, why: `${failures.length} run(s) en échec : ${failures.join(" ; ")}` };
    if (value == null) return { ...base, value: null, status: "n/a", nature: "n/a", ...source, why: row.why?.(r.json, t.side) ?? "valeur absente du résultat" };
    // A target that depends on the scene (targetOf): taken from the result.
    if (row.targetOf) {
      const target = row.targetOf(r.json);
      if (target == null) return { ...base, value, status: "n/a", nature: "measured", ...source, why: `scène ${r.json.state ?? "?"} sans référence d'images par VI mesurée (matrix.mjs SCENE_NATIVE_FRAMES_PER_VI)` };
      return { ...base, target, value, status: statusOf(meets({ ...row, target }, value)), nature: "measured", ...source, detail: row.detail?.(r.json, t.side, r.kind) ?? `cible ${target} i/s = 95 % du rythme natif de la scène ${r.json.state}` };
    }
    return { ...base, value, status: statusOf(meets(row, value)), nature: "measured", ...source, detail: row.detail?.(r.json, t.side, r.kind) ?? null };
  });
}

const statusOf = (ok) => (ok === true ? "OK" : ok === false ? "KO" : "n/a");

const fmt = (v, unit) => {
  if (v == null) return "n/a";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (unit === "share") return `${Math.round(v * 1000) / 10} %`;
  if (unit === "ms" && typeof v === "number" && v >= 1000) return `${Math.round(v / 100) / 10} s`;
  return `${v}${unit && unit !== "" ? ` ${unit}` : ""}`;
};
const cmp = { higher: "≥", lower: "≤", zero: "=", true: "=" };

// The candidate column: one race-perf result named by the operator (a PR's
// head, measured before it merges), its candidate side read by the same rows.
// Shown beside trunk, never in trunk's place: its own value, verdict, commit
// (and whether the tree had local changes) and query.
export function candidateColumn(r, { label = null, note = null } = {}) {
  if (r?.kind !== "race-perf") return null;
  const served = servedSides(r).candidate;
  const query = new URLSearchParams(String(r.json.query ?? ""));
  const flags = ["aot", "wasmjit", "jitoffthread"].filter((k) => query.has(k)).map((k) => `${k}=${query.get(k)}`).join("&");
  const header = { label: label ?? String(r.json.sides?.candidate ?? "candidate").split("/").pop(), note, maxLoad: r.json.maxLoad ?? null, source: r.file, commit: served?.commit ?? null, dirty: served?.dirty ?? null, flags, at: new Date(resultTime(r)).toISOString(),
    // Another machine or other Chrome arguments than trunk's rows: shown, flagged.
    setupDifferences: setupDifferences(setupOf(r.json, "candidate"), TRUNK_SETUP) };
  const values = {};
  for (const row of KPI_ROWS) {
    if (![row.from].flat().includes("race-perf")) continue;
    // A row of the other configuration (default vs aot=1) stays empty.
    if (!fitsConfig(r, "candidate", row.config)) continue;
    const value = row.read(r.json, "candidate", r.kind);
    const failures = row.failures?.(r.json, "candidate", r.kind) ?? [];
    const rowT = row.targetOf ? { ...row, target: row.targetOf(r.json) } : row;
    values[row.id] = { value, status: failures.length ? "KO" : statusOf(rowT.target == null && row.targetOf ? null : meets(rowT, value)), why: failures.length ? `${failures.length} run(s) en échec` : value == null ? row.why?.(r.json, "candidate") ?? null : null };
  }
  return { ...header, values };
}

export function kpiMarkdown(rows, { at = new Date().toISOString(), uptime = null, candidate = null } = {}) {
  const lines = [`# KPI du programme Salon`, "", `Généré le ${at}${uptime ? ` (charge : ${uptime})` : ""} par harness/kpi-report.mjs, dans l'ordre de PROGRAM.md. Seuls les résultats mesurés sur un commit propre de trunk comptent.`, ""];
  let group = null;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      lines.push(`## ${group}`, "", `| KPI | Valeur | Cible | État | Nature | Source |${candidate ? " Candidat |" : ""}`, `|---|---|---|---|---|---|${candidate ? "---|" : ""}`);
    }
    const note = r.why ?? r.detail;
    lines.push(`| ${r.label} | ${fmt(r.value, r.unit)}${note ? ` (${note})` : ""} | ${cmp[r.better]} ${fmt(r.target, r.unit)} | ${r.status} | ${{ measured: "mesuré", declared: "déclaré", "n/a": "n/a" }[r.nature]} | ${r.source ? `\`${r.source}\`${r.commit ? ` @ ${r.commit.slice(0, 8)}${r.side === "baseline" ? " (côté baseline)" : ""}${r.flags ? `, ${r.flags}` : ""}` : ""}${r.at ? `, ${r.at.slice(0, 16)}` : ""}` : "-"} |${candidate ? ` ${candidateCell(candidate.values[r.id], r.unit)} |` : ""}`);
    const next = rows[rows.indexOf(r) + 1];
    if (!next || next.group !== group) {
      lines.push("");
      for (const c of rows.filter((x) => x.group === group && x.caveat)) lines.push(`> **${c.label}** : ${c.caveat}`, "");
    }
  }
  if (candidate) {
    lines.push(`Colonne « Candidat » : \`${candidate.label}\`${candidate.note ? `, ${candidate.note}` : ""}${candidate.flags ? ` (${candidate.flags})` : ""}${candidate.maxLoad != null ? `, max-load ${candidate.maxLoad}` : ""}, \`${candidate.source}\` @ ${candidate.commit ? candidate.commit.slice(0, 8) : "?"}${candidate.dirty ? " avec modifications locales" : ""}, ${candidate.at.slice(0, 16)}. Mesure d'une branche avant fusion, à titre de comparaison : elle ne compte pas dans l'état des KPI.`, "");
    if (candidate.setupDifferences?.length) lines.push(`**Candidat NON comparable aux lignes de trunk** : ${candidate.setupDifferences.join(" ; ")}.`, "");
  }
  return lines.join("\n");
}

const candidateCell = (c, unit) => (!c ? "" : c.value == null ? `n/a${c.why ? ` (${c.why})` : ""}` : `${fmt(c.value, unit)} (${c.status})${c.why ? ` (${c.why})` : ""}`);

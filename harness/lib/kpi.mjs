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
export function classify(json, file = "") {
  if (!json || typeof json !== "object") return null;
  if (json.locked === false) return null; // a plumbing check (--no-lock), not a measure
  if (json.probe === "race-perf" || (json.state && json.candidate && "change" in json && json.query)) return "race-perf";
  if (json.probe === "ttff") return "ttff";
  if (json.probe === "first-launch") return "first-launch";
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

// The side of `r` that measured trunk (candidate first), or null.
export function trunkSide(r, trunk) {
  const sides = servedSides(r);
  const onTrunk = (s) => s && s.dirty === false && typeof s.commit === "string" && trunk.has(s.commit);
  const order = r.kind === "race-perf" ? ["candidate", "baseline"] : ["candidate"];
  const side = order.find((n) => onTrunk(sides[n]));
  return side ? { side, commit: sides[side].commit } : null;
}

// Speed measured on this Mac's stock Chrome: an E-core wrapper or extra
// flags measure something else (the P9 extrapolation).
export const stockChrome = (json) => !json.chrome || (json.chrome.path === "chrome stable" && !json.chrome.args);

// Absolute numbers (race speed, p99, shares) come from night measures, run
// with a load limit of 6 at most (rule of 2026-10-20); day pairs at a higher
// limit only compare two sides and never feed trunk's rows. A summary that
// does not say its limit is left out too.
export const ABSOLUTE_MAX_LOAD = 6;
export const nightMeasure = (json) => Number.isFinite(json.maxLoad) && json.maxLoad <= ABSOLUTE_MAX_LOAD;
export const absoluteRace = (json) => stockChrome(json) && nightMeasure(json);

const med = (d) => d?.median ?? null;
const cold = (j, side) => j[side]?.cold ?? null;
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
const ttffWhy = (j, phase) => [
  j.overloadedRuns?.length ? `runs ${j.overloadedRuns.join(", ")} lancées sur machine surchargée, exclues` : null,
  j[phase]?.infra?.length ? `runs ${j[phase].infra.map((x) => x.run).join(", ")} perdues par le harnais (pipe CDP), exclues` : null
].filter(Boolean).join(" ; ") || null;

// The rows, in PROGRAM.md's order. `better`: "higher" | "lower" | "zero" | "true".
// read(json, side, kind) → value; failures(json, side, kind) → reasons that make the row KO.
export const KPI_ROWS = [
  { id: "pcSpeed", group: "North star", label: "Vitesse course, PC grand public milieu de gamme (modèle P9)", target: 95, unit: "%", better: "higher", from: "manual" },
  { id: "macSpeed", group: "Leviers", label: "Vitesse course, Mac M4 Pro", target: 160, unit: "%", better: "higher", from: "race-perf", read: (j, s) => med(cold(j, s)?.speed), failures: raceFailures },
  // Outside idle skip only (PROGRAM.md, 2026-10-20): a core without
  // idleCycles gives the raw share, shown in the reason, not as the KPI.
  { id: "regionCycleShare", group: "Leviers", label: "Part des cycles invités en régions, hors idle skip", target: 0.9, unit: "share", better: "higher", from: "race-perf", read: (j, s) => (p4Of(j, s)?.cycleBasis === "outside idle skip" ? p4Of(j, s).regionCycleShare : null), why: (j, s) => (p4Of(j, s)?.regionCycleShare != null ? `cœur sans idleCycles : part brute ${Math.round(p4Of(j, s).regionCycleShare * 1000) / 10} %, idle compris` : p4Why(j, s)), detail: (j, s) => idleNote(p4Of(j, s)), failures: raceFailures },
  { id: "regionTimeShare", group: "Leviers", label: "Part du temps CPU en code de région, hors attente", target: 0.9, unit: "share", better: "higher", from: "race-perf", read: (j, s) => p4Of(j, s)?.regionTimeShare ?? null, why: p4Why, detail: (j, s) => idleNote(p4Of(j, s)), failures: raceFailures },
  { id: "dispatchTimeShare", group: "Leviers", label: "Part du dispatch entre blocs, hors attente", target: 0.1, unit: "share", better: "lower", from: "race-perf", read: (j, s) => p4Of(j, s)?.dispatchTimeShare ?? null, why: p4Why, failures: raceFailures },
  { id: "discoveryCoverage", group: "Leviers", label: "Couverture de la découverte (PC distincts)", target: 99, unit: "%", better: "higher", from: "manual" },
  { id: "oracleDivergences", group: "Garde-fous", label: "Divergences à l'oracle (fuzz différentiel)", target: 0, unit: "", better: "zero", from: "fuzz", read: (j) => j.results.reduce((n, r) => n + (r.findings?.length ?? 0), 0) },
  { id: "gateGreen", group: "Garde-fous", label: "Gate de correction vert", target: true, unit: "", better: "true", from: "gate", read: (j) => Boolean(j.decision?.ok), detail: (j) => (j.decision?.ok ? null : j.decision?.reason ?? null) },
  { id: "freezes", group: "Garde-fous", label: "Gels sur 10 courses", target: 0, unit: "", better: "zero", from: ["freeze-loop", "wgpu-freeze"], read: (j, s, kind) => (kind === "freeze-loop" ? j.results.filter((r) => r.checks?.coreFreeze?.status === "fail").length : j.runs.filter((r) => r.verdict === "frozen").length), detail: (j, s, kind) => `sur ${(kind === "freeze-loop" ? j.results : j.runs).length} courses`, failures: (j, s, kind) => (kind === "freeze-loop" ? j.results.filter((r) => r.checks?.coreFreeze?.status === "unjudged").map((r) => `run ${r.run} non jugé`) : j.runs.filter((r) => r.verdict === "unjudged" || r.verdict === "crash").map((r) => `run ${r.run} : ${r.verdict}`)) },
  { id: "raceFrameP99", group: "Garde-fous", label: "p99 frame course", target: 33, unit: "ms", better: "lower", from: "race-perf", read: (j, s) => med(cold(j, s)?.presentP99Ms), failures: raceFailures },
  { id: "aotcompilerMemory", group: "Garde-fous", label: "Surcoût mémoire aotcompiler", target: 150, unit: "Mo", better: "lower", from: "manual" },
  { id: "optimisationMs", group: "Expérience joueur", label: "Durée d'optimisation au 1er lancement", target: 60000, unit: "ms", better: "lower", from: "first-launch", read: (j) => j.p7?.durationMs ?? null, why: (j) => j.p7Why ?? null, failures: (j) => (j.p7?.failedFirst ?? []).map((f) => `run ${f.run} : ${f.why}`) },
  { id: "secondLaunchRecompiled", group: "Expérience joueur", label: "Régions recompilées au 2e lancement", target: 0, unit: "", better: "zero", from: "first-launch", read: (j) => j.p7?.secondLaunchCompiled ?? null, why: (j) => j.p7Why ?? null, failures: (j) => [...(j.p7?.failedFirst ?? []), ...(j.p7?.failedSecond ?? [])].map((f) => `run ${f.run} : ${f.why}`) },
  { id: "ttffCold", group: "Expérience joueur", label: "Time-to-first-frame, à froid", target: 10000, unit: "ms", better: "lower", from: "ttff", read: (j) => med(j.cold?.firstContentMs), why: (j) => ttffWhy(j, "cold"), failures: (j) => launchFailures(j.cold) },
  { id: "ttffWarm", group: "Expérience joueur", label: "Time-to-first-frame, à chaud", target: 10000, unit: "ms", better: "lower", from: "ttff", read: (j) => med(j.warm?.firstContentMs), why: (j) => ttffWhy(j, "warm"), failures: (j) => launchFailures(j.warm) }
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
export function kpiTable(results, manual = {}, { trunk = new Set(), accept = { "race-perf": absoluteRace } } = {}) {
  return KPI_ROWS.map((row) => {
    const base = { id: row.id, group: row.group, label: row.label, target: row.target, unit: row.unit, better: row.better };
    if (row.from === "manual") {
      if (manual.error) return { ...base, value: null, status: "n/a", nature: "n/a", why: manual.error };
      const m = manual[row.id];
      if (!m || m.value == null) return { ...base, value: null, status: "n/a", nature: "n/a", why: "non mesuré, absent de manual.json" };
      if (typeof m.value !== "number" || !Number.isFinite(m.value)) return { ...base, value: null, status: "n/a", nature: "n/a", why: `manual.json : valeur non numérique (${JSON.stringify(m.value)})` };
      return { ...base, value: m.value, status: statusOf(meets(row, m.value)), nature: "declared", source: m.source ?? null, at: m.at ?? null, detail: m.note ?? null };
    }
    const kinds = [row.from].flat();
    const ofKinds = results.filter((r) => kinds.includes(r.kind));
    const all = ofKinds.filter((r) => !accept[r.kind] || accept[r.kind](r.json));
    const refused = ofKinds.length - all.length;
    const onTrunk = all.map((r) => ({ r, t: trunkSide(r, trunk) })).filter((x) => x.t).sort((a, b) => resultTime(b.r) - resultTime(a.r));
    if (!onTrunk.length) return { ...base, value: null, status: "n/a", nature: "n/a", why: `aucun résultat ${kinds.join(" / ")} sur un commit propre de trunk (${all.length} hors trunk ignoré(s)${refused ? `, ${refused} hors règle ignoré(s) : Chrome non standard ou mesure de jour, max-load > ${ABSOLUTE_MAX_LOAD}` : ""})` };
    const { r, t } = onTrunk[0];
    const source = { source: r.file, commit: t.commit, side: t.side, at: new Date(resultTime(r)).toISOString() };
    const value = row.read(r.json, t.side, r.kind);
    const failures = row.failures?.(r.json, t.side, r.kind) ?? [];
    if (failures.length) return { ...base, value, status: "KO", nature: "measured", ...source, why: `${failures.length} run(s) en échec : ${failures.join(" ; ")}` };
    if (value == null) return { ...base, value: null, status: "n/a", nature: "n/a", ...source, why: row.why?.(r.json, t.side) ?? "valeur absente du résultat" };
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
  const header = { label: label ?? String(r.json.sides?.candidate ?? "candidate").split("/").pop(), note, maxLoad: r.json.maxLoad ?? null, source: r.file, commit: served?.commit ?? null, dirty: served?.dirty ?? null, flags, at: new Date(resultTime(r)).toISOString() };
  const values = {};
  for (const row of KPI_ROWS) {
    if (![row.from].flat().includes("race-perf")) continue;
    const value = row.read(r.json, "candidate", r.kind);
    const failures = row.failures?.(r.json, "candidate", r.kind) ?? [];
    values[row.id] = { value, status: failures.length ? "KO" : statusOf(meets(row, value)), why: failures.length ? `${failures.length} run(s) en échec` : value == null ? row.why?.(r.json, "candidate") ?? null : null };
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
    lines.push(`| ${r.label} | ${fmt(r.value, r.unit)}${note ? ` (${note})` : ""} | ${cmp[r.better]} ${fmt(r.target, r.unit)} | ${r.status} | ${{ measured: "mesuré", declared: "déclaré", "n/a": "n/a" }[r.nature]} | ${r.source ? `\`${r.source}\`${r.commit ? ` @ ${r.commit.slice(0, 8)}${r.side === "baseline" ? " (côté baseline)" : ""}` : ""}${r.at ? `, ${r.at.slice(0, 16)}` : ""}` : "-"} |${candidate ? ` ${candidateCell(candidate.values[r.id], r.unit)} |` : ""}`);
    const next = rows[rows.indexOf(r) + 1];
    if (!next || next.group !== group) lines.push("");
  }
  if (candidate) {
    lines.push(`Colonne « Candidat » : \`${candidate.label}\`${candidate.note ? `, ${candidate.note}` : ""}${candidate.flags ? ` (${candidate.flags})` : ""}${candidate.maxLoad != null ? `, max-load ${candidate.maxLoad}` : ""}, \`${candidate.source}\` @ ${candidate.commit ? candidate.commit.slice(0, 8) : "?"}${candidate.dirty ? " avec modifications locales" : ""}, ${candidate.at.slice(0, 16)}. Mesure d'une branche avant fusion, à titre de comparaison : elle ne compte pas dans l'état des KPI.`, "");
  }
  return lines.join("\n");
}

const candidateCell = (c, unit) => (!c ? "" : c.value == null ? `n/a${c.why ? ` (${c.why})` : ""}` : `${fmt(c.value, unit)} (${c.status})${c.why ? ` (${c.why})` : ""}`);

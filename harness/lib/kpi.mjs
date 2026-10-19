// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The program's KPI table (PROGRAM.md, « KPI du programme »), in its order,
// from the latest result of each probe. Pure: harness/kpi-report.mjs walks
// the result directories and hands every JSON it finds to `classify`.
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
  if (/manual\.json$/.test(file)) return "manual";
  return null;
}

// When a result was produced: its own date, else the file's.
export const resultTime = (r) => Date.parse(r.json.at ?? r.json.machine?.at ?? "") || r.mtimeMs || 0;

// Results a row may read, newest first; `accept` narrows a kind (e.g.
// stock Chrome only for race-perf).
export function newestOf(results, kinds, accept = {}) {
  return results.filter((r) => kinds.includes(r.kind) && (!accept[r.kind] || accept[r.kind](r.json))).sort((a, b) => resultTime(b) - resultTime(a));
}

// Speed measured on this Mac's stock Chrome: an E-core wrapper or extra
// flags measure something else (the P9 extrapolation).
export const stockChrome = (json) => !json.chrome || (json.chrome.path === "chrome stable" && !json.chrome.args);

const med = (d) => d?.median ?? null;

// A side label (a git ref or a directory) that is trunk.
export const isTrunk = (label) => /(^|[/-])(main|trunk)$/.test(String(label ?? ""));

// The race-perf side to report: trunk when it was measured (the program's
// state), otherwise the candidate (this tree).
export function raceSide(j) {
  const side = !isTrunk(j.sides?.candidate) && isTrunk(j.sides?.baseline) ? "baseline" : "candidate";
  return { side, label: j.sides?.[side] ?? null, cold: j[side]?.cold ?? null, p4: side === "baseline" ? j.baselineP4 : j.p4 };
}
const sideNote = (j) => { const s = raceSide(j); return s.label ? `côté ${s.side} : ${String(s.label).split("/").pop()}` : null; };
const p4Why = (j) => { const p = raceSide(j).p4; return p === undefined ? "race-perf antérieure aux compteurs P4" : p === null ? "cœur sans _DolphinWeb_JitRegionStats (P4 non fusionnée)" : null; };

// The rows, in PROGRAM.md's order. `better`: "higher" | "lower" | "zero" | "true".
export const KPI_ROWS = [
  { id: "pcSpeed", group: "North star", label: "Vitesse course, PC grand public milieu de gamme (modèle P9)", target: 95, unit: "%", better: "higher", from: "manual" },
  { id: "macSpeed", group: "Leviers", label: "Vitesse course, Mac M4 Pro", target: 160, unit: "%", better: "higher", from: "race-perf", read: (j) => med(raceSide(j).cold?.speed), detail: sideNote },
  { id: "regionTimeShare", group: "Leviers", label: "Part du temps CPU en code de région", target: 0.9, unit: "share", better: "higher", from: "race-perf", read: (j) => raceSide(j).p4?.regionTimeShare ?? null, why: p4Why, detail: sideNote },
  { id: "dispatchTimeShare", group: "Leviers", label: "Part du dispatch entre blocs", target: 0.1, unit: "share", better: "lower", from: "race-perf", read: (j) => raceSide(j).p4?.dispatchTimeShare ?? null, why: p4Why, detail: sideNote },
  { id: "discoveryCoverage", group: "Leviers", label: "Couverture de la découverte (PC distincts)", target: 99, unit: "%", better: "higher", from: "manual" },
  { id: "oracleDivergences", group: "Garde-fous", label: "Divergences à l'oracle (fuzz différentiel)", target: 0, unit: "", better: "zero", from: "fuzz", read: (j) => j.results.reduce((n, r) => n + (r.findings?.length ?? 0), 0) },
  { id: "gateGreen", group: "Garde-fous", label: "Gate de correction vert", target: true, unit: "", better: "true", from: "gate", read: (j) => Boolean(j.decision?.ok), detail: (j) => (j.decision?.ok ? null : j.decision?.reason ?? null) },
  { id: "freezes", group: "Garde-fous", label: "Gels sur 10 courses", target: 0, unit: "", better: "zero", from: ["freeze-loop", "wgpu-freeze"], read: (j, kind) => (kind === "freeze-loop" ? j.results.filter((r) => r.checks?.coreFreeze?.status === "fail").length : j.runs.filter((r) => r.verdict === "frozen").length), detail: (j, kind) => `sur ${(kind === "freeze-loop" ? j.results : j.runs).length} courses` },
  { id: "raceFrameP99", group: "Garde-fous", label: "p99 frame course", target: 33, unit: "ms", better: "lower", from: "race-perf", read: (j) => med(raceSide(j).cold?.presentP99Ms), detail: sideNote },
  { id: "aotcompilerMemory", group: "Garde-fous", label: "Surcoût mémoire aotcompiler", target: 150, unit: "Mo", better: "lower", from: "manual" },
  { id: "optimisationMs", group: "Expérience joueur", label: "Durée d'optimisation au 1er lancement", target: 60000, unit: "ms", better: "lower", from: "first-launch", read: (j) => j.p7?.durationMs ?? null, why: (j) => j.p7Why ?? null },
  { id: "secondLaunchRecompiled", group: "Expérience joueur", label: "Régions recompilées au 2e lancement", target: 0, unit: "", better: "zero", from: "first-launch", read: (j) => j.p7?.secondLaunchCompiled ?? null, why: (j) => j.p7Why ?? null },
  { id: "ttffCold", group: "Expérience joueur", label: "Time-to-first-frame, à froid", target: 10000, unit: "ms", better: "lower", from: "ttff", read: (j) => med(j.cold?.firstPresentMs) },
  { id: "ttffWarm", group: "Expérience joueur", label: "Time-to-first-frame, à chaud", target: 10000, unit: "ms", better: "lower", from: "ttff", read: (j) => med(j.warm?.firstPresentMs) }
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

// results: [{ kind, json, file, mtimeMs }]; manual: { id → { value, source, at, note } }.
// Each row reads the newest result that has its value; when none has it,
// the newest one says why.
export function kpiTable(results, manual = {}, { accept = { "race-perf": stockChrome } } = {}) {
  return KPI_ROWS.map((row) => {
    const base = { id: row.id, group: row.group, label: row.label, target: row.target, unit: row.unit, better: row.better };
    if (row.from === "manual") {
      const m = manual[row.id];
      if (!m || m.value == null) return { ...base, value: null, status: "n/a", nature: "n/a", why: "non mesuré, absent de manual.json" };
      return { ...base, value: m.value, status: statusOf(meets(row, m.value)), nature: "declared", source: m.source ?? null, at: m.at ?? null, detail: m.note ?? null };
    }
    const kinds = [row.from].flat();
    const all = newestOf(results, kinds, accept);
    if (!all.length) return { ...base, value: null, status: "n/a", nature: "n/a", why: `aucun résultat ${kinds.join(" / ")}` };
    const r = all.find((x) => row.read(x.json, x.kind) != null);
    if (!r) {
      const why = row.why?.(all[0].json) ?? `aucune valeur dans les ${all.length} résultat(s) ${kinds.join(" / ")}`;
      return { ...base, value: null, status: "n/a", nature: "n/a", source: all[0].file, at: new Date(resultTime(all[0])).toISOString(), why };
    }
    const value = row.read(r.json, r.kind);
    return { ...base, value, status: statusOf(meets(row, value)), nature: "measured", source: r.file, at: new Date(resultTime(r)).toISOString(), detail: row.detail?.(r.json, r.kind) ?? null };
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

export function kpiMarkdown(rows, { at = new Date().toISOString(), uptime = null } = {}) {
  const lines = [`# KPI du programme Salon`, "", `Généré le ${at}${uptime ? ` (charge : ${uptime})` : ""} par harness/kpi-report.mjs, dans l'ordre de PROGRAM.md.`, ""];
  let group = null;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      lines.push(`## ${group}`, "", "| KPI | Valeur | Cible | État | Nature | Source |", "|---|---|---|---|---|---|");
    }
    const note = r.why ?? r.detail;
    lines.push(`| ${r.label} | ${fmt(r.value, r.unit)}${note ? ` (${note})` : ""} | ${cmp[r.better]} ${fmt(r.target, r.unit)} | ${r.status} | ${{ measured: "mesuré", declared: "déclaré", "n/a": "n/a" }[r.nature]} | ${r.source ? `\`${r.source}\`${r.at ? ` (${r.at.slice(0, 16)})` : ""}` : "-"} |`);
    const next = rows[rows.indexOf(r) + 1];
    if (!next || next.group !== group) lines.push("");
  }
  return lines.join("\n");
}

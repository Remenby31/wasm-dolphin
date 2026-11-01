// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Page side of the pad film (pad-film-worker.js): validation, the worker
// started in the engine page against the core's direct pad block, its
// control words, and the recorder's step script.
//
// Recording, "scripted then replayed": a list of host-time steps (the
// lib/steps.mjs format: wait, tap, down, up, click; a key is a Playwright
// key name, mapped to the pad as the engine's default keyboard bindings map
// it, src/input.js) is played into the worker's live state, which writes it
// to the pad at each poll and records it on the poll it took effect. Two
// more kinds:
//   { mark: "menu", label?: "title", timeoutSec?: 60 }  waits (up to
//       timeoutSec) for the detected phase to be `mark` for MIN_PHASE_SEC,
//       then records a RESYNC marker at the current poll
//   { auto: 240, until?: "menu" }  the autopilot for `auto` seconds or until
//       the phase `until` shows; recorded as an autopilot span
// Each step may name a `port` (0-3, default 0).
import { readFileSync } from "node:fs";

import { BUTTONS, DEFAULT_KEY_BINDINGS, MAIN_STICK_GATE_RADIUS, stickToPadBytes } from "../../src/input.js";
import { PHASES } from "./parcours.mjs";

export const WORKER_SOURCE = new URL("./pad-film-worker.js", import.meta.url);
export const CONTROL_WORDS = 16;
export const CONTROL = Object.freeze({ STOP: 0, STUCK: 1, HOLD: 2, RELEASED: 3, POS: 4, POLLS: 5, AUTO: 6, AUTO_ON: 7, LIVE: 8 });
// ~120 polls a second (the game reads the pad twice a frame): a way out of
// ~2.5 s, B held long enough to back off.
export const AUTO_DEFAULTS = Object.freeze({ amp: 60, periodPolls: 180, recoverPolls: 300, bias: 0 });
// GameCube buttons the direct block carries (src/direct-pad.js: 12 bits).
const PAD_BUTTONS = 0xfff;
const PORT_OK = (p) => Number.isInteger(p) && p >= 0 && p <= 3;
const BYTE_OK = (v) => Number.isInteger(v) && v >= 0 && v <= 255;

// A film as pad-film-worker.js plays it; throws on the first problem.
export function validateFilm(film) {
  if (!film || film.unit !== "poll") throw new Error('film: unit must be "poll"');
  const ports = film.ports ?? [film.port ?? 0];
  if (!Array.isArray(ports) || !ports.length || !ports.every(PORT_OK) || new Set(ports).size !== ports.length) throw new Error("film: ports must be distinct ports 0-3");
  if (!Array.isArray(film.steps)) throw new Error("film: steps must be an array");
  if (!(Number.isInteger(film.end) && film.end > 0)) throw new Error("film: end must be a poll count > 0");
  let at = 0;
  film.steps.forEach((s, i) => {
    if (!(Number.isInteger(s.at) && s.at >= at)) throw new Error(`film step ${i}: at ${s.at} must be a poll ≥ the previous step's`);
    at = s.at;
    if (s.port != null && !ports.includes(s.port)) throw new Error(`film step ${i}: port ${s.port} is not one of the film's ports`);
    const kinds = [s.phase != null, s.auto != null, s.mask != null].filter(Boolean).length;
    if (kinds !== 1) throw new Error(`film step ${i}: exactly one of mask (a pad state), auto (the autopilot), phase (a marker)`);
    if (s.phase != null && !PHASES.includes(s.phase)) throw new Error(`film step ${i}: phase ${s.phase} is not one of ${PHASES.join(", ")}`);
    if (s.mask != null && !(Number.isInteger(s.mask) && s.mask >= 0 && Array.isArray(s.stick) && s.stick.length === 2 && s.stick.every(BYTE_OK))) throw new Error(`film step ${i}: a pad state is { mask, stick: [x, y] } (bytes)`);
    if (s.auto != null && (typeof s.auto !== "object" || Object.entries(s.auto).some(([k, v]) => !(k in AUTO_DEFAULTS || k === "polls") || !Number.isFinite(v)))) throw new Error(`film step ${i}: auto takes ${[...Object.keys(AUTO_DEFAULTS), "polls"].join(", ")} (numbers)`);
  });
  if (film.end < at) throw new Error(`film: end ${film.end} before its last step (${at})`);
  return film;
}

// The film's markers in order: [{ at, phase, label, timeoutSec }].
export const filmMarkers = (film) => film.steps.filter((s) => s.phase != null).map((s) => ({ at: s.at, phase: s.phase, label: s.label ?? null, timeoutSec: s.timeoutSec ?? null }));

// A keyboard key (Playwright name) -> the pad: a button bit, or a stick direction.
export function keyToPad(key, bindings = DEFAULT_KEY_BINDINGS) {
  const button = bindings[key] ?? null;
  if (!button) throw new Error(`key ${key}: not bound to a pad button (src/input.js DEFAULT_KEY_BINDINGS)`);
  return button;
}

// Pressed pad buttons (names) -> { mask, stick } as the engine maps them.
export function padStateOf(pressed) {
  let mask = 0;
  for (const b of pressed) mask |= BUTTONS[b] ?? 0;
  const axis = (neg, pos) => (pressed.has(pos) ? 1 : 0) - (pressed.has(neg) ? 1 : 0);
  const x = axis("STICK_LEFT", "STICK_RIGHT"), y = axis("STICK_DOWN", "STICK_UP");
  return { mask: mask & PAD_BUTTONS, stick: x || y ? stickToPadBytes(x, y, MAIN_STICK_GATE_RADIUS, 0) : [128, 128] };
}

const RECORD_KINDS = ["wait", "tap", "down", "up", "click", "mark", "auto"];
export function validateRecordSteps(steps) {
  if (!Array.isArray(steps)) throw new Error("record steps must be an array");
  steps.forEach((s, i) => {
    const k = RECORD_KINDS.filter((kind) => kind in s);
    if (k.length !== 1) throw new Error(`record step ${i}: expected exactly one of ${RECORD_KINDS.join("/")}`);
    if (s.port != null && !PORT_OK(s.port)) throw new Error(`record step ${i}: port ${s.port} is not 0-3`);
    for (const key of ["tap", "down", "up"]) if (key in s) keyToPad(s[key]);
    if ("mark" in s && !PHASES.includes(s.mark)) throw new Error(`record step ${i}: mark ${s.mark} is not one of ${PHASES.join(", ")}`);
    if ("auto" in s && !(s.auto > 0)) throw new Error(`record step ${i}: auto is a number of seconds > 0`);
    if (s.until != null && !PHASES.includes(s.until)) throw new Error(`record step ${i}: until ${s.until} is not one of ${PHASES.join(", ")}`);
  });
  return steps;
}

// The ports a step list drives (0 when none is named).
export const recordPorts = (steps) => [...new Set(steps.map((s) => s.port ?? 0))].sort((a, b) => a - b);

// Start the worker in the page: { film } plays a film, { record: { ports,
// auto } } records. Returns { started } or { error }.
export async function startPadFilm(page, { film = null, record = null } = {}) {
  const source = readFileSync(WORKER_SOURCE, "utf8");
  const ports = film ? (film.ports ?? [film.port ?? 0]) : record.ports;
  return page.evaluate(([src, f, rec, words, portList]) => {
    try {
      const dp = window.__host?.adapter?.directPad;
      if (!dp) return { error: "no direct pad block (core export or adapter exposure missing)" };
      // every port the film drives is plugged in (port 0 is by default)
      for (const p of portList) window.__host?.connectPad?.(p, true);
      const control = new Int32Array(new SharedArrayBuffer(words * 4));
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      window.__padFilm = { control, result: null, worker };
      worker.onmessage = (e) => { window.__padFilm.result = e.data; };
      worker.onerror = (e) => { window.__padFilm.result = { type: "error", error: String(e.message) }; };
      worker.postMessage({ type: "start", buffer: dp.i32.buffer, offset: dp.i32.byteOffset, control, film: f, record: rec });
      return { started: true };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }, [source, film, record, CONTROL_WORDS, ports]);
}

// The worker's control words and its result once it ended.
export function padFilmStatus(page) {
  return page.evaluate((C) => {
    const d = window.__padFilm;
    if (!d) return null;
    const c = d.control;
    return { hold: Atomics.load(c, C.HOLD), released: Atomics.load(c, C.RELEASED), pos: Atomics.load(c, C.POS), polls: Atomics.load(c, C.POLLS), stuck: Atomics.load(c, C.STUCK), autoOn: Atomics.load(c, C.AUTO_ON), result: d.result };
  }, CONTROL);
}

// Release the marker held (ordinal + 1 = its count of released markers).
export const releaseMarker = (page, count) => page.evaluate(([C, n]) => { const d = window.__padFilm; if (d) Atomics.store(d.control, C.RELEASED, n); }, [CONTROL, count]);
export const signalStuck = (page) => page.evaluate((C) => { const d = window.__padFilm; if (d) Atomics.add(d.control, C.STUCK, 1); }, CONTROL);
// Recording: port p's live state, and the autopilot on or off.
export const setLive = (page, port, { mask, stick }) => page.evaluate(([C, p, m, s]) => {
  const d = window.__padFilm;
  if (!d) return;
  Atomics.store(d.control, C.LIVE + 2 * p, m);
  Atomics.store(d.control, C.LIVE + 2 * p + 1, s[0] | (s[1] << 8));
}, [CONTROL, port, mask, stick]);
export const setAuto = (page, port, on) => page.evaluate(([C, p, v]) => {
  const d = window.__padFilm;
  if (!d) return;
  if (v) Atomics.or(d.control, C.AUTO, 1 << p); else Atomics.and(d.control, C.AUTO, ~(1 << p));
}, [CONTROL, port, on]);

// Stop the worker and wait (up to timeoutMs) for its result.
export async function stopPadFilm(page, { timeoutMs = 5000 } = {}) {
  await page.evaluate((C) => { const d = window.__padFilm; if (d) Atomics.store(d.control, C.STOP, 1); }, CONTROL).catch(() => {});
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await page.evaluate(() => window.__padFilm?.result ?? null).catch(() => null);
    if (res || Date.now() > end) return res;
    await new Promise((x) => setTimeout(x, 100));
  }
}

// Play a record step list into the worker's live state. `phase()` is the
// detected phase now (lib/parcours.mjs currentPhase over the seconds so
// far); marks are recorded through `onMark({ phase, label, pos, missed })`.
// `wait(ms)` and `now()` are seams for tests.
export async function runRecordSteps(page, steps, { phase, onMark = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), live = { setLive, setAuto, status: padFilmStatus }, log = () => {} } = {}) {
  validateRecordSteps(steps);
  const pressed = new Map();
  const of = (port) => { if (!pressed.has(port)) pressed.set(port, new Set()); return pressed.get(port); };
  const push = (port) => live.setLive(page, port, padStateOf(of(port)));
  for (const s of steps) {
    const port = s.port ?? 0;
    if ("wait" in s) await wait(s.wait * 1000);
    else if ("click" in s) await page.mouse.click(s.click[0], s.click[1]);
    else if ("down" in s) { of(port).add(keyToPad(s.down)); await push(port); }
    else if ("up" in s) { of(port).delete(keyToPad(s.up)); await push(port); }
    else if ("tap" in s) {
      for (let i = 0; i < (s.repeat ?? 1); i += 1) {
        const hold = s.hold ?? 120;
        of(port).add(keyToPad(s.tap)); await push(port);
        await wait(hold);
        of(port).delete(keyToPad(s.tap)); await push(port);
        if (s.every) await wait(Math.max(0, s.every * 1000 - hold));
      }
    } else if ("mark" in s) {
      const limit = now() + (s.timeoutSec ?? 60) * 1000;
      while (phase() !== s.mark && now() < limit) await wait(250);
      const st = await live.status(page);
      const missed = phase() !== s.mark;
      onMark({ phase: s.mark, label: s.label ?? null, pos: st?.polls ?? null, missed });
      log(`mark ${s.label ?? s.mark}: ${missed ? `MISSED (phase ${phase() ?? "unsettled"})` : `at poll ${st?.polls}`}`);
    } else if ("auto" in s) {
      await live.setAuto(page, port, true);
      const limit = now() + s.auto * 1000;
      while (now() < limit && !(s.until && phase() === s.until)) await wait(250);
      await live.setAuto(page, port, false);
      await push(port);
    }
  }
}

// The recorded film with its marks placed: marks become marker steps at
// their poll (a mark that missed is dropped, with a note).
export function filmWithMarks(film, marks, about = null) {
  const markers = marks.filter((m) => !m.missed && m.pos != null).map((m) => ({ at: m.pos, phase: m.phase, ...(m.label ? { label: m.label } : {}) }));
  // a marker before the pad steps of its own poll (it holds before them)
  const steps = [...film.steps, ...markers].map((s, i) => ({ s, i, k: s.phase != null ? 0 : 1 })).sort((a, b) => a.s.at - b.s.at || a.k - b.k || a.i - b.i).map((x) => x.s);
  const out = { ...(about ? { about } : {}), ...film, steps, end: Math.max(film.end, ...steps.map((s) => s.at)) };
  const dropped = marks.filter((m) => m.missed).map((m) => m.label ?? m.phase);
  if (dropped.length) out.missedMarks = dropped;
  return out;
}

// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A pad film, played or recorded in a dedicated worker against the core's
// direct pad block (src/direct-pad.js, layout 2), from salon's
// scripts/pad-film-worker.js (measure-safari --drive), for every port 0-3.
// The states for SI poll n+1 are written as soon as poll n is seen, so a
// film is indexed on the game's own polls, not on host or guest time, and a
// replay presses the same inputs at the same frames whatever the speed (as
// far as the core repeats). A worker, not a page timer: Atomics.wait is
// never throttled. A classic script (the page loads it from a Blob); the
// pure part (createPlayer, createRecorder) is tested in node through vm.
//
// Film (harness/lib/pad-film.mjs validates it):
//   { unit: "poll", ports: [0, 1], end, steps: [...] }   (or port: N)
//   steps, `at` = polls of the clock port (the lowest) since the start:
//     { at, port?, mask, stick: [x, y] }   held until the port's next step
//     { at, port?, auto: { polls?, amp?, periodPolls?, recoverPolls?, bias? } }
//         the autopilot (A held, stick x a sine around 128 + bias; on each
//         new stuck signal, B held and the stick turned the other way for
//         recoverPolls) until the port's next pad step, or for `polls`
//     { at, phase, label?, timeoutSec? }   a RESYNC marker
// A marker holds the film where it is (its position frozen, before the
// steps of its own poll) until the page releases it: the page waits for the
// detected phase to match (lib/parcours.mjs currentPhase), or gives up after
// timeoutSec (the marker is missed, the run INCOMPLETE). In dual core a
// replay drifts after a minute or so (the game reads the pad twice a frame
// and the worker misses some polls), and the marker puts it back on the
// game's own progress. While held, a port under the autopilot keeps driving
// (a race goes on until its results show); every other port is neutral, not
// its last state: a button kept pressed through a screen change would act
// on the next screen.
//
// The page talks to the blocked worker through `control` (Int32Array over a
// SharedArrayBuffer, CONTROL_WORDS words):
//   [0] stop when set          [1] stuck count (the page adds 1)
//   [2] marker held (ordinal + 1, 0 none; worker)
//   [3] markers released (count; page)   [4] film position (worker)
//   [5] polls since start (worker)
//   [6] record: autopilot on per port (bit p; page)
//   [7] ports under the autopilot now (bit p; worker): the page looks for
//       a still picture (the stuck signal) only then
//   [8 + 2p], [9 + 2p] record: port p's live mask and stick (x | y << 8; page)
//   [16 + p] the autopilot's steering for port p from the picture (stick x
//       + 1; 0: none, the sine drives; page: lib/edge-follower.mjs)
// Message in: { type: "start", buffer, offset, control, film | record }
//   record: { ports, auto } records the live states the page sets (and the
//   autopilot's spans) as a film.
// Message out: { type: "film", polls, missed, gapsMs, film } when it ends
// (stop, or the film's end), { type: "error", error }.
var SLOTS = 36;
var SLOT = { SEQ: 0, ENABLED: 1, CONNECTED: 2, MASK: 3, AXES0: 4, AXES1: 5, POLL_COUNT: 11 };
var CONTROL = { STOP: 0, STUCK: 1, HOLD: 2, RELEASED: 3, POS: 4, POLLS: 5, AUTO: 6, AUTO_ON: 7, LIVE: 8, STEER: 16 };
var CONTROL_WORDS = 20;
var BTN_A = 1, BTN_B = 2;
var NEUTRAL = { mask: 0, stick: [128, 128] };
var AUTO_DEFAULTS = { amp: 60, periodPolls: 180, recoverPolls: 300, bias: 0 };
var byte = function (v) { return Math.max(0, Math.min(255, Math.round(Number(v) || 0))); };

function autoParams(a) {
  var o = {};
  for (var k in AUTO_DEFAULTS) o[k] = a && a[k] != null ? Number(a[k]) : AUTO_DEFAULTS[k];
  o.polls = a && a.polls != null ? Number(a.polls) : null;
  return o;
}

// The autopilot's state at core poll n; recover: { until, x } or null;
// steer: the stick x the page found from the picture, or null.
function autoState(p, n, recover, steer) {
  if (recover && n < recover.until) return { mask: BTN_B, stick: [recover.x, 128] };
  if (steer) return { mask: BTN_A, stick: [steer, 128] };
  return { mask: BTN_A, stick: [128 + p.bias + p.amp * Math.sin((2 * Math.PI * n) / p.periodPolls), 128] };
}

// The film split per port and markers, in film positions.
function normalizeFilm(film) {
  var ports = film.ports || [film.port == null ? 0 : film.port];
  var pad = {}, autos = {};
  ports.forEach(function (p) { pad[p] = []; autos[p] = []; });
  var markers = [];
  film.steps.forEach(function (s) {
    var port = s.port == null ? ports[0] : s.port;
    if (s.phase != null) markers.push({ at: s.at, phase: s.phase, label: s.label == null ? null : s.label });
    else if (s.auto) autos[port].push({ at: s.at, params: autoParams(s.auto) });
    else pad[port].push({ at: s.at, mask: s.mask >>> 0, stick: s.stick || [128, 128] });
  });
  // an autopilot span ends at the port's next pad step, or after `polls`
  ports.forEach(function (p) {
    autos[p].forEach(function (a) {
      var next = pad[p].find(function (s) { return s.at > a.at; });
      var until = next ? next.at : Infinity;
      if (a.params.polls != null) until = Math.min(until, a.at + a.params.polls);
      a.until = until;
    });
  });
  return { ports: ports, clockPort: Math.min.apply(null, ports), pad: pad, autos: autos, markers: markers, end: film.end };
}

// The player: onPoll(n, { released, stuck }) for each new core poll n (1,
// 2, ...: polls since the start) -> { writes: [[port, state]], hold, pos, done }.
function createPlayer(film) {
  var f = normalizeFilm(film);
  var run = { pos: 0, lastN: 0, hold: 0, next: 0, stuck: 0, recover: {}, cursor: {}, last: {} };
  f.ports.forEach(function (p) { run.cursor[p] = -1; run.last[p] = ""; });
  function padAt(p, pos) {
    var steps = f.pad[p];
    var c = run.cursor[p];
    while (c + 1 < steps.length && steps[c + 1].at <= pos) c += 1;
    run.cursor[p] = c;
    return c >= 0 ? steps[c] : null;
  }
  function autoAt(p, pos, strict) {
    var list = f.autos[p];
    for (var i = list.length - 1; i >= 0; i -= 1) {
      var a = list[i];
      if ((strict ? a.at < pos : a.at <= pos) && pos < a.until) return a;
    }
    return null;
  }
  return {
    film: f,
    onPoll: function (n, ctl) {
      var dn = Math.max(0, n - run.lastN);
      run.lastN = n;
      if (run.hold && ctl.released >= run.hold) { run.hold = 0; run.next += 1; }
      if (!run.hold) run.pos += dn;
      if (!run.hold && run.next < f.markers.length && f.markers[run.next].at <= run.pos) {
        run.pos = f.markers[run.next].at;
        run.hold = run.next + 1;
      }
      var stuckNew = ctl.stuck !== run.stuck;
      run.stuck = ctl.stuck;
      var writes = [], autoOn = 0;
      // held: the steps of the marker's own poll wait for the release
      var strict = run.hold > 0;
      f.ports.forEach(function (p) {
        var a = autoAt(p, run.pos, strict);
        var s;
        if (a) {
          autoOn |= 1 << p;
          if (stuckNew) run.recover[p] = { until: n + a.params.recoverPolls, x: run.stuck & 1 ? 28 : 228 };
          s = autoState(a.params, n, run.recover[p], ctl.steer ? ctl.steer[p] : null);
        } else if (run.hold) s = NEUTRAL;
        else s = padAt(p, run.pos) || NEUTRAL;
        var key = s.mask + ":" + byte(s.stick[0]) + ":" + byte(s.stick[1]);
        if (key !== run.last[p]) { writes.push([p, s]); run.last[p] = key; }
      });
      return { writes: writes, autoOn: autoOn, hold: run.hold, pos: run.pos, done: !run.hold && run.pos >= f.end && run.next >= f.markers.length };
    }
  };
}

// The recorder: onPoll(n, live) with live[p] = { mask, stick, auto } as the
// page set it -> { writes }; film(end) -> the film recorded.
function createRecorder(ports, auto) {
  var params = autoParams(auto);
  var steps = [], last = {}, lastAuto = {}, recover = {}, stuck = 0;
  ports.forEach(function (p) { last[p] = ""; lastAuto[p] = false; });
  return {
    onPoll: function (n, live, ctl) {
      var writes = [], autoOn = 0;
      var stuckNew = ctl && ctl.stuck !== stuck;
      if (ctl) stuck = ctl.stuck;
      ports.forEach(function (p) {
        var l = live[p] || { mask: 0, stick: [128, 128], auto: false };
        var s;
        if (l.auto) {
          autoOn |= 1 << p;
          if (!lastAuto[p]) steps.push({ at: n, port: p, auto: { amp: params.amp, periodPolls: params.periodPolls, recoverPolls: params.recoverPolls, bias: params.bias } });
          if (stuckNew) recover[p] = { until: n + params.recoverPolls, x: stuck & 1 ? 28 : 228 };
          s = autoState(params, n, recover[p], ctl && ctl.steer ? ctl.steer[p] : null);
        } else {
          s = { mask: l.mask >>> 0, stick: [byte(l.stick[0]), byte(l.stick[1])] };
          var k = s.mask + ":" + s.stick[0] + ":" + s.stick[1];
          if (k !== last[p] || lastAuto[p]) steps.push({ at: n, port: p, mask: s.mask, stick: s.stick.slice() });
          last[p] = k;
        }
        lastAuto[p] = Boolean(l.auto);
        writes.push([p, s]);
      });
      return { writes: writes, autoOn: autoOn };
    },
    film: function (end) {
      return { unit: "poll", ports: ports.slice(), steps: steps.slice(), end: end };
    }
  };
}

function writeState(v, b, s) {
  var seq = (Atomics.load(v, b + SLOT.SEQ) + 1) | 1;
  Atomics.store(v, b + SLOT.SEQ, seq);
  Atomics.store(v, b + SLOT.CONNECTED, 1);
  Atomics.store(v, b + SLOT.MASK, s.mask >>> 0);
  Atomics.store(v, b + SLOT.AXES0, byte(s.stick[0]) | (byte(s.stick[1]) << 8) | (0x80 << 16) | (0x80 << 24));
  // analog A and B follow their buttons (as the keyboard path sets them)
  Atomics.store(v, b + SLOT.AXES1, ((s.mask & BTN_A) ? 255 << 16 : 0) | ((s.mask & BTN_B) ? 255 << 24 : 0));
  Atomics.store(v, b + SLOT.SEQ, (seq + 1) | 0);
  Atomics.store(v, b + SLOT.ENABLED, 1);
}

var active = null;

function loop() {
  var r = active, v = r.v, ctl = r.control;
  var clock = r.base(r.clockPort) + SLOT.POLL_COUNT;
  for (;;) {
    if (Atomics.load(ctl, CONTROL.STOP)) return finish();
    var poll = Atomics.load(v, clock) >>> 0;
    if (poll !== r.lastPoll) {
      if (r.lastPoll !== null && ((poll - r.lastPoll) >>> 0) > 1) r.missed += ((poll - r.lastPoll) >>> 0) - 1;
      var t = performance.now();
      if (r.lastAt !== null) { var g = t - r.lastAt; r.gaps[g < 1 ? 0 : g < 4 ? 1 : g < 12 ? 2 : 3] += 1; }
      r.lastAt = t;
      r.lastPoll = poll;
      if (r.p0 === null) r.p0 = poll;
      r.n = ((poll - r.p0) >>> 0) + 1; // the poll these states are for
      var c = { released: Atomics.load(ctl, CONTROL.RELEASED), stuck: Atomics.load(ctl, CONTROL.STUCK), steer: {} };
      r.ports.forEach(function (p) { var x = Atomics.load(ctl, CONTROL.STEER + p); c.steer[p] = x > 0 ? x - 1 : null; });
      var out;
      if (r.player) out = r.player.onPoll(r.n, c);
      else {
        var live = {}, autoBits = Atomics.load(ctl, CONTROL.AUTO);
        r.ports.forEach(function (p) {
          var axes = Atomics.load(ctl, CONTROL.LIVE + 2 * p + 1);
          live[p] = { mask: Atomics.load(ctl, CONTROL.LIVE + 2 * p) >>> 0, stick: [axes & 0xff, (axes >>> 8) & 0xff], auto: Boolean(autoBits & (1 << p)) };
        });
        out = r.recorder.onPoll(r.n, live, c);
      }
      for (var i = 0; i < out.writes.length; i += 1) {
        var w = out.writes[i];
        var key = w[1].mask + ":" + byte(w[1].stick[0]) + ":" + byte(w[1].stick[1]);
        if (key !== r.written[w[0]]) { writeState(v, r.base(w[0]), w[1]); r.written[w[0]] = key; }
      }
      Atomics.store(ctl, CONTROL.HOLD, out.hold || 0);
      Atomics.store(ctl, CONTROL.AUTO_ON, out.autoOn || 0);
      Atomics.store(ctl, CONTROL.POS, out.pos == null ? r.n : out.pos);
      Atomics.store(ctl, CONTROL.POLLS, r.n);
      if (out.done) return finish();
    }
    // Wake on the poll counter or after 1 ms: the core does not notify.
    Atomics.wait(v, clock, poll | 0, 1);
  }
}

function finish() {
  var r = active;
  active = null;
  postMessage({ type: "film", polls: r.n, missed: r.missed, gapsMs: { "<1": r.gaps[0], "1-4": r.gaps[1], "4-12": r.gaps[2], ">=12": r.gaps[3] }, film: r.recorder ? r.recorder.film(r.n) : null });
}

if (typeof onmessage !== "undefined" || typeof self !== "undefined") {
  self.onmessage = function (e) {
    var m = e.data;
    if (m.type !== "start" || active) return;
    try {
      var v = new Int32Array(m.buffer);
      var ports = m.film ? normalizeFilm(m.film).ports : m.record.ports;
      active = {
        v: v, control: m.control, ports: ports, clockPort: Math.min.apply(null, ports),
        base: function (p) { return (m.offset >>> 2) + p * SLOTS; },
        player: m.film ? createPlayer(m.film) : null,
        recorder: m.film ? null : createRecorder(ports, m.record.auto),
        written: {}, lastPoll: null, p0: null, n: 0, missed: 0, lastAt: null, gaps: [0, 0, 0, 0]
      };
      loop();
    } catch (error) {
      active = null;
      postMessage({ type: "error", error: String(error && error.stack || error) });
    }
  };
}

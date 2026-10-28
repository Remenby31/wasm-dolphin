// Diagnostics: where a worker's event loop goes. Once on (a probe's
// validationLoopProfile), every timer callback, message handled and port
// callback wrapped here is timed (its synchronous part) under a label: the
// timer's function name or source head, the message's type. Off, a wrapped
// callback costs one boolean test.
export function createLoopProfile({ now = () => performance.now() } = {}) {
  const p = { on: false, since: 0, byLabel: new Map() };
  const record = (label, ms) => {
    const e = p.byLabel.get(label) ?? { ms: 0, n: 0, maxMs: 0 };
    e.ms += ms; e.n++; if (ms > e.maxMs) e.maxMs = ms;
    p.byLabel.set(label, e);
  };
  const wrap = (label, fn) => function profiled(...args) {
    if (!p.on) return fn.apply(this, args);
    const t0 = now();
    try {
      return fn.apply(this, args);
    } finally {
      record(typeof label === "function" ? label(args) : label, now() - t0);
    }
  };
  const nameOf = (fn) => fn.name || String(fn).slice(0, 60).replace(/\s+/g, " ");
  return {
    wrap,
    // setTimeout/setInterval of `g` timed from now on (callbacks given later)
    patchTimers(g = globalThis) {
      for (const name of ["setTimeout", "setInterval"]) {
        const orig = g[name];
        if (typeof orig !== "function" || orig.loopProfiled) continue;
        const patched = (fn, ms, ...rest) => orig(typeof fn === "function" ? wrap(`${name}:${nameOf(fn)}`, fn) : fn, ms, ...rest);
        patched.loopProfiled = true;
        g[name] = patched;
      }
    },
    start() { p.on = true; p.since = now(); p.byLabel.clear(); },
    stop() { p.on = false; },
    read() {
      const windowMs = p.on ? now() - p.since : 0;
      const entries = [...p.byLabel].map(([label, e]) => ({ label, ms: Math.round(e.ms * 10) / 10, n: e.n, maxMs: Math.round(e.maxMs * 10) / 10 }))
        .sort((a, b) => b.ms - a.ms);
      return { on: p.on, windowMs: Math.round(windowMs), totalMs: Math.round(entries.reduce((s, e) => s + e.ms, 0)), entries };
    }
  };
}

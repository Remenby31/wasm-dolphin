// The core exports some monotonic event counters as C `u32`. Two things go
// wrong reading them through Emscripten's `"number"` return type: the value
// arrives as a signed i32, so past 2^31 it reads negative, and past 2^32 it
// wraps to small numbers again. At JIT dispatch rates (tens of millions of
// block runs a second) both happen within minutes.
//
// widenU32Counter() reinterprets each sample as unsigned and counts wraps, so
// callers see a monotonic count that stays exact up to 2^53. It assumes fewer
// than 2^32 events between consecutive samples, which per-frame polling meets
// by orders of magnitude, and one extender per core instance: the native
// counters only start over when the module does.

export function widenU32Counter() {
  let last = null;
  let high = 0;
  return (sample) => {
    const low = Number(sample) >>> 0;
    if (last !== null && low < last) high += 2 ** 32;
    last = low;
    return high + low;
  };
}

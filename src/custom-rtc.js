// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// ?rtc=<seconds since 1970>: the console's real-time clock starts there and
// follows emulated time (patch 0081), so two boots of one disc repeat exactly.
export function parseCustomRtc(raw) {
  // Whole seconds from 2000-01-01 (the console's epoch) to the end of u32;
  // anything else (empty, "host", a date before 2000) is the host clock.
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds >= 946684800 && seconds <= 0xffffffff ? seconds : null;
}

/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * vitest: the VI in each video mode a game can pick, switched at run time.
 * For each mode, the field rate is measured with the time base over 120
 * retraces and compared with the rate the VI's timings give (27 MHz video
 * clock: 13.5 MHz pixels, 858 clocks per line in 525-line modes, 864 in
 * 625-line modes):
 *   480i NTSC, EURGB60, MPAL  59.94 Hz (525 lines, two fields)
 *   240p (double strike)      59.826 Hz (263 lines per field)
 *   576i PAL                  50.00 Hz (625 lines, two fields)
 *   288p PAL (double strike)  50.08 Hz (312 lines per field)
 *   480p                      59.94 Hz (525 lines, 27 MHz pixel clock)
 * Tolerance 0.02 % (the time base and the VI both run in emulated time: no
 * jitter), which separates 240p from 480i and 288p from 576i. The report goes back to the starting mode. Results:
 * compat/homebrew/report.h (detail: the measured rate in mHz).
 */
#include <gccore.h>
#include <malloc.h>
#include <ogc/lwp_watchdog.h>
#include "report.h"

static u32 measure_mhz(GXRModeObj *mode, void *fb) {
  VIDEO_Configure(mode);
  VIDEO_SetNextFramebuffer(fb);
  VIDEO_SetBlack(FALSE);
  VIDEO_Flush();
  for (int i = 0; i < 10; i++) VIDEO_WaitVSync(); /* settle */
  u64 t0 = gettime();
  for (int i = 0; i < 120; i++) VIDEO_WaitVSync();
  u64 us = diff_usec(t0, gettime());
  return us ? (u32)(120ull * 1000000000ull / us) : 0;
}

static void check_mode(GXRModeObj *mode, void *fb, u32 expected_mhz) {
  rp_start_test();
  u32 mhz = measure_mhz(mode, fb);
  u32 tol = expected_mhz / 5000; /* 0.02 % */
  RP_CHECK(mhz + tol >= expected_mhz && mhz <= expected_mhz + tol, mhz);
  rp_end_test();
}

int main(void) {
  rp_init();
  /* One frame buffer large enough for every mode (640 x 576). */
  void *fb = MEM_K0_TO_K1(memalign(32, 640 * 576 * 2));
  VIDEO_ClearFrameBuffer(&TVPal576IntDfScale, fb, COLOR_GRAY);
  check_mode(&TVNtsc480IntDf, fb, 59940);
  check_mode(&TVNtsc240Ds, fb, 59826);
  check_mode(&TVPal576IntDfScale, fb, 50000);
  check_mode(&TVPal264Ds, fb, 50080);
  check_mode(&TVEurgb60Hz480IntDf, fb, 59940);
  check_mode(&TVMpal480IntDf, fb, 59940);
  check_mode(&TVNtsc480Prog, fb, 59940);
  /* Back to the report's mode and frame buffer. */
  VIDEO_Configure(rp.rmode);
  VIDEO_SetNextFramebuffer(rp.xfb);
  VIDEO_Flush();
  VIDEO_WaitVSync();
  VIDEO_WaitVSync();
  rp_done();
  return 0;
}

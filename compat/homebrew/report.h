/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Test results painted into the XFB as rows of 32 bits, with the cell
 * geometry of harness/homebrew/common/marker.h, from y = 16; decoded by
 * compat/lib/report-rows.mjs from an exact capture.
 *
 *   row 0      magic 0x48575431 ("HWT1")
 *   row 1      state (0 running, 1 done) | tests << 8
 *   row 2      tests passed
 *   row 3      subtests (checks)
 *   row 4      subtests passed
 *   row 5      failures recorded below (at most RP_FAILURES)
 *   row 6+2i   failure i: test number << 24 | source line
 *   row 7+2i   failure i: a 32-bit detail (hash of the message, or a value)
 *   row 26     FNV-1a of rows 0..25 (big-endian bytes)
 */
#ifndef COMPAT_REPORT_H
#define COMPAT_REPORT_H

#include <gccore.h>
#include "marker.h"

#define RP_ROWS 26
#define RP_FAILURES 10
#define RP_Y 16

typedef struct {
  void *xfb;
  GXRModeObj *rmode;
  u32 rows[RP_ROWS];
  u32 tests, tests_passed, subtests, subtests_passed, failures;
  u32 test_failures;
} rp_state;

static rp_state rp;

static inline void rp_paint(u32 done) {
  if (!rp.xfb) return;
  rp.rows[0] = 0x48575431u;
  rp.rows[1] = (done ? 1u : 0u) | (rp.tests << 8);
  rp.rows[2] = rp.tests_passed;
  rp.rows[3] = rp.subtests;
  rp.rows[4] = rp.subtests_passed;
  rp.rows[5] = rp.failures;
  u32 sum = mk_fnv(MK_FNV_INIT, rp.rows, sizeof rp.rows);
  for (int r = 0; r <= RP_ROWS; r++) {
    u32 v = r < RP_ROWS ? rp.rows[r] : sum;
    for (int i = 0; i < 32; i++)
      mk_fill(rp.xfb, rp.rmode, 32 + i * 18, RP_Y + r * 16, 14, 12, ((v >> (31 - i)) & 1) ? 235 : 16);
  }
  DCFlushRange(rp.xfb, VIDEO_GetFrameBufferSize(rp.rmode));
}

/* VI on, one XFB, black, the empty report shown. */
static inline void rp_init(void) {
  VIDEO_Init();
  rp.rmode = VIDEO_GetPreferredMode(NULL);
  rp.xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rp.rmode));
  VIDEO_ClearFrameBuffer(rp.rmode, rp.xfb, COLOR_BLACK);
  VIDEO_Configure(rp.rmode);
  VIDEO_SetNextFramebuffer(rp.xfb);
  VIDEO_SetBlack(FALSE);
  VIDEO_Flush();
  VIDEO_WaitVSync();
  if (rp.rmode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();
  rp_paint(0);
}

static inline void rp_start_test(void) { rp.tests++; rp.test_failures = 0; }

static inline void rp_result(int ok, int line, u32 detail) {
  rp.subtests++;
  if (ok) { rp.subtests_passed++; return; }
  rp.test_failures++;
  if (rp.failures < RP_FAILURES) {
    rp.rows[6 + 2 * rp.failures] = (rp.tests << 24) | ((u32)line & 0xffffff);
    rp.rows[7 + 2 * rp.failures] = detail;
    rp.failures++;
  }
}

static inline void rp_end_test(void) {
  if (!rp.test_failures) rp.tests_passed++;
  rp_paint(0);
}

/* Final report, then show it forever. */
static inline void rp_done(void) {
  rp_paint(1);
  for (;;) VIDEO_WaitVSync();
}

#define RP_CHECK(cond, detail) rp_result((cond) ? 1 : 0, __LINE__, (u32)(detail))

#endif

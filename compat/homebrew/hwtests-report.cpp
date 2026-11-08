/* Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Replaces hwtests' Common/hwtests.cpp (which reports over a TCP socket on a
 * Wii) for a GameCube build run by the harness: the same functions count the
 * tests and subtests, and the result is painted into the XFB as rows of 32
 * bits (cell geometry of harness/homebrew/common/marker.h), read back from
 * an exact capture by compat/lib/report-rows.mjs.
 *
 *   row 0      magic 0x48575431 ("HWT1")
 *   row 1      state (0 running, 1 done) | tests << 8
 *   row 2      tests passed
 *   row 3      subtests
 *   row 4      subtests passed
 *   row 5      failures recorded below (at most REPORT_FAILURES)
 *   row 6+2i   failure i: test number << 24 | source line
 *   row 7+2i   failure i: FNV-1a of the hwtest's failure message
 *   row 26     FNV-1a of rows 0..25 (big-endian bytes)
 * Rows are refreshed when each test ends, so a run that hangs shows how far
 * it got. Every failure message also goes to OSReport.
 */
#include <gccore.h>
#include <stdio.h>
#include <string.h>

#include "Common/hwtests.h"
#include "marker.h"

#define REPORT_ROWS 26
#define REPORT_FAILURES 10
#define REPORT_Y 16

extern "C" __attribute__((weak)) void OSReport([[maybe_unused]] const char* fmt, ...) {}

static void* xfb = nullptr;
static GXRModeObj* rmode = nullptr;
static u32 rows[REPORT_ROWS];
static int number_of_tests = 0;
static int number_of_tests_passed = 0;
static long long number_of_subtests = 0;
static long long number_of_subtests_passed = 0;
static long long test_failures = 0;
static long long test_subtests = 0;
static int failures_recorded = 0;

static void paint(u32 state)
{
  if (!xfb)
    return;
  rows[0] = 0x48575431u;
  rows[1] = state | ((u32)number_of_tests << 8);
  rows[2] = (u32)number_of_tests_passed;
  rows[3] = (u32)number_of_subtests;
  rows[4] = (u32)number_of_subtests_passed;
  rows[5] = (u32)failures_recorded;
  for (int r = 0; r < REPORT_ROWS; r++)
  {
    for (int i = 0; i < 32; i++)
      mk_fill(xfb, rmode, 32 + i * 18, REPORT_Y + r * 16, 14, 12, ((rows[r] >> (31 - i)) & 1) ? 235 : 16);
  }
  u32 sum = mk_fnv(MK_FNV_INIT, rows, sizeof rows);
  for (int i = 0; i < 32; i++)
    mk_fill(xfb, rmode, 32 + i * 18, REPORT_Y + REPORT_ROWS * 16, 14, 12, ((sum >> (31 - i)) & 1) ? 235 : 16);
  DCFlushRange(xfb, VIDEO_GetFrameBufferSize(rmode));
}

void network_vprintf(const char* str, va_list args)
{
  char buffer[4096];
  vsnprintf(buffer, sizeof buffer, str, args);
  OSReport("%s", buffer);
}

void network_printf(const char* str, ...)
{
  va_list args;
  va_start(args, str);
  network_vprintf(str, args);
  va_end(args);
}

void privStartTest(const char*, int)
{
  number_of_tests++;
  test_failures = 0;
  test_subtests = 0;
}

void privTestPassed()
{
  ++test_subtests;
  ++number_of_subtests;
  ++number_of_subtests_passed;
}

void privTestFailed(const char* file, int line, const std::string& fail_msg)
{
  ++test_subtests;
  ++number_of_subtests;
  ++test_failures;
  if (failures_recorded < REPORT_FAILURES)
  {
    rows[6 + 2 * failures_recorded] = ((u32)number_of_tests << 24) | ((u32)line & 0xffffff);
    rows[7 + 2 * failures_recorded] = mk_fnv(MK_FNV_INIT, fail_msg.data(), fail_msg.size());
    failures_recorded++;
  }
  OSReport("Subtest %lld failed in %s on line %d: %s\n", test_subtests, file, line, fail_msg.c_str());
}

void privEndTest()
{
  if (test_failures == 0)
    number_of_tests_passed++;
  paint(0);
}

void report_test_results()
{
}

void network_init()
{
  VIDEO_Init();
  rmode = VIDEO_GetPreferredMode(NULL);
  xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
  VIDEO_ClearFrameBuffer(rmode, xfb, COLOR_BLACK);
  VIDEO_Configure(rmode);
  VIDEO_SetNextFramebuffer(xfb);
  VIDEO_SetBlack(FALSE);
  VIDEO_Flush();
  VIDEO_WaitVSync();
  if (rmode->viTVMode & VI_NON_INTERLACE)
    VIDEO_WaitVSync();
  paint(0);
}

void network_shutdown()
{
  paint(1);
  for (;;)
    VIDEO_WaitVSync();
}

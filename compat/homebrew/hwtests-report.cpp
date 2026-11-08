/* Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Replaces hwtests' Common/hwtests.cpp (which reports over a TCP socket on a
 * Wii) for a GameCube build run by the harness: the same functions count
 * tests and subtests, and report.h paints the result into the XFB (failure
 * detail: FNV-1a of the hwtest's failure message). Rows are refreshed when
 * each test ends, so a run that hangs shows how far it got. Every failure
 * message also goes to OSReport.
 */
#include <stdio.h>
#include <string.h>

#include "Common/hwtests.h"
#include "report.h"

extern "C" __attribute__((weak)) void OSReport([[maybe_unused]] const char* fmt, ...) {}

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

void privStartTest(const char*, int) { rp_start_test(); }
void privTestPassed() { rp_result(1, 0, 0); }

void privTestFailed(const char* file, int line, const std::string& fail_msg)
{
  rp_result(0, line, mk_fnv(MK_FNV_INIT, fail_msg.data(), fail_msg.size()));
  OSReport("Subtest %u failed in %s on line %d: %s\n", rp.subtests, file, line, fail_msg.c_str());
}

void privEndTest() { rp_end_test(); }
void report_test_results() {}
void network_init() { rp_init(); }
void network_shutdown() { rp_done(); }

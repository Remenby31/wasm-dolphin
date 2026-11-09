/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: GPL-2.0-only
 * Stand-in for the Wii remote API the hwtests poll to stop a long loop
 * (HOME). No Wii remote on a GameCube: nothing is ever pressed. */
#pragma once
#define WPAD_BUTTON_HOME 0x0080
static inline int WPAD_Init(void) { return 0; }
static inline int WPAD_ScanPads(void) { return 0; }
static inline unsigned int WPAD_ButtonsDown(int chan) { (void)chan; return 0; }

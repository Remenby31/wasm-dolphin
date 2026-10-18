/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * tonetest: a continuous 440 Hz tone through the audio interface DMA, so the
 * harness can check that sound reaches the browser (and the selftest that a
 * muted output is caught). The picture is a plain grey screen.
 */
#include <gccore.h>
#include <string.h>

#define RATE 48000
#define FRAMES 4800 /* 100 ms: exactly 44 periods of 440 Hz */
static s16 tone[FRAMES * 2] ATTRIBUTE_ALIGN(32);

/* Integer sine, no libm: Bhaskara I approximation over a 109.09-sample period. */
static s16 sine_q15(u32 phase_q16) {
	s32 x = (s32)(phase_q16 & 0xffff); /* 0..65535 = 0..2pi */
	s32 sign = 1;
	if (x >= 32768) { x -= 32768; sign = -1; }
	/* sin(pi*t), t in [0,1): 16 t (1-t) / (5 - 4 t (1-t)) */
	s64 t = x;               /* /32768 */
	s64 p = t * (32768 - t); /* /2^30 */
	s64 num = 16 * p;        /* /2^30 */
	s64 den = 5LL * (1 << 30) - 4 * p;
	return (s16)(sign * (s32)((num * 16000) / den));
}

static void again(void) {
	AUDIO_InitDMA((u32)tone, sizeof tone);
	AUDIO_StartDMA();
}

int main(void) {
	VIDEO_Init();
	GXRModeObj *rmode = VIDEO_GetPreferredMode(NULL);
	void *xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
	VIDEO_ClearFrameBuffer(rmode, xfb, 0x80808080);
	VIDEO_Configure(rmode);
	VIDEO_SetNextFramebuffer(xfb);
	VIDEO_SetBlack(FALSE);
	VIDEO_Flush();
	VIDEO_WaitVSync();

	for (u32 i = 0; i < FRAMES; i++) {
		s16 v = sine_q15((u32)(((u64)i * 440 * 65536) / RATE));
		tone[2 * i] = v;
		tone[2 * i + 1] = v;
	}
	DCFlushRange(tone, sizeof tone);
	AUDIO_Init(NULL);
	AUDIO_SetDSPSampleRate(AI_SAMPLERATE_48KHZ);
	AUDIO_RegisterDMACallback(again);
	again();
	while (1) VIDEO_WaitVSync();
	return 0;
}

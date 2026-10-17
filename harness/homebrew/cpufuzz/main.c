/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * cpufuzz: differential fuzzer for the PowerPC CPU backends.
 *
 * At boot it generates NPROG random straight-line PowerPC programs (integer
 * ALU, rotates, XER/CR side effects, short forward branches, CTR loops,
 * loads/stores incl. byte-reversed, scalar FP) from a fixed seed, writes them
 * to RAM and runs every program once per frame on a fixed input state.
 *
 * Frame 0 runs before any JIT warmup, so its hashes are the interpreter
 * reference. Every later frame is compared against it; once the JIT engages
 * the same programs run as compiled blocks. The harness also compares the
 * final hash across a wasmjit=0 and a wasmjit=1 run.
 *
 * No printf/console on purpose: the libogc console path currently crashes the
 * WASM JIT, and this program must keep fuzzing anyway. Output is marker rows
 * (with their checksum row) only; from DONE_FRAME on the picture is frozen:
 *   row 0: combined hash of the last frame
 *   row 1: combined hash of frame 0
 *   row 2: bits 24-27 = mismatching groups (bit g = group g),
 *          bits 0-23 = number of mismatching programs
 *   row 3: index of the first mismatching program, 0xffffffff if none
 * Build with -DONLY_PROGRAM=n to run a single program while reducing a bug.
 */
#include <string.h>
#include <malloc.h>
#include <gccore.h>
#include "marker.h"

#ifndef SEED
#define SEED 0x5eed1234u
#endif
#define NPROG 384
#define BODY 40
#define DONE_FRAME 1500
#define MAXWORDS 128 /* >= prologue 19 + body BODY+3 + epilogue 19 */

enum { G_INT = 0, G_BRANCH = 1, G_FPMEM = 2, G_ALL = 3 };

typedef struct {
	u32 r[8];      /* r5..r12 */
	u32 cr;        /* 32 */
	u32 xer;       /* 36 */
	u32 buf;       /* 40: scratch buffer base, loaded into r4 */
	u32 saved_cr;  /* 44: caller CR (cr2-cr4 are non-volatile) */
	f64 f[4];      /* 48: f1..f4 */
} __attribute__((aligned(8))) state_t;

static u32 rng;
static u32 rnd(void) {
	rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
	return rng;
}
#define R(n) (rnd() % (n))
#define GPR() (5 + R(8))
#define FPR() (1 + R(4))

/* Static so the harness can map a crashing PC to (program, word) from the
 * symbol table: build.sh exports cpufuzz_code_pool's address. */
u32 cpufuzz_code_pool[NPROG][MAXWORDS] __attribute__((aligned(32)));
static u32 code_len[NPROG];
static state_t init_state[NPROG];
static u8 init_buf[NPROG][256];
static u32 *scratch;

/* --- encoders ----------------------------------------------------------- */
static u32 d_form(u32 op, u32 rt, u32 ra, u32 imm) { return (op << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff); }
static u32 x_form(u32 op, u32 rt, u32 ra, u32 rb, u32 xo, u32 rc) {
	return (op << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1) | rc;
}
static u32 xo_form(u32 rt, u32 ra, u32 rb, u32 oe, u32 xo, u32 rc) {
	return (31u << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (oe << 10) | (xo << 1) | rc;
}
static u32 a_form(u32 op, u32 frt, u32 fra, u32 frb, u32 frc, u32 xo) {
	return (op << 26) | (frt << 21) | (fra << 16) | (frb << 11) | (frc << 6) | (xo << 1);
}
static u32 m_form(u32 op, u32 rs, u32 ra, u32 sh, u32 mb, u32 me, u32 rc) {
	return (op << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1) | rc;
}

/* --- instruction pools -------------------------------------------------- */
static u32 gen_int(void) {
	static const u16 xo2[] = {266, 10, 138, 40, 8, 136, 235};
	static const u16 xo1[] = {202, 234, 200, 232, 104};
	static const u16 xlog[] = {28, 60, 444, 412, 316, 476, 124, 284, 24, 536, 792};
	static const u16 xun[] = {26, 954, 922};
	static const u8 dimm[] = {14, 15, 12, 13, 8, 7};
	static const u8 limm[] = {24, 25, 26, 27, 28, 29};
	static const u16 crop[] = {257, 449, 193, 225, 33, 289, 129, 417};
	u32 rc = R(2);
	switch (R(16)) {
	case 0: case 1: return xo_form(GPR(), GPR(), GPR(), R(2), xo2[R(7)], rc);
	case 2: return xo_form(GPR(), GPR(), 0, R(2), xo1[R(5)], rc);
	case 3: return xo_form(GPR(), GPR(), GPR(), 0, R(2) ? 75 : 11, rc); /* mulhw/mulhwu */
	case 4: return xo_form(GPR(), GPR(), GPR(), R(2), R(2) ? 491 : 459, rc); /* divw/divwu */
	case 5: case 6: return d_form(dimm[R(6)], GPR(), GPR(), rnd());
	case 7: return d_form(limm[R(6)], GPR(), GPR(), rnd());
	case 8: case 9: return x_form(31, GPR(), GPR(), GPR(), xlog[R(11)], rc);
	case 10: return x_form(31, GPR(), GPR(), R(32), 824, rc); /* srawi */
	case 11: return x_form(31, GPR(), GPR(), 0, xun[R(3)], rc);
	case 12: return m_form(R(2) ? 21 : 20, GPR(), GPR(), R(32), R(32), R(32), rc); /* rlwinm/rlwimi */
	case 13: return m_form(23, GPR(), GPR(), GPR(), R(32), R(32), rc);           /* rlwnm */
	case 14:
		switch (R(5)) {
		case 0: return x_form(31, R(8) << 2, GPR(), GPR(), R(2) ? 0 : 32, 0); /* cmp/cmpl */
		case 1: return d_form(R(2) ? 11 : 10, R(8) << 2, GPR(), rnd());       /* cmpi/cmpli */
		case 2: return x_form(31, GPR(), 0, 0, 19, 0);                        /* mfcr */
		case 3: return (31u << 26) | (GPR() << 21) | (R(256) << 12) | (144 << 1); /* mtcrf */
		default: return (31u << 26) | (GPR() << 21) | (32u << 11) | (339 << 1); /* mfxer */
		}
	default:
#ifdef CPUFUZZ_NO_MCRF
		if (1) return x_form(19, R(32), R(32), R(32), crop[R(8)], 0);
#else
		if (R(2)) return x_form(19, R(32), R(32), R(32), crop[R(8)], 0);
#endif
		return (19u << 26) | (R(8) << 23) | (R(8) << 18);                      /* mcrf */
	}
}

static u32 gen_fpmem(void) {
	static const u8 ld[] = {34, 40, 42, 32};   /* lbz lhz lha lwz */
	static const u8 st[] = {38, 44, 36};       /* stb sth stw */
	static const u8 size_ld[] = {1, 2, 2, 4}, size_st[] = {1, 2, 4};
	static const u16 brx[] = {790, 534, 918, 662}; /* lhbrx lwbrx sthbrx stwbrx */
	static const u8 a2[] = {21, 20, 18};          /* fadd fsub fdiv */
	static const u8 a3[] = {29, 28, 31, 30};      /* fmadd fmsub fnmadd fnmsub */
	static const u16 xun[] = {40, 72, 264, 136, 12, 15, 14};
	u32 k;
	switch (R(12)) {
	case 0: k = R(4); return d_form(ld[k], GPR(), 4, R(256 / size_ld[k]) * size_ld[k]);
	case 1: k = R(3); return d_form(st[k], GPR(), 4, R(256 / size_st[k]) * size_st[k]);
	case 2: return x_form(31, GPR(), 0, 4, brx[R(4)], 0);
	case 3: return d_form(R(2) ? 48 : 50, FPR(), 4, R(32) * 8);  /* lfs/lfd */
	case 4: return d_form(R(2) ? 52 : 54, FPR(), 4, R(32) * 8);  /* stfs/stfd */
	case 5: case 6: return a_form(R(2) ? 63 : 59, FPR(), FPR(), FPR(), 0, a2[R(3)]);
	case 7: return a_form(R(2) ? 63 : 59, FPR(), FPR(), 0, FPR(), 25); /* fmul */
	case 8: return a_form(R(2) ? 63 : 59, FPR(), FPR(), FPR(), FPR(), a3[R(4)]);
	case 9: return a_form(63, FPR(), FPR(), FPR(), FPR(), 23);          /* fsel */
	case 10: return x_form(63, FPR(), 0, FPR(), xun[R(7)], 0);
	default: return x_form(63, R(8) << 2, FPR(), FPR(), R(2) ? 0 : 32, 0); /* fcmpu/fcmpo */
	}
}

static u32 gen_one(int group) {
	if (group == G_INT || group == G_BRANCH) return gen_int();
	if (group == G_FPMEM) return gen_fpmem();
	return R(2) ? gen_int() : gen_fpmem();
}

static u32 emit_program(u32 *w, int group) {
	u32 n = 0;
	w[n++] = 0x7c800026;                         /* mfcr r4 */
	w[n++] = d_form(36, 4, 3, 44);                /* stw r4,44(r3) */
	for (int i = 0; i < 8; i++) w[n++] = d_form(32, 5 + i, 3, 4 * i);
	w[n++] = d_form(32, 4, 3, 32); w[n++] = 0x7c8ff120; /* mtcr r4 */
	w[n++] = d_form(32, 4, 3, 36); w[n++] = 0x7c8103a6; /* mtxer r4 */
	for (int i = 0; i < 4; i++) w[n++] = d_form(50, 1 + i, 3, 48 + 8 * i);
	w[n++] = d_form(32, 4, 3, 40);                /* r4 = scratch base */
	int left = BODY;
	while (left > 0) {
		int construct = (group == G_BRANCH || group == G_ALL) ? R(8) : 7;
		if (construct == 0 && left >= 3) {          /* conditional forward skip */
			u32 k = 1 + R(3);
			w[n++] = (16u << 26) | ((R(2) ? 12u : 4u) << 21) | (R(32) << 16) | (((k + 1) * 4) & 0xfffc);
			for (u32 i = 0; i < k; i++) w[n++] = gen_one(group);
			left -= k + 1;
		} else if (construct == 1 && left >= 6) {   /* CTR loop */
			u32 k = 1 + R(4);
			w[n++] = d_form(14, 0, 0, 1 + R(4));     /* li r0,n */
			w[n++] = 0x7c0903a6;                     /* mtctr r0 */
			for (u32 i = 0; i < k; i++) w[n++] = gen_int();
			w[n++] = (16u << 26) | (16u << 21) | ((-(s32)(k * 4)) & 0xfffc); /* bdnz */
			left -= k + 3;
		} else if (construct == 2 && left >= 2) {   /* unconditional skip */
			w[n++] = (18u << 26) | 8;                /* b +8 */
			w[n++] = gen_one(group);
			left -= 2;
		} else {
			w[n++] = gen_one(group);
			left -= 1;
		}
	}
	for (int i = 0; i < 8; i++) w[n++] = d_form(36, 5 + i, 3, 4 * i);
	w[n++] = 0x7c800026; w[n++] = d_form(36, 4, 3, 32); /* mfcr; stw cr */
	w[n++] = 0x7c8102a6; w[n++] = d_form(36, 4, 3, 36); /* mfxer; stw xer */
	for (int i = 0; i < 4; i++) w[n++] = d_form(54, 1 + i, 3, 48 + 8 * i);
	w[n++] = d_form(32, 4, 3, 44); w[n++] = 0x7c8ff120; /* restore caller CR */
	w[n++] = 0x4e800020;                         /* blr */
	return n;
}

static u32 special(void) {
	static const u32 s[] = {0, 1, 0xffffffffu, 0x80000000u, 0x7fffffffu, 0x8000u, 0xffffu, 31, 32};
	return R(3) ? rnd() : s[R(9)];
}

static f64 nice_double(void) {
	static const f64 v[] = {0.0, -0.0, 1.0, -1.0, 0.5, 1.5, 3.0, -2.25, 1e10, 1e-10,
	                        0.3333333333333333, 3.141592653589793, 65536.5, -7.0, 1e30, 1e-30};
	return v[R(16)];
}

static u32 hash_double(u32 h, f64 d) {
	u32 w[2];
	memcpy(w, &d, 8);
	if ((w[0] & 0x7ff00000u) == 0x7ff00000u && ((w[0] & 0xfffffu) | w[1])) {
		w[0] = 0x7ff80000u; w[1] = 0; /* NaN payloads are not part of the contract */
	}
	return mk_fnv(h, w, 8);
}

static u32 run_program(int i) {
	state_t st = init_state[i];
	memcpy(scratch, init_buf[i], 256);
	DCFlushRange(scratch, 256);
	st.buf = (u32)scratch;
	((void (*)(state_t *))cpufuzz_code_pool[i])(&st);
	u32 h = MK_FNV_INIT;
	h = mk_fnv(h, st.r, sizeof st.r);
	h = mk_fnv(h, &st.cr, 4);
	h = mk_fnv(h, &st.xer, 4);
	for (int k = 0; k < 4; k++) h = hash_double(h, st.f[k]);
	return mk_fnv(h, scratch, 256);
}

int main(void) {
	VIDEO_Init();
	GXRModeObj *rmode = VIDEO_GetPreferredMode(NULL);
	void *xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
	VIDEO_ClearFrameBuffer(rmode, xfb, COLOR_BLACK);
	VIDEO_Configure(rmode);
	VIDEO_SetNextFramebuffer(xfb);
	VIDEO_SetBlack(FALSE);
	VIDEO_Flush();
	VIDEO_WaitVSync();
	if (rmode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();

	scratch = memalign(32, 256);
	rng = SEED;
	for (int i = 0; i < NPROG; i++) {
		code_len[i] = emit_program(cpufuzz_code_pool[i], i & 3);
		DCFlushRange(cpufuzz_code_pool[i], code_len[i] * 4);
		ICInvalidateRange(cpufuzz_code_pool[i], code_len[i] * 4);
		for (int k = 0; k < 8; k++) init_state[i].r[k] = special();
		init_state[i].cr = rnd();
		init_state[i].xer = rnd() & 0xe000007fu;
		for (int k = 0; k < 4; k++) init_state[i].f[k] = nice_double();
		for (int k = 0; k < 32; k++) {
			if (R(2)) { f64 d = nice_double(); memcpy(&init_buf[i][k * 8], &d, 8); }
			else { u32 v[2] = {special(), special()}; memcpy(&init_buf[i][k * 8], v, 8); }
		}
	}

	static u32 ref[NPROG];
	u32 first = 0, last = 0, mismatches = 0, groups = 0, first_bad = 0xffffffffu;
	static u8 bad[NPROG];
	for (u32 frame = 0;; frame++) {
		if (frame <= DONE_FRAME) {
			u32 all = MK_FNV_INIT;
			for (int i = 0; i < NPROG; i++) {
#ifdef ONLY_PROGRAM
				if (i != ONLY_PROGRAM) continue;
#endif
				u32 h = run_program(i);
				if (frame == 0) ref[i] = h;
				else if (h != ref[i] && !bad[i]) {
					bad[i] = 1;
					mismatches++;
					groups |= 1u << (i & 3);
					if (first_bad == 0xffffffffu) first_bad = i;
				}
				all = mk_fnv(all, &h, 4);
			}
			last = all;
			if (frame == 0) first = all;
		}
		const u32 rows[MK_ROWS] = {last, first, (groups << 24) | (mismatches & 0xffffff), first_bad};
		mk_rows(xfb, rmode, rows);
		VIDEO_WaitVSync();
	}
	return 0;
}

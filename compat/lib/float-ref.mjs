// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests Common/FloatUtils.h: the hwtests' models of
// Broadway's mantissa rounding on paired-single moves and of the fres and
// frsqrte estimate tables (validated on hardware by cputest/reciprocal.cpp
// and cputest/pairedmove.cpp). Everything works on 64-bit patterns (BigInt).
import { bitsOfDouble, doubleBitsOfFloatBits } from "./ppc.mjs";

export const DOUBLE_SIGN = 0x8000000000000000n;
export const DOUBLE_EXP = 0x7ff0000000000000n;
export const DOUBLE_FRAC = 0x000fffffffffffffn;
export const DOUBLE_QBIT = 0x0008000000000000n;
const QNAN = 0x7ff8000000000000n;
const INF = 0x7ff0000000000000n;
const REMOVE = 29n; // 52 - 23
const REMOVE_MASK = (1n << REMOVE) - 1n;
const u64 = (v) => BigInt.asUintN(64, v);
// "0.0 + val" on a NaN: the NaN, quieted.
const quiet = (b) => b | DOUBLE_QBIT;
const isNaNBits = (b) => (b & DOUBLE_EXP) === DOUBLE_EXP && (b & DOUBLE_FRAC) !== 0n;

export const truncateMantissaBits = (bits) => bits & ~REMOVE_MASK & 0xffffffffffffffffn;

export function roundMantissaBitsAssumeFinite(bits, mode) {
  const roundDown = bits & ~REMOVE_MASK & 0xffffffffffffffffn;
  const masked = bits & REMOVE_MASK;
  let roundUp = u64(roundDown + (bits === roundDown ? 0n : 1n << REMOVE));
  if ((bits & DOUBLE_EXP) === 0n) roundUp &= ~DOUBLE_EXP & 0xffffffffffffffffn;
  const evenSplit = 1n << (REMOVE - 1n);
  const negative = (bits & DOUBLE_SIGN) !== 0n;
  switch (mode) {
    case 0: return masked > evenSplit || (masked === evenSplit && (bits & (1n << REMOVE)) !== 0n) ? roundUp : roundDown;
    case 1: return roundDown;
    case 2: return negative ? roundDown : roundUp;
    default: return negative ? roundUp : roundDown;
  }
}

export const roundMantissaBits = (bits, mode) =>
  ((bits & DOUBLE_EXP) === DOUBLE_EXP ? truncateMantissaBits(bits) : roundMantissaBitsAssumeFinite(bits, mode));

const RSQRTE_BASE = [
  0x3ffa000, 0x3c29000, 0x38aa000, 0x3572000, 0x3279000, 0x2fb7000, 0x2d26000, 0x2ac0000,
  0x2881000, 0x2665000, 0x2468000, 0x2287000, 0x20c1000, 0x1f12000, 0x1d79000, 0x1bf4000,
  0x1a7e800, 0x17cb800, 0x1552800, 0x130c000, 0x10f2000, 0x0eff000, 0x0d2e000, 0x0b7c000,
  0x09e5000, 0x0867000, 0x06ff000, 0x05ab800, 0x046a000, 0x0339800, 0x0218800, 0x0105800];
const RSQRTE_DEC = [
  0x7a4, 0x700, 0x670, 0x5f2, 0x584, 0x524, 0x4cc, 0x47e, 0x43a, 0x3fa, 0x3c2,
  0x38e, 0x35e, 0x332, 0x30a, 0x2e6, 0x568, 0x4f3, 0x48d, 0x435, 0x3e7, 0x3a2,
  0x365, 0x32e, 0x2fc, 0x2d0, 0x2a8, 0x283, 0x261, 0x243, 0x226, 0x20b];

export function frsqrteExpected(b) {
  let mantissa = b & DOUBLE_FRAC;
  const sign = b & DOUBLE_SIGN;
  let exponent = b & DOUBLE_EXP;
  if (mantissa === 0n && exponent === 0n) return sign ? INF | DOUBLE_SIGN : INF;
  if (exponent === DOUBLE_EXP) {
    if (mantissa === 0n) return sign ? QNAN : 0n;
    return quiet(b);
  }
  if (sign) return QNAN;
  if (exponent === 0n) {
    do { exponent -= 1n << 52n; mantissa <<= 1n; } while ((mantissa & (1n << 52n)) === 0n);
    mantissa &= DOUBLE_FRAC;
    exponent += 1n << 52n;
  }
  const odd = (exponent & (1n << 52n)) === 0n;
  exponent = ((0x3ffn << 52n) - ((exponent - (0x3fen << 52n)) / 2n)) & (0x7ffn << 52n);
  const i = Number(mantissa >> 37n);
  const index = Math.trunc(i / 2048) + (odd ? 16 : 0);
  return u64(sign | exponent | (BigInt(RSQRTE_BASE[index] - RSQRTE_DEC[index] * (i % 2048)) << 26n));
}

const RES_BASE = [
  0xfff000, 0xf07000, 0xe1d400, 0xd41000, 0xc71000, 0xbac400, 0xaf2000, 0xa41000,
  0x999000, 0x8f9400, 0x861000, 0x7d0000, 0x745800, 0x6c1000, 0x642800, 0x5c9400,
  0x555000, 0x4e5800, 0x47ac00, 0x413c00, 0x3b1000, 0x352000, 0x2f5c00, 0x29f000,
  0x248800, 0x1f7c00, 0x1a7000, 0x15bc00, 0x110800, 0x0ca000, 0x083800, 0x041800];
const RES_DEC = [
  -0x3e1, -0x3a7, -0x371, -0x340, -0x313, -0x2ea, -0x2c4, -0x2a0, -0x27f, -0x261, -0x245,
  -0x22a, -0x212, -0x1fb, -0x1e5, -0x1d1, -0x1be, -0x1ac, -0x19b, -0x18b, -0x17c, -0x16e,
  -0x15b, -0x15b, -0x143, -0x143, -0x12d, -0x12d, -0x11a, -0x11a, -0x108, -0x106];
const FLT_MAX = 3.4028234663852886e38;

export function fresExpected(b, ni) {
  const mantissa = Number((b & DOUBLE_FRAC) >> REMOVE);
  const sign = (Number(b >> 32n) & 0x80000000) >>> 0;
  let exponent = Number((b & DOUBLE_EXP) >> 52n) - 0x380;
  if ((b & DOUBLE_EXP) <= 0x37e0000000000000n) {
    if ((b & ~DOUBLE_SIGN) === 0n) return sign ? INF | DOUBLE_SIGN : INF;
    return bitsOfDouble(sign ? -FLT_MAX : FLT_MAX);
  }
  const maxFloat = ni ? 0x47d0000000000000n : 0x4940000000000000n;
  if ((b & DOUBLE_EXP) >= maxFloat) {
    if (!isNaNBits(b)) return sign ? DOUBLE_SIGN : 0n;
    return quiet(b);
  }
  exponent = 253 - exponent;
  const key = mantissa >>> 18;
  const newMantissa = ((RES_BASE[key] + RES_DEC[key] * ((mantissa >>> 8) & 0x3ff)) >>> 0) >>> 1;
  let vali;
  if (exponent <= 0) {
    vali = ni ? sign : (sign | (((1 << 23) | newMantissa) >>> (1 - exponent))) >>> 0;
  } else {
    vali = (sign | (exponent << 23) | newMantissa) >>> 0;
  }
  return doubleBitsOfFloatBits(vali);
}

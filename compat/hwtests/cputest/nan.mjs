// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/nan.cpp: which NaN an FP or
// paired-single operation returns (first NaN operand in A, B, C order,
// quieted; the default NaN for invalid operations), also when the
// destination is one of the sources, and in either slot of a pair (the other
// slot holds signalling single NaNs loaded with psq_l). Values measured on
// hardware.
//
// TESTS is each hwtest function's asm block, transcribed by a script from
// nan.cpp (template and operand list unchanged) and assembled here. Operands
// get fixed registers: the SINGLE_SNANS pointer r3; result f1, ps1_result
// f6, a_tmp f2, b_tmp f3, c_tmp f4; inputs a f10, b f11, c f12, input f13.
// "psq_l %1, 0(%1)" in TestPsNmaddUpperWithSharedABC names the pointer's
// GPR as an FPR, as the compiled hwtest does: it loads f3.
import { makeState, read, hex64, BLR, SCRATCH } from "../../lib/ppc.mjs";

export const source = "cputest/nan.cpp";

const TESTS = [
  {"name":"TestFadd","params":["a","b","expected"],"init":[],"asm":["fadd %0, %1, %2"],"operands":[["=d","result"],["d","a"],["d","b"]]},
  {"name":"TestFaddWithSharedA","params":["a","b","expected"],"init":[["result","a"]],"asm":["fadd %0, %0, %1"],"operands":[["+d","result"],["d","b"]]},
  {"name":"TestFaddWithSharedB","params":["a","b","expected"],"init":[["result","b"]],"asm":["fadd %0, %1, %0"],"operands":[["+d","result"],["d","a"]]},
  {"name":"TestPsAddLower","params":["a","b","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 8(%3), 0, 0","ps_merge01 %1, %4, %1","ps_merge01 %2, %5, %2","ps_add %0, %1, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsAddUpper","params":["a","b","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 8(%3), 0, 0","ps_merge00 %1, %1, %4","ps_merge00 %2, %2, %5","ps_add %0, %1, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsAddLowerWithSharedA","params":["a","b","expected"],"init":[],"asm":["psq_l %0, 0(%2), 0, 0","psq_l %1, 8(%2), 0, 0","ps_merge01 %0, %3, %0","ps_merge01 %1, %4, %1","ps_add %0, %0, %1"],"operands":[["=d","result"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsAddUpperWithSharedA","params":["a","b","expected"],"init":[],"asm":["psq_l %0, 0(%2), 0, 0","psq_l %1, 8(%2), 0, 0","ps_merge00 %0, %0, %3","ps_merge00 %1, %1, %4","ps_add %0, %0, %1","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsAddLowerWithSharedB","params":["a","b","expected"],"init":[],"asm":["psq_l %1, 0(%2), 0, 0","psq_l %0, 8(%2), 0, 0","ps_merge01 %1, %3, %1","ps_merge01 %0, %4, %0","ps_add %0, %1, %0"],"operands":[["=d","result"],["=d","a_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsAddUpperWithSharedB","params":["a","b","expected"],"init":[],"asm":["psq_l %1, 0(%2), 0, 0","psq_l %0, 8(%2), 0, 0","ps_merge00 %1, %1, %3","ps_merge00 %0, %0, %4","ps_add %0, %1, %0","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestFdiv","params":["a","b","expected"],"init":[],"asm":["fdiv %0, %1, %2"],"operands":[["=d","result"],["d","a"],["d","b"]]},
  {"name":"TestFdivWithSharedA","params":["a","b","expected"],"init":[["result","a"]],"asm":["fdiv %0, %0, %1"],"operands":[["+d","result"],["d","b"]]},
  {"name":"TestFdivWithSharedB","params":["a","b","expected"],"init":[["result","b"]],"asm":["fdiv %0, %1, %0"],"operands":[["+d","result"],["d","a"]]},
  {"name":"TestPsDivLower","params":["a","b","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 8(%3), 0, 0","ps_merge01 %1, %4, %1","ps_merge01 %2, %5, %2","ps_div %0, %1, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsDivUpper","params":["a","b","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 8(%3), 0, 0","ps_merge00 %1, %1, %4","ps_merge00 %2, %2, %5","ps_div %0, %1, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsDivLowerWithSharedA","params":["a","b","expected"],"init":[],"asm":["psq_l %0, 0(%2), 0, 0","psq_l %1, 8(%2), 0, 0","ps_merge01 %0, %3, %0","ps_merge01 %1, %4, %1","ps_div %0, %0, %1"],"operands":[["=d","result"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsDivUpperWithSharedA","params":["a","b","expected"],"init":[],"asm":["psq_l %0, 0(%2), 0, 0","psq_l %1, 8(%2), 0, 0","ps_merge00 %0, %0, %3","ps_merge00 %1, %1, %4","ps_div %0, %0, %1","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsDivLowerWithSharedB","params":["a","b","expected"],"init":[],"asm":["psq_l %1, 0(%2), 0, 0","psq_l %0, 8(%2), 0, 0","ps_merge01 %1, %3, %1","ps_merge01 %0, %4, %0","ps_div %0, %1, %0"],"operands":[["=d","result"],["=d","a_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsDivUpperWithSharedB","params":["a","b","expected"],"init":[],"asm":["psq_l %1, 0(%2), 0, 0","psq_l %0, 8(%2), 0, 0","ps_merge00 %1, %1, %3","ps_merge00 %0, %0, %4","ps_div %0, %1, %0","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestFmul","params":["a","c","expected"],"init":[],"asm":["fmul %0, %1, %2"],"operands":[["=d","result"],["d","a"],["d","c"]]},
  {"name":"TestFmulWithSharedA","params":["a","c","expected"],"init":[["result","a"]],"asm":["fmul %0, %0, %1"],"operands":[["+d","result"],["d","c"]]},
  {"name":"TestFmulWithSharedC","params":["a","c","expected"],"init":[["result","c"]],"asm":["fmul %0, %1, %0"],"operands":[["+d","result"],["d","a"]]},
  {"name":"TestPsMulLower","params":["a","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge01 %1, %4, %1","ps_merge01 %2, %5, %2","ps_mul %0, %1, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMulUpper","params":["a","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge00 %1, %1, %4","ps_merge00 %2, %2, %5","ps_mul %0, %1, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMulLowerWithSharedA","params":["a","c","expected"],"init":[],"asm":["psq_l %0, 0(%2), 0, 0","psq_l %1, 16(%2), 0, 0","ps_merge01 %0, %3, %0","ps_merge01 %1, %4, %1","ps_mul %0, %0, %1"],"operands":[["=d","result"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMulUpperWithSharedA","params":["a","c","expected"],"init":[],"asm":["psq_l %0, 0(%2), 0, 0","psq_l %1, 16(%2), 0, 0","ps_merge00 %0, %0, %3","ps_merge00 %1, %1, %4","ps_mul %0, %0, %1","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMulLowerWithSharedC","params":["a","c","expected"],"init":[],"asm":["psq_l %1, 0(%2), 0, 0","psq_l %0, 16(%2), 0, 0","ps_merge01 %1, %3, %1","ps_merge01 %0, %4, %0","ps_mul %0, %1, %0"],"operands":[["=d","result"],["=d","a_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMulUpperWithSharedC","params":["a","c","expected"],"init":[],"asm":["psq_l %1, 0(%2), 0, 0","psq_l %0, 16(%2), 0, 0","ps_merge00 %1, %1, %3","ps_merge00 %0, %0, %4","ps_mul %0, %1, %0","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestFmadd","params":["a","b","c","expected"],"init":[],"asm":["fmadd %0, %1, %3, %2"],"operands":[["=d","result"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsMaddLower","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%4), 0, 0","psq_l %2, 8(%4), 0, 0","psq_l %3, 16(%4), 0, 0","ps_merge01 %1, %5, %1","ps_merge01 %2, %6, %2","ps_merge01 %3, %7, %3","ps_madd %0, %1, %3, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsMaddUpper","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%4), 0, 0","psq_l %2, 8(%4), 0, 0","psq_l %3, 16(%4), 0, 0","ps_merge00 %1, %1, %5","ps_merge00 %2, %2, %6","ps_merge00 %3, %3, %7","ps_madd %0, %1, %3, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestFnmadd","params":["a","b","c","expected"],"init":[],"asm":["fnmadd %0, %1, %3, %2"],"operands":[["=d","result"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestFnmaddWithSharedA","params":["a","b","c","expected"],"init":[["result","a"]],"asm":["fnmadd %0, %0, %2, %1"],"operands":[["+d","result"],["d","b"],["d","c"]]},
  {"name":"TestFnmaddWithSharedB","params":["a","b","c","expected"],"init":[["result","b"]],"asm":["fnmadd %0, %1, %2, %0"],"operands":[["+d","result"],["d","a"],["d","c"]]},
  {"name":"TestFnmaddWithSharedC","params":["a","b","c","expected"],"init":[["result","c"]],"asm":["fnmadd %0, %1, %0, %2"],"operands":[["+d","result"],["d","a"],["d","b"]]},
  {"name":"TestFnmaddWithSharedABC","params":["input","expected"],"init":[["result","input"]],"asm":["fnmadd %0, %0, %0, %0"],"operands":[["+d","result"]]},
  {"name":"TestPsNmaddLower","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%4), 0, 0","psq_l %2, 8(%4), 0, 0","psq_l %3, 16(%4), 0, 0","ps_merge01 %1, %5, %1","ps_merge01 %2, %6, %2","ps_merge01 %3, %7, %3","ps_nmadd %0, %1, %3, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsNmaddUpper","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%4), 0, 0","psq_l %2, 8(%4), 0, 0","psq_l %3, 16(%4), 0, 0","ps_merge00 %1, %1, %5","ps_merge00 %2, %2, %6","ps_merge00 %3, %3, %7","ps_nmadd %0, %1, %3, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsNmaddLowerWithSharedA","params":["a","b","c","expected"],"init":[],"asm":["psq_l %0, 0(%3), 0, 0","psq_l %1, 8(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge01 %0, %4, %0","ps_merge01 %1, %5, %1","ps_merge01 %2, %6, %2","ps_nmadd %0, %0, %2, %1"],"operands":[["=d","result"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsNmaddUpperWithSharedA","params":["a","b","c","expected"],"init":[],"asm":["psq_l %0, 0(%3), 0, 0","psq_l %1, 8(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge00 %0, %0, %4","ps_merge00 %1, %1, %5","ps_merge00 %2, %2, %6","ps_nmadd %0, %0, %2, %1","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsNmaddLowerWithSharedB","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 8(%3), 0, 0","psq_l %3, 16(%3), 0, 0","ps_merge01 %1, %4, %1","ps_merge01 %2, %5, %2","ps_merge01 %3, %6, %3","ps_nmadd %0, %1, %3, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsNmaddUpperWithSharedB","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %0, 8(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge00 %1, %1, %4","ps_merge00 %0, %0, %5","ps_merge00 %2, %2, %6","ps_nmadd %0, %1, %2, %0","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsNmaddLowerWithSharedC","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 8(%3), 0, 0","psq_l %0, 16(%3), 0, 0","ps_merge01 %1, %4, %1","ps_merge01 %2, %5, %2","ps_merge01 %0, %6, %0","ps_nmadd %0, %1, %0, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsNmaddUpperWithSharedC","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 8(%3), 0, 0","psq_l %0, 16(%3), 0, 0","ps_merge00 %1, %1, %4","ps_merge00 %2, %2, %5","ps_merge00 %0, %0, %6","ps_nmadd %0, %1, %0, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsNmaddLowerWithSharedABC","params":["input","expected"],"init":[],"asm":["psq_l %0, 0(%1), 0, 0","ps_merge01 %0, %2, %0","ps_nmadd %0, %0, %0, %0"],"operands":[["=d","result"],["b","SINGLE_SNANS"],["d","input"]]},
  {"name":"TestPsNmaddUpperWithSharedABC","params":["input","expected"],"init":[],"asm":["psq_l %1, 0(%1), 0, 0","ps_merge00 %0, %0, %2","ps_nmadd %0, %0, %0, %0","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["b","SINGLE_SNANS"],["d","input"]]},
  {"name":"TestPsSum0","params":["a","b","ps0_expected"],"init":[],"asm":["psq_l %2, 0(%5), 0, 0","psq_l %3, 8(%5), 0, 0","psq_l %4, 16(%5), 0, 0","ps_merge01 %2, %6, %2","ps_merge00 %3, %3, %7","ps_sum0 %0, %2, %4, %3","ps_merge11 %1, %0, %0"],"operands":[["=d","ps0_result"],["=d","ps1_result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsSum1","params":["a","b","ps1_expected"],"init":[],"asm":["psq_l %2, 0(%5), 0, 0","psq_l %3, 8(%5), 0, 0","psq_l %4, 16(%5), 0, 0","ps_merge01 %2, %6, %2","ps_merge00 %3, %3, %7","ps_sum1 %0, %2, %4, %3","ps_merge11 %1, %0, %0"],"operands":[["=d","ps0_result"],["=d","ps1_result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"]]},
  {"name":"TestPsMuls0Lower","params":["a","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge01 %1, %4, %1","ps_merge01 %2, %5, %2","ps_muls0 %0, %1, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMuls0Upper","params":["a","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge00 %1, %1, %4","ps_merge01 %2, %5, %2","ps_muls0 %0, %1, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMuls1Lower","params":["a","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge01 %1, %4, %1","ps_merge00 %2, %2, %5","ps_muls1 %0, %1, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMuls1Upper","params":["a","c","expected"],"init":[],"asm":["psq_l %1, 0(%3), 0, 0","psq_l %2, 16(%3), 0, 0","ps_merge00 %1, %1, %4","ps_merge00 %2, %2, %5","ps_muls1 %0, %1, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","c"]]},
  {"name":"TestPsMadds0Lower","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%4), 0, 0","psq_l %2, 8(%4), 0, 0","psq_l %3, 16(%4), 0, 0","ps_merge01 %1, %5, %1","ps_merge01 %2, %6, %2","ps_merge01 %3, %7, %3","ps_madds0 %0, %1, %3, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsMadds0Upper","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%4), 0, 0","psq_l %2, 8(%4), 0, 0","psq_l %3, 16(%4), 0, 0","ps_merge00 %1, %1, %5","ps_merge00 %2, %2, %6","ps_merge01 %3, %7, %3","ps_madds0 %0, %1, %3, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsMadds1Lower","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%4), 0, 0","psq_l %2, 8(%4), 0, 0","psq_l %3, 16(%4), 0, 0","ps_merge01 %1, %5, %1","ps_merge01 %2, %6, %2","ps_merge00 %3, %3, %7","ps_madds1 %0, %1, %3, %2"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
  {"name":"TestPsMadds1Upper","params":["a","b","c","expected"],"init":[],"asm":["psq_l %1, 0(%4), 0, 0","psq_l %2, 8(%4), 0, 0","psq_l %3, 16(%4), 0, 0","ps_merge00 %1, %1, %5","ps_merge00 %2, %2, %6","ps_merge00 %3, %3, %7","ps_madds1 %0, %1, %3, %2","ps_merge11 %0, %0, %0"],"operands":[["=d","result"],["=d","a_tmp"],["=d","b_tmp"],["=d","c_tmp"],["b","SINGLE_SNANS"],["d","a"],["d","b"],["d","c"]]},
];

// ---- a small assembler for these templates ---------------------------------
const u = (v) => v >>> 0;
const A = (op, t, a, b, c, xo) => u((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1));
const ENC = {
  fadd: (d, a, b) => A(63, d, a, b, 0, 21), fdiv: (d, a, b) => A(63, d, a, b, 0, 18),
  fmul: (d, a, c) => A(63, d, a, 0, c, 25), fmadd: (d, a, c, b) => A(63, d, a, b, c, 29),
  fnmadd: (d, a, c, b) => A(63, d, a, b, c, 31),
  ps_add: (d, a, b) => A(4, d, a, b, 0, 21), ps_div: (d, a, b) => A(4, d, a, b, 0, 18),
  ps_mul: (d, a, c) => A(4, d, a, 0, c, 25), ps_madd: (d, a, c, b) => A(4, d, a, b, c, 29),
  ps_nmadd: (d, a, c, b) => A(4, d, a, b, c, 31), ps_sum0: (d, a, c, b) => A(4, d, a, b, c, 10),
  ps_sum1: (d, a, c, b) => A(4, d, a, b, c, 11), ps_muls0: (d, a, c) => A(4, d, a, 0, c, 12),
  ps_muls1: (d, a, c) => A(4, d, a, 0, c, 13), ps_madds0: (d, a, c, b) => A(4, d, a, b, c, 14),
  ps_madds1: (d, a, c, b) => A(4, d, a, b, c, 15),
  ps_merge00: (d, a, b) => A(4, d, a, b, 0, 0) | (528 << 1), ps_merge01: (d, a, b) => A(4, d, a, b, 0, 0) | (560 << 1),
  ps_merge10: (d, a, b) => A(4, d, a, b, 0, 0) | (592 << 1), ps_merge11: (d, a, b) => A(4, d, a, b, 0, 0) | (624 << 1),
  psq_l: (d, disp, ra, w, i) => u((56 << 26) | (d << 21) | (ra << 16) | (w << 15) | (i << 12) | (disp & 0xfff))
};
const REG = { result: 1, ps0_result: 1, a_tmp: 2, b_tmp: 3, c_tmp: 4, ps1_result: 6, a: 10, b: 11, c: 12, input: 13, SINGLE_SNANS: 3 };

export function assemble(test) {
  const reg = (n) => REG[test.operands[n][1]];
  return test.asm.map((line) => {
    const [mn, rest] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
    const args = rest.split(",").map((s) => s.trim());
    const enc = ENC[mn];
    if (!enc) throw new Error(`nan: no encoder for ${mn}`);
    if (mn === "psq_l") {
      const [, disp, base] = args[1].match(/^(-?\d+)\(%(\d+)\)$/);
      return enc(reg(+args[0].slice(1)), +disp, reg(+base), +args[2], +args[3]);
    }
    return enc(...args.map((a) => reg(+a.slice(1))));
  });
}

// ---- the hwtest's values -----------------------------------------------------
const QUIET_BIT = 0x0008000000000000n;
const Q_POS_NAN_0 = 0x7ff8000000000000n, Q_POS_NAN_1 = 0x7ff8000100000000n, Q_POS_NAN_2 = 0x7ff8000200000000n,
  Q_POS_NAN_3 = 0x7ff8000300000000n;
const S_POS_NAN_1 = 0x7ff0000100000000n, S_POS_NAN_2 = 0x7ff0000200000000n, S_POS_NAN_3 = 0x7ff0000300000000n;
const Q_NEG_NAN_1 = 0xfff8000100000000n, Q_NEG_NAN_2 = 0xfff8000200000000n, Q_NEG_NAN_3 = 0xfff8000300000000n;
const SINGLE_SNANS = [0x7f800004, 0x7f800005, 0x7f800006, 0x7f800007, 0x7f800008, 0x7f800009];
const DEFAULT_NAN = Q_POS_NAN_0;
const ZERO = 0n, NZERO = 0x8000000000000000n, ONE = 0x3ff0000000000000n, MONE = 0xbff0000000000000n;
const INF = 0x7ff0000000000000n, NINF = 0xfff0000000000000n;
// static_cast<double>(float SNaN) & ~QUIET_BIT: the single widened, still signalling.
const widened = (f) => ((BigInt(f & 0x80000000) << 32n) | (0x7ffn << 52n) | (BigInt(f & 0x7fffff) << 29n)) & ~QUIET_BIT;

const ADD = [[ZERO, ZERO, ZERO], [Q_NEG_NAN_1, ZERO, Q_NEG_NAN_1], [ZERO, Q_NEG_NAN_2, Q_NEG_NAN_2],
  [Q_POS_NAN_1, Q_POS_NAN_2, Q_POS_NAN_1], [S_POS_NAN_1, Q_POS_NAN_2, Q_POS_NAN_1], [Q_POS_NAN_1, S_POS_NAN_2, Q_POS_NAN_1],
  [S_POS_NAN_1, S_POS_NAN_2, Q_POS_NAN_1]];
const DIV = [[ONE, ONE, ONE], [ZERO, ZERO, DEFAULT_NAN], [NZERO, NZERO, DEFAULT_NAN], ...ADD.slice(1)];
const MUL = [[ONE, ONE, ONE], [INF, ZERO, DEFAULT_NAN], [NINF, ZERO, DEFAULT_NAN], ...ADD.slice(1)];
const madd = (first) => [[ONE, ZERO, ONE, first], [INF, ONE, ZERO, DEFAULT_NAN], [NINF, ONE, ZERO, DEFAULT_NAN],
  [INF, Q_NEG_NAN_2, ZERO, Q_NEG_NAN_2], [Q_NEG_NAN_1, ZERO, ZERO, Q_NEG_NAN_1], [ZERO, Q_NEG_NAN_2, ZERO, Q_NEG_NAN_2],
  [ZERO, ZERO, Q_NEG_NAN_3, Q_NEG_NAN_3], [Q_NEG_NAN_1, Q_NEG_NAN_2, ZERO, Q_NEG_NAN_1],
  [Q_NEG_NAN_1, ZERO, Q_NEG_NAN_3, Q_NEG_NAN_1], [ZERO, Q_NEG_NAN_2, Q_NEG_NAN_3, Q_NEG_NAN_2],
  [Q_POS_NAN_1, Q_POS_NAN_2, Q_POS_NAN_3, Q_POS_NAN_1], [S_POS_NAN_1, Q_POS_NAN_2, Q_POS_NAN_3, Q_POS_NAN_1],
  [Q_POS_NAN_1, S_POS_NAN_2, Q_POS_NAN_3, Q_POS_NAN_1], [S_POS_NAN_1, S_POS_NAN_2, Q_POS_NAN_3, Q_POS_NAN_1],
  [Q_POS_NAN_1, Q_POS_NAN_2, S_POS_NAN_3, Q_POS_NAN_1], [S_POS_NAN_1, Q_POS_NAN_2, S_POS_NAN_3, Q_POS_NAN_1],
  [Q_POS_NAN_1, S_POS_NAN_2, S_POS_NAN_3, Q_POS_NAN_1], [S_POS_NAN_1, S_POS_NAN_2, S_POS_NAN_3, Q_POS_NAN_1]];
const SHARED_ABC = [[0x3ff8000000000000n, 0xc00e000000000000n], [Q_POS_NAN_1, Q_POS_NAN_1], [Q_NEG_NAN_1, Q_NEG_NAN_1]];

// main(): which value table each test function runs with.
const RUNS = [
  ...["TestFadd", "TestFaddWithSharedA", "TestFaddWithSharedB", "TestPsAddLower", "TestPsAddUpper",
    "TestPsAddLowerWithSharedA", "TestPsAddUpperWithSharedA", "TestPsAddLowerWithSharedB", "TestPsAddUpperWithSharedB",
    "TestPsSum0", "TestPsSum1"].map((n) => [n, ADD]),
  ...["TestFdiv", "TestFdivWithSharedA", "TestFdivWithSharedB", "TestPsDivLower", "TestPsDivUpper",
    "TestPsDivLowerWithSharedA", "TestPsDivUpperWithSharedA", "TestPsDivLowerWithSharedB", "TestPsDivUpperWithSharedB"]
    .map((n) => [n, DIV]),
  ...["TestFmul", "TestFmulWithSharedA", "TestFmulWithSharedC", "TestPsMulLower", "TestPsMulUpper",
    "TestPsMulLowerWithSharedA", "TestPsMulUpperWithSharedA", "TestPsMulLowerWithSharedC", "TestPsMulUpperWithSharedC",
    "TestPsMuls0Lower", "TestPsMuls0Upper", "TestPsMuls1Lower", "TestPsMuls1Upper"].map((n) => [n, MUL]),
  ...["TestFmadd", "TestPsMaddLower", "TestPsMaddUpper", "TestPsMadds0Lower", "TestPsMadds0Upper",
    "TestPsMadds1Lower", "TestPsMadds1Upper"].map((n) => [n, madd(ONE)]),
  ...["TestFnmadd", "TestFnmaddWithSharedA", "TestFnmaddWithSharedB", "TestFnmaddWithSharedC", "TestPsNmaddLower",
    "TestPsNmaddUpper", "TestPsNmaddLowerWithSharedA", "TestPsNmaddUpperWithSharedA", "TestPsNmaddLowerWithSharedB",
    "TestPsNmaddUpperWithSharedB", "TestPsNmaddLowerWithSharedC", "TestPsNmaddUpperWithSharedC"].map((n) => [n, madd(MONE)]),
  ...["TestFnmaddWithSharedABC", "TestPsNmaddLowerWithSharedABC", "TestPsNmaddUpperWithSharedABC"].map((n) => [n, SHARED_ABC])
];

const snanBytes = SINGLE_SNANS.flatMap((w) => [w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]);

export function cases() {
  const byName = new Map(TESTS.map((t) => [t.name, t]));
  const out = [];
  for (const [name, table] of RUNS) {
    const test = byName.get(name);
    const program = [...assemble(test), BLR];
    table.forEach((row, k) => {
      const values = Object.fromEntries(test.params.slice(0, -1).map((p, i) => [p, row[i]]));
      const expected = row[row.length - 1];
      const fpr = {};
      for (const [p, v] of Object.entries(values)) fpr[REG[p]] = v;
      for (const [dst, from] of test.init) fpr[REG[dst]] = values[from];
      let check;
      if (name === "TestPsSum0" || name === "TestPsSum1") {
        const other = widened(SINGLE_SNANS[name === "TestPsSum0" ? 5 : 4]);
        const [e0, e1] = name === "TestPsSum0" ? [expected, other] : [other, expected];
        check = (s) => ({ got: `${hex64(read.ps0(s, 1))} ${hex64(read.ps0(s, 6))}`, expected: `${hex64(e0)} ${hex64(e1)}` });
      } else {
        check = (s) => ({ got: hex64(read.ps0(s, 1)), expected: hex64(expected) });
      }
      out.push({
        id: `nan/${name.slice(4)} #${k}`,
        program,
        state: makeState({ gpr: { 3: SCRATCH }, fpr, mem: snanBytes, gqr: [0] }),
        check
      });
    });
  }
  return out;
}

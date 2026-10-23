#define DOLPHIN_WEB_FAST_BRANCH_INLINE
#define DOLPHIN_WEB_DIRECT_WASM_BLOCK_INLINE
#define DOLPHIN_WEB_HOT_COUNT(...) ((void)0)
u32 s_wasm_block_run_count = 0;
std::function<int(s32, PowerPC::PowerPCState&)> wasm_call;
int NativeWasmInvoke(s32 handle, PowerPC::PowerPCState& state) { return wasm_call(handle, state); }

class BaselineInterpreter : public CachedInterpreterEmitter
{
public:
  struct FastInstructionOperands; struct FastBranchBdnzOperands; struct CheckHaltOperands; struct WasmBlockOperands;
  template<bool> struct EndBlockOperands;
  static s32 FastBranch(PowerPC::PowerPCState&, const FastInstructionOperands&);
  static s32 FastBranchBdnz(PowerPC::PowerPCState&, const FastBranchBdnzOperands&);
  static s32 CheckFPU(PowerPC::PowerPCState&, const CheckHaltOperands&);
  static s32 RunWasmBlock(PowerPC::PowerPCState&, const WasmBlockOperands&);
  template<bool P> static s32 EndBlock(PowerPC::PowerPCState&, const EndBlockOperands<P>&);
  using CachedInterpreterEmitter::AnyCallback;
};
/* BASELINE_OPERANDS */
/* BASELINE_METHODS */
/* CANDIDATE_METHODS */
/* WASM_DISASSEMBLY */

void CachedInterpreter::EmitWasmForTest(bool did_merge, bool compiled_entire_block,
    bool compiled_block_ends_with_branch, bool write_npc, u32 block_next_pc, const std::vector<CodeOp>& ops)
{
  const s32 handle = 1;
  const u32 eff_downcount = 7, eff_loadstores = 3, eff_fpinst = 2;
/* WASM_EMISSION */
}

void compare_branch(u32 instruction, u32 pc, u32 lr, u32 ctr, bool condition, bool linked)
{
  Fixture f;
  PowerPC::PowerPCState baseline, candidate;
  baseline.lr = candidate.lr = lr; baseline.ctr = candidate.ctr = ctr;
  baseline.cr.bits.fill(condition); candidate.cr.bits.fill(condition);
  PowerPC::PowerPCManager old_manager{&baseline}, new_manager{&candidate};
  BaselineInterpreter::FastInstructionOperands old_branch{old_manager, pc, UGeckoInstruction(instruction)};
  CachedInterpreter::FastInstructionOperands new_branch{new_manager, pc, UGeckoInstruction(instruction)};
  BaselineInterpreter::EndBlockOperands<false> old_end{7, 3, 2};
  auto descriptor = L::Branch(instruction, pc);
  const u8 code[8]{};
  if (linked) for (u32 i = 0; i < descriptor.count; ++i) L::WriteEntry(&descriptor.cells[i], code);
  CachedInterpreter::EndBlockOperands<false> new_end{7, 3, 2, descriptor};
  const auto epoch = f.cache.StaticLinkEpoch(); L::Scope scope(&f.cache, &candidate, epoch, 2);
  BaselineInterpreter::FastBranch(baseline, old_branch); CachedInterpreter::FastBranch(candidate, new_branch);
  BaselineInterpreter::EndBlock<false>(baseline, old_end); CachedInterpreter::EndBlock<false>(candidate, new_end);
  require(baseline == candidate, "linked/fallback candidate changed PPC branch or accounting state");
  const auto result = scope.Resolve(&f.cache, &candidate, epoch, 2, candidate.pc);
  bool has_target = false; for (u32 i = 0; i < descriptor.count; ++i) has_target |= descriptor.cells[i].pc == candidate.pc;
  require(result.entry == (linked && has_target ? code : nullptr), "completed branch selects only final-PC matching cell");
}

int main()
{
  group("differential direct b/bl signed absolute wrapping self and inline continuation", [] {
    for (bool linked : {false, true}) for (bool aa : {false, true}) for (bool lk : {false, true})
      for (u32 pc : {0x1000u, 0xfffffffcu}) for (s32 displacement : {-16, 0, 4, 64})
        compare_branch((18u << 26) | (u32(displacement) & 0x03fffffcu) | (unsigned(aa) << 1) | lk, pc, 0x3003, 5, false, linked);
  });
  group("differential bc/bcl covers every BO taken/fallthrough CTR CR and LR effect", [] {
    for (bool linked : {false, true}) for (unsigned bo = 0; bo < 32; ++bo) for (bool condition : {false, true})
      for (u32 ctr : {0u, 1u, 2u}) for (bool lk : {false, true}) for (bool aa : {false, true})
        compare_branch((16u << 26) | (bo << 21) | 0xfff0u | (unsigned(aa) << 1) | lk, 0x1000, 0x3003, ctr, condition, linked);
  });
  group("differential LR/CTR branches preserve dynamic taken destinations and conditional fallthrough", [] {
    for (bool linked : {false, true}) for (unsigned bo = 0; bo < 32; ++bo) for (bool condition : {false, true})
      for (u32 ctr : {0u, 1u, 2u, 0x3003u}) for (unsigned xo : {16u, 528u}) for (bool lk : {false, true}) {
        if (xo == 528 && !(bo & 4)) continue;
        compare_branch((19u << 26) | (bo << 21) | (xo << 1) | lk, 0x1000, 0x3003, ctr, condition, linked);
      }
  });
  group("early FPU rejection at eligible PC cannot publish an exit", [] {
    Fixture f; auto descriptor = L::Fallthrough(0x2000); const u8 code[8]{}; L::WriteEntry(&descriptor.cells[0], code);
    PowerPC::PowerPCState baseline, candidate; baseline.msr.FP = candidate.msr.FP = false;
    PowerPC::PowerPCManager old_manager{&baseline}, new_manager{&candidate};
    BaselineInterpreter::CheckHaltOperands old_op{old_manager, 0x1000, 7};
    CachedInterpreter::CheckHaltOperands new_op{new_manager, 0x1000, 7};
    const auto epoch = f.cache.StaticLinkEpoch(); L::Scope scope(&f.cache, &candidate, epoch, 2);
    require(BaselineInterpreter::CheckFPU(baseline, old_op) == 0 && CachedInterpreter::CheckFPU(candidate, new_op) == 0, "FPU early stop");
    require(baseline == candidate && candidate.pc == 0x2000, "FPU exception accounting preserved");
    require(scope.Resolve(&f.cache, &candidate, epoch, 2, candidate.pc).decision == L::Decision::NoCompletion, "coincidentally matching PC must not make early FPU halt linkable");
  });
  group("actual RunWasmBlock normal halt and prefix preserve state and publication", [] {
    for (bool halted : {false, true}) for (bool ending : {false, true}) for (bool linked : {false, true}) {
      Fixture f; PowerPC::PowerPCState baseline, candidate; const u8 code[8]{};
      auto descriptor = L::Fallthrough(0x2000); if (linked) L::WriteEntry(&descriptor.cells[0], code);
      BaselineInterpreter::WasmBlockOperands old_op{1, 0x2000, 7, 3, 2, ending};
      CachedInterpreter::WasmBlockOperands new_op{1, 0x2000, 7, 3, 2, ending, descriptor};
      wasm_call = [halted](s32 handle, PowerPC::PowerPCState& state) { require(handle == 1, "native ABI adapter handle"); state.pc = state.npc = 0x2000; state.gpr[3] = 0x1234; return halted ? 1 : 0; };
      const auto epoch = f.cache.StaticLinkEpoch(); L::Scope scope(&f.cache, &candidate, epoch, 2);
      const auto before_runs = s_wasm_block_run_count;
      const auto old_size = BaselineInterpreter::RunWasmBlock(baseline, old_op);
      const auto new_size = CachedInterpreter::RunWasmBlock(candidate, new_op);
      require(baseline == candidate && s_wasm_block_run_count == before_runs + 2, "WASM body/accounting counters preserved");
      if (halted || ending) require(old_size == 0 && new_size == 0, "ending callback distance");
      else require(old_size == sizeof(CachedInterpreter::AnyCallback) + sizeof(old_op) && new_size == sizeof(CachedInterpreter::AnyCallback) + sizeof(new_op), "prefix advances by its own actual operand layout");
      const auto result = scope.Resolve(&f.cache, &candidate, epoch, 2, candidate.pc);
      if (halted || !ending) require(result.decision == L::Decision::NoCompletion, "halt/prefix cannot publish at matching PC");
      else require(result.entry == (linked ? code : nullptr), "normal WASM termination publishes");
    }
  });
  group("fused full partial merged and skipped-tail emission registers exact actual terminal", [] {
    for (unsigned mode = 0; mode < 5; ++mode) {
      Fixture f; auto& block = f.cache.Add(0x1000, 2, f.storage.data(), f.storage.data() + 512);
      f.emitter.js.curBlock = &block; f.emitter.SetCodePtr(block.normalEntry, block.near_end);
      std::vector<CachedInterpreter::CodeOp> ops{{UGeckoInstruction((18u << 26) | 0x1000), 0x1000}};
      if (mode == 3 || mode == 4) ops.push_back({UGeckoInstruction((18u << 26) | 0x1000), 0x2000, mode == 4, true});
      f.emitter.EmitWasmForTest(mode == 3 || mode == 4, mode == 0 || mode == 1, false, mode == 1, 0x4000, ops);
      require(!f.emitter.HasWriteFailed(), "fused emitter succeeds");
      auto* op = reinterpret_cast<CachedInterpreter::WasmBlockOperands*>(block.normalEntry + sizeof(CachedInterpreter::AnyCallback));
      if (mode == 2) require(!op->end_block && op->links.count == 0 && block.linkData.empty(), "non-ending prefix owns no terminal link");
      else { const u32 expected = mode == 1 ? 0x4000 : mode == 3 ? 0x3000 : 0x2000;
        require(op->end_block && op->links.count == 1 && op->links.cells[0].pc == expected && block.linkData.size() == 1, "full/merged/explicit fallthrough selects actual emitted terminal"); }
      std::ostringstream text; const s32 distance = CachedInterpreter::RunWasmBlock(text, *op);
      require(block.normalEntry + distance == f.emitter.GetWritableCodePtr(), "WASM disassembly reaches exact emitted boundary");
      if (mode == 2) { const auto tail = f.emitter.GetWritableCodePtr(); f.emitter.WriteEndBlock(L::Fallthrough(0x4000));
        auto* end = reinterpret_cast<CachedInterpreter::EndBlockOperands<false>*>(tail + sizeof(CachedInterpreter::AnyCallback));
        require(tail + CachedInterpreter::EndBlock<false>(text, *end) == f.emitter.GetWritableCodePtr(), "mixed native tail follows prefix at actual stride");
        require(block.linkData.size() == 1 && block.linkData[0].exitPtrs == reinterpret_cast<u8*>(&end->links.cells[0]), "mixed tail owns final link, not prefix"); }
    }
  });
  group("failed fused emission never registers an incomplete operand descriptor", [] {
    for (std::size_t bytes : {0u, 1u, 8u, 16u}) {
      Fixture f; auto& block = f.cache.Add(0x1000, 2, f.storage.data(), f.storage.data() + bytes);
      f.emitter.js.curBlock = &block; f.emitter.SetCodePtr(block.normalEntry, block.near_end);
      f.emitter.EmitWasmForTest(false, true, false, true, 0x2000, {});
      require(f.emitter.HasWriteFailed() && block.linkData.empty(), "failed fused payload is unpublished");
    }
  });
  std::cout << "{\"passed\":["; for (std::size_t i = 0; i < passed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(passed[i]); }
  std::cout << "],\"failed\":["; for (std::size_t i = 0; i < failed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(failed[i]); }
  std::cout << "]}\n"; return failed.empty() ? 0 : 1;
}

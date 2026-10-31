#include <optional>
#define ASSERT(x) assert(x)
/* COUNTERS */
void reset_helper_state()
{
/* RESET_COUNTERS */
}
std::vector<u32> helper_counters() { /* SNAPSHOT_COUNTERS */ }
unsigned inline_mode = 0;
u32 GetOsInterruptTargetPc(u32) { return 0x2000; }
bool ExecuteFastOsInterruptInline(PowerPC::PowerPCState& state, PowerPC::PowerPCManager&, u32, u32 return_pc, u32, u32 cycles, u32) {
  if (inline_mode == 1) return false;
  state.pc = state.npc = inline_mode == 2 ? 0x3000 : return_pc;
  state.gpr[3] = 0x55; state.downcount -= cycles; return true;
}
/* ORIGINAL_HELPERS */
/* CANDIDATE_HELPERS */

int main()
{
  group("actual terminal callbacks tolerate direct invocation without execution context", [] {
    require(L::active_context == nullptr, "no context before direct callbacks");
    PowerPC::PowerPCState state; state.npc = 0x2000;
    CachedInterpreter::EndBlockOperands<false> end{7, 3, 2, L::Fallthrough(0x2000)};
    require(CachedInterpreter::EndBlock<false>(state, end) == 0, "direct native normal terminal");
    wasm_call = [](s32, PowerPC::PowerPCState& ppc) { ppc.npc = 0x2000; return 0; };
    CachedInterpreter::WasmBlockOperands wasm{1, 0x2000, 7, 3, 2, 1, L::Fallthrough(0x2000)};
    require(CachedInterpreter::RunWasmBlock(state, wasm) == 0, "direct WASM normal terminal");
    require(L::active_context == nullptr, "direct callbacks must not create or retain context");
  });
  group("actual inline call branch preserves LR accounting and selects callee or completed continuation", [] {
    for (unsigned mode = 0; mode < 3; ++mode) for (bool linked : {false, true}) {
      Fixture f; PowerPC::PowerPCState baseline, candidate; PowerPC::PowerPCManager old_manager{&baseline}, new_manager{&candidate};
      BaselineInterpreter::OsInterruptFunctionOperands old_op{old_manager, 0x1000, 0, 3, 2};
      CachedInterpreter::OsInterruptFunctionOperands new_op{new_manager, 0x1000, 0, 3, 2};
      BaselineInterpreter::EndBlockOperands<false> old_end{7, 3, 2};
      auto descriptor = L::Branch((18u << 26) | 0x1001, 0x1000); const u8 code[8]{};
      if (linked) for (auto& cell : descriptor.cells) L::WriteEntry(&cell, code);
      CachedInterpreter::EndBlockOperands<false> new_end{7, 3, 2, descriptor};
      inline_mode = mode; reset_helper_state();
      const auto old_size = BaselineInterpreter::FastOsInterruptCallBranch(baseline, old_op);
      BaselineInterpreter::EndBlock<false>(baseline, old_end); const auto old_counts = helper_counters();
      reset_helper_state(); const auto epoch = f.cache.StaticLinkEpoch(); L::Scope scope(&f.cache, &candidate, epoch, 2);
      const auto new_size = CachedInterpreter::FastOsInterruptCallBranch(candidate, new_op);
      require(scope.Resolve(&f.cache, &candidate, epoch, 2, candidate.pc).decision == L::Decision::NoCompletion, "inline branch alone is not the block terminal");
      CachedInterpreter::EndBlock<false>(candidate, new_end);
      require(old_size == sizeof(CachedInterpreter::AnyCallback) + sizeof(old_op) && new_size == sizeof(CachedInterpreter::AnyCallback) + sizeof(new_op), "call helper preserves following callback stride");
      require(baseline == candidate && old_counts == helper_counters() && candidate.lr == 0x1004, "inline helper/call/fallback changes PPC or accounting state");
      const auto result = scope.Resolve(&f.cache, &candidate, epoch, 2, candidate.pc);
      require(result.entry == (linked && mode != 2 ? code : nullptr), "only actual callee/continuation PCs select a cell; unexpected exception PC falls back");
    }
  });
  std::cout << "{\"passed\":["; for (std::size_t i = 0; i < passed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(passed[i]); }
  std::cout << "],\"failed\":["; for (std::size_t i = 0; i < failed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(failed[i]); }
  std::cout << "]}\n"; return failed.empty() ? 0 : 1;
}

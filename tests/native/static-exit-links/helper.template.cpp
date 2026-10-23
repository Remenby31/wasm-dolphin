#include <cmath>
#include <optional>
#define ASSERT(x) assert(x)
constexpr u32 EXCEPTION_EXTERNAL_INT = 2, EXCEPTION_PERFORMANCE_MONITOR = 4, EXCEPTION_DECREMENTER = 8;
/* CONSTANTS */
/* COUNTERS */
struct Settings { bool verified = true, fail_status = false, fail_second = false; u32 status = 0, reads = 0; } settings;
namespace Core {
struct System {
  struct Memory { std::array<u8, 2048> ram{}; u8* GetRAM() { return ram.data(); } u32 GetRamSizeReal() { return ram.size(); } } memory;
  Memory& GetMemory() { return memory; }
  static System& GetInstance() { static System system; return system; }
};
}
void reset_helper_state()
{
/* RESET_COUNTERS */
  s_fast_melee_service_poll_cycles = s_fast_melee_input_poll_cycles = 2;
  s_fast_melee_service_poll_loadstores = s_fast_melee_input_poll_loadstores = 1;
  settings.reads = 0;
  auto& ram = Core::System::GetInstance().memory.ram;
  for (std::size_t i = 0; i < ram.size(); i += 4) { ram[i] = 0x3f; ram[i + 1] = 0x80; ram[i + 2] = ram[i + 3] = 0; }
}
std::vector<u32> helper_counters() { /* SNAPSHOT_COUNTERS */ }
bool IsOsInterruptModeVerified(u32) { return settings.verified; }
bool VerifyMeleeServicePollFunction() { return settings.verified; }
bool VerifyMeleeInputPollNoChangeFunction() { return settings.verified; }
std::optional<u32> TryReadFastMeleeStatusResult(PowerPC::PowerPCState&) { ++settings.reads; return settings.fail_status || (settings.fail_second && settings.reads > 1) ? std::nullopt : std::optional<u32>(5); }
u32 MapFastMeleeStatusDispatchResult(u32 value) { return value; }
bool TryReadFastMeleeSiPollWords(u32* a, u32* b) { *a = *b = 0; return true; }
bool TryReadFastMeleeInputPollNoChangeWords(u32* a, u32* b, u32* c, u32* d) { *a = *b = *c = *d = 1; return true; }
bool TryReadFastMeleeInputStatusByte(PowerPC::PowerPCState&, u32* result) { *result = settings.status; return true; }
void FastUpdateCR0(PowerPC::PowerPCState& state, u32 value) { state.cr.bits[2] = value == 0; }
u32 SaturatingAddU32(u32 a, u32 b) { return a > UINT32_MAX - b ? UINT32_MAX : a + b; }
bool TryFastAlignedRamOffset(PowerPC::PowerPCState&, u8* ram, u32 size, u32 address, u32 bytes, u32* offset) {
  if (!ram || address % bytes || address > size || bytes > size - address) return false;
  *offset = address; return true;
}
u32 ReadRamU32BE(const u8* ram, u32 offset) { return u32(ram[offset]) << 24 | u32(ram[offset + 1]) << 16 | u32(ram[offset + 2]) << 8 | ram[offset + 3]; }
u64 ReadRamU64BE(const u8* ram, u32 offset) { return (u64(ReadRamU32BE(ram, offset)) << 32) | ReadRamU32BE(ram, offset + 4); }
void WriteRamU32BE(u8* ram, u32 offset, u32 value) { for (u32 i = 0; i < 4; ++i) ram[offset + i] = value >> ((3 - i) * 8); }
double LoadFastSingleFromRam(const u8* ram, u32 offset) { return std::bit_cast<float>(ReadRamU32BE(ram, offset)); }
void StoreFastSingleToRam(u8* ram, u32 offset, double value) { WriteRamU32BE(ram, offset, std::bit_cast<u32>(float(value))); }
void SetFastCompareField(PowerPC::PowerPCState& state, unsigned field, s32 a, s32 b) { state.cr.bits[field * 4] = a < b; state.cr.bits[field * 4 + 1] = a > b; state.cr.bits[field * 4 + 2] = a == b; }
double FastSingleMAdd(PowerPC::PowerPCState&, double a, double b, double c) { return float(a * b + c); }
double FastSingleNMSub(PowerPC::PowerPCState&, double a, double b, double c) { return float(-(a * b - c)); }
double FastSingleAdd(PowerPC::PowerPCState&, double a, double b) { return float(a + b); }
double FastSingleSub(PowerPC::PowerPCState&, double a, double b) { return float(a - b); }
double FastSingleMul(PowerPC::PowerPCState&, double a, double b) { return float(a * b); }
u64 FastFctiwzResult(PowerPC::PowerPCState&, double value) { if (!std::isfinite(value) || value < INT32_MIN || value > INT32_MAX) return u64(INT32_MIN); return u32(s32(value)); }
unsigned inline_mode = 0;
u32 GetOsInterruptTargetPc(u32) { return 0x2000; }
bool ExecuteFastOsInterruptInline(PowerPC::PowerPCState& state, PowerPC::PowerPCManager&, u32, u32 return_pc, u32, u32 cycles, u32) {
  if (inline_mode == 1) return false;
  state.pc = state.npc = inline_mode == 2 ? 0x3000 : return_pc;
  state.gpr[3] = 0x55; state.downcount -= cycles; return true;
}
/* ORIGINAL_HELPERS */
/* CANDIDATE_HELPERS */
/* DISASSEMBLY */
void CachedInterpreter::EmitIdleForTest(PowerPC::PowerPCManager& power_pc, u32 cycles, u32 loadstores)
{
/* IDLE_EMISSION */
}
void CachedInterpreter::EmitTitleForTest(PowerPC::PowerPCManager& power_pc, u32 cycles, u32 loadstores, u32 fp_inst)
{
/* TITLE_EMISSION */
}

int main()
{
  group("actual terminal callbacks tolerate direct invocation without execution context", [] {
    require(L::active_context == nullptr, "no context before direct callbacks");
    PowerPC::PowerPCState state; PowerPC::PowerPCManager manager{&state}; state.npc = 0x2000;
    CachedInterpreter::EndBlockOperands<false> end{7, 3, 2, L::Fallthrough(0x2000)};
    require(CachedInterpreter::EndBlock<false>(state, end) == 0, "direct native normal terminal");
    wasm_call = [](s32, PowerPC::PowerPCState& ppc) { ppc.npc = 0x2000; return 0; };
    CachedInterpreter::WasmBlockOperands wasm{1, 0x2000, 7, 3, 2, 1, L::Fallthrough(0x2000)};
    require(CachedInterpreter::RunWasmBlock(state, wasm) == 0, "direct WASM normal terminal");
    settings = {}; settings.status = 1; reset_helper_state(); state.downcount = 40;
    CachedInterpreter::MeleeIdlePollLoopOperands idle{manager, MELEE_IDLE_POLL_LOOP_PC, MELEE_IDLE_POLL_LOOP_END_PC, 4, 2, {}};
    require(CachedInterpreter::FastMeleeIdlePollLoop(state, idle) == 0, "direct idle normal terminal");
    reset_helper_state(); state = {}; state.ctr = 1; state.gpr[1] = 0x100;
    CachedInterpreter::MeleeTitleLoopOperands title{manager, 0x8035ca24, 0x8035cb3c, 8, 4, 3, {}};
    require(CachedInterpreter::FastMeleeTitleLoop(state, title) == 0, "direct title normal terminal");
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
  group("actual idle helper normal loop exit partial-work and fallback match baseline", [] {
    for (unsigned mode = 0; mode < 7; ++mode) for (bool linked : {false, true}) {
      Fixture f; PowerPC::PowerPCState baseline, candidate; baseline.downcount = candidate.downcount = mode == 6 ? 0 : 40;
      PowerPC::PowerPCManager old_manager{&baseline}, new_manager{&candidate};
      const auto descriptor = [] { auto d = L::Fallthrough(MELEE_IDLE_POLL_LOOP_PC); L::Add(d, MELEE_IDLE_POLL_LOOP_END_PC); return d; }();
      BaselineInterpreter::MeleeIdlePollLoopOperands old_op{old_manager, MELEE_IDLE_POLL_LOOP_PC, MELEE_IDLE_POLL_LOOP_END_PC, 4, 2};
      auto& source = f.cache.Add(MELEE_IDLE_POLL_LOOP_PC, 2, f.storage.data(), f.storage.data() + 512);
      f.emitter.js.curBlock = &source; f.emitter.SetCodePtr(source.normalEntry, source.near_end); f.emitter.EmitIdleForTest(new_manager, 4, 2);
      auto& new_op = *reinterpret_cast<CachedInterpreter::MeleeIdlePollLoopOperands*>(source.normalEntry + sizeof(CachedInterpreter::AnyCallback));
      require(new_op.links.count == descriptor.count && source.linkData.size() == 2, "actual idle emitter registers both exits");
      const u8 code[8]{}; if (linked) for (auto& cell : new_op.links.cells) L::WriteEntry(&cell, code);
      if (mode == 2) baseline.msr.LE = candidate.msr.LE = true;
      if (mode == 3) baseline.Exceptions = candidate.Exceptions = EXCEPTION_EXTERNAL_INT;
      settings = {}; settings.status = mode == 1 ? 1 : 0; settings.fail_status = mode == 4; settings.fail_second = mode == 5;
      reset_helper_state(); const auto old_size = BaselineInterpreter::FastMeleeIdlePollLoop(baseline, old_op); const auto old_counts = helper_counters();
      reset_helper_state(); const auto epoch = f.cache.StaticLinkEpoch(); L::Scope scope(&f.cache, &candidate, epoch, 2);
      const auto new_size = CachedInterpreter::FastMeleeIdlePollLoop(candidate, new_op);
      require(baseline == candidate && old_counts == helper_counters(), "idle callback state/accounting differs");
      const auto result = scope.Resolve(&f.cache, &candidate, epoch, 2, candidate.pc);
      if (mode == 2 || mode == 3 || mode == 4) {
        require(old_size == sizeof(CachedInterpreter::AnyCallback) + sizeof(old_op) && new_size == sizeof(CachedInterpreter::AnyCallback) + sizeof(new_op), "idle fallback stride");
        require(result.decision == L::Decision::NoCompletion, "idle fallback must not publish");
      } else { require(old_size == 0 && new_size == 0, "idle normal completion"); require(result.entry == (linked ? code : nullptr), "idle normal completion selects known loop/exit PC"); }
      std::ostringstream text; require(source.normalEntry + CachedInterpreter::FastMeleeIdlePollLoop(text, new_op) == f.emitter.GetWritableCodePtr(), "idle disassembly exact boundary");
    }
  });
  group("actual title helper loop exit downcount and rejection preserve state RAM accounting", [] {
    for (unsigned mode = 0; mode < 7; ++mode) for (bool linked : {false, true}) {
      Fixture f; PowerPC::PowerPCState baseline, candidate;
      baseline.ctr = candidate.ctr = mode == 2 ? 0 : mode == 0 ? 1 : 3;
      baseline.downcount = candidate.downcount = mode == 6 ? 0 : 12;
      baseline.gpr[1] = candidate.gpr[1] = 0x100;
      if (mode == 3) baseline.msr.FP = candidate.msr.FP = false;
      if (mode == 4) baseline.fpscr.VE = candidate.fpscr.VE = 1;
      if (mode == 5) baseline.gpr[7] = candidate.gpr[7] = 0xfffffffc;
      PowerPC::PowerPCManager old_manager{&baseline}, new_manager{&candidate};
      BaselineInterpreter::MeleeTitleLoopOperands old_op{old_manager, 0x8035ca24, 0x8035cb3c, 8, 4, 3};
      auto& source = f.cache.Add(0x8035ca24, 2, f.storage.data(), f.storage.data() + 512);
      f.emitter.js.curBlock = &source; f.emitter.SetCodePtr(source.normalEntry, source.near_end); f.emitter.EmitTitleForTest(new_manager, 8, 4, 3);
      auto& new_op = *reinterpret_cast<CachedInterpreter::MeleeTitleLoopOperands*>(source.normalEntry + sizeof(CachedInterpreter::AnyCallback));
      require(new_op.links.count == 2 && source.linkData.size() == 2, "actual title emitter registers loop and normal exit");
      const u8 code[8]{}; if (linked) for (auto& cell : new_op.links.cells) L::WriteEntry(&cell, code);
      reset_helper_state(); const auto old_size = BaselineInterpreter::FastMeleeTitleLoop(baseline, old_op);
      const auto old_counts = helper_counters(); const auto old_ram = Core::System::GetInstance().memory.ram;
      reset_helper_state(); const auto epoch = f.cache.StaticLinkEpoch(); L::Scope scope(&f.cache, &candidate, epoch, 2);
      const auto new_size = CachedInterpreter::FastMeleeTitleLoop(candidate, new_op);
      require(baseline == candidate && old_counts == helper_counters() && old_ram == Core::System::GetInstance().memory.ram, "title state/RAM/accounting differs");
      const auto result = scope.Resolve(&f.cache, &candidate, epoch, 2, candidate.pc);
      if (mode >= 2 && mode <= 5) {
        require(old_size == sizeof(CachedInterpreter::AnyCallback) + sizeof(old_op) && new_size == sizeof(CachedInterpreter::AnyCallback) + sizeof(new_op), "title fallback stride");
        require(result.decision == L::Decision::NoCompletion, "title fallback must not publish");
      } else { require(old_size == 0 && new_size == 0, "title normal completion"); require(result.entry == (linked ? code : nullptr), "title normal completion selects loop/exit PC"); }
      std::ostringstream text; require(source.normalEntry + CachedInterpreter::FastMeleeTitleLoop(text, new_op) == f.emitter.GetWritableCodePtr(), "title disassembly exact boundary");
    }
  });
  group("failed specialized helper emission publishes no link records", [] {
    for (bool title : {false, true}) for (std::size_t bytes : {0u, 1u, 8u, 16u}) {
      Fixture f; PowerPC::PowerPCState state; PowerPC::PowerPCManager manager{&state};
      auto& source = f.cache.Add(0x1000, 2, f.storage.data(), f.storage.data() + bytes);
      f.emitter.js.curBlock = &source; f.emitter.SetCodePtr(source.normalEntry, source.near_end);
      if (title) f.emitter.EmitTitleForTest(manager, 8, 4, 3); else f.emitter.EmitIdleForTest(manager, 4, 2);
      require(f.emitter.HasWriteFailed() && source.linkData.empty(), "incomplete helper payload cannot publish cells");
    }
  });
  std::cout << "{\"passed\":["; for (std::size_t i = 0; i < passed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(passed[i]); }
  std::cout << "],\"failed\":["; for (std::size_t i = 0; i < failed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(failed[i]); }
  std::cout << "]}\n"; return failed.empty() ? 0 : 1;
}

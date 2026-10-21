#define NOMINMAX
#include "test-platform.h"
#include <atomic>
#include <chrono>
#include <unordered_map>
// P4 regions (0075): none installed in these groups.
std::atomic<bool> s_regions_enabled{false};
std::unordered_map<u32, u32> s_region_at;
template <class State> bool TryRunRegion(State&) { return false; }
template <class State> bool RegionWouldRun(const State&) { return false; }
bool s_sampling_lookups = false;
u32 s_sampled_lookups = 0;
double s_sampled_lookup_ms = 0, s_clock_pair_ms = 0;
struct { u32 sample_every = 0; } s_region_stats;
template <class Cache> const u8* TimedDispatch(Cache& cache) { return cache.Dispatch(); }
bool helper_disabled = false, s_ppc_block_profile_enabled = false;
u32 helper_checks = 0, s_ppc_profile_total_blocks = 0, profile_records = 0;
constexpr u32 DOLPHIN_WEB_DISABLE_BLOCK_REDISPATCH = 1, PPC_PROFILE_SAMPLE_MASK = 1023;
bool DolphinWebHelperDisabled(u32) { ++helper_checks; return helper_disabled; }
void ApplyArmedWasmPolicy() {}
void ApplyRequestedWasmPolicy(CachedInterpreter&) {}
const L::Context* expected_context_at_profile = nullptr;
void RecordPpcBlockProfile(u32, u32) { require(L::active_context == expected_context_at_profile, "source context must close before profiler hook"); ++profile_records; }
u32 ElapsedMicros(std::chrono::steady_clock::time_point, std::chrono::steady_clock::time_point) { return 1; }
#define __EMSCRIPTEN__ 1
/* EXECUTION */
#undef __EMSCRIPTEN__

struct GateFixture : Fixture
{
  JitBlock *source = nullptr, *target = nullptr;
  explicit GateFixture(bool resolve = true, bool wasm = false) {
    helper_disabled = s_ppc_block_profile_enabled = false; helper_checks = profile_records = s_ppc_profile_total_blocks = 0;
    perf_callback = {}; expected_context_at_profile = nullptr; SConfig::GetInstance().bJITNoBlockLinking = false;
    emitter.js.downcountAmount = 100; target = &emit(0x2000, 2, 512);
    emitter.js.downcountAmount = 7;
    if (wasm) {
      source = &cache.Add(0x1000, 2, storage.data(), storage.data() + 256);
      emitter.js.curBlock = source; emitter.SetCodePtr(source->normalEntry, source->near_end);
      emitter.EmitWasmForTest(false, true, false, true, 0x2000, {}); source->near_end = emitter.GetWritableCodePtr();
      if (resolve) cache.FinalizeLinkRegistration(*source);
    } else {
      source = &cache.Add(0x1000, 2, storage.data(), storage.data() + 256);
      emitter.js.curBlock = source; emitter.SetCodePtr(source->normalEntry, source->near_end);
      emitter.WriteEndBlock(L::Fallthrough(0x2000)); source->near_end = emitter.GetWritableCodePtr();
      if (resolve) cache.FinalizeLinkRegistration(*source);
    }
    emitter.m_ppc_state.pc = 0x1000; emitter.m_ppc_state.npc = 0x2000;
    cache.dispatch_for_test = [&] {
      auto* found = cache.GetBlockFromStartAddress(emitter.m_ppc_state.pc, emitter.m_ppc_state.feature_flags);
      return found ? found->normalEntry : nullptr;
    };
    wasm_call = [](s32, PowerPC::PowerPCState& state) { state.npc = 0x2000; return 0; };
  }
  ~GateFixture() { perf_callback = {}; }
};

int main()
{
  group("consecutive early FPU and WASM halts cannot reuse the preceding completed descriptor", [] {
    for (bool wasm : {false, true}) for (bool direct : {false, true}) {
      GateFixture f;
      f.cache.EraseSingleBlock(*f.target);
      f.target = &f.cache.Add(0x2000, 2, f.storage.data() + 512, f.storage.data() + 768);
      f.emitter.js.curBlock = f.target; f.emitter.SetCodePtr(f.target->normalEntry, f.target->near_end);
      PowerPC::PowerPCManager manager{&f.emitter.m_ppc_state};
      if (wasm) f.emitter.EmitWasmForTest(false, true, false, true, 0x2000, {});
      else {
        f.emitter.Write(CachedInterpreter::CheckFPU, CachedInterpreter::CheckHaltOperands{manager, 0x2000, 30});
        f.emitter.WriteEndBlock(L::Fallthrough(0x2000));
        f.emitter.m_ppc_state.msr.FP = false;
      }
      f.target->near_end = f.emitter.GetWritableCodePtr(); f.cache.FinalizeLinkRegistration(*f.target);
      f.emitter.m_ppc_state.downcount = 70; f.emitter.native_direct_wasm = direct;
      unsigned halted_calls = 0;
      wasm_call = [&](s32, PowerPC::PowerPCState& state) { ++halted_calls; state.pc = state.npc = 0x2000; state.downcount -= 30; return 1; };
      f.emitter.ExecuteOneBlock();
      require(f.emitter.m_ppc_state.downcount == -27 && f.emitter.m_ppc_state.effects.size() == 1,
              "three early returns preserve completed guest work and omit terminal accounting");
      require(f.cache.dispatch_calls == 3, "each redispatch after no-publisher block must fall back instead of borrowing old link");
      if (wasm) require(halted_calls == 3, "bounded repeated WASM halt case");
      require(L::active_context == nullptr, "consecutive halt path closes outer scope");
    }
  });
  group("each chained BeginBlock captures fresh epoch and feature key with stable TLS identity", [] {
    for (unsigned mode = 0; mode < 3; ++mode) {
      Fixture f; helper_disabled = s_ppc_block_profile_enabled = false; perf_callback = {};
      const u32 later_features = mode != 1 ? 4 : 2;
      f.emitter.js.downcountAmount = 100; f.emit(0x3000, later_features, 1024);
      f.emitter.js.downcountAmount = 7;
      f.emit(0x2000, later_features, 512, L::Fallthrough(0x3000));
      f.emit(0x1000, 2, 0, L::Fallthrough(0x2000));
      auto& unrelated = f.emit(0x4000, 2, 1536);
      auto& state = f.emitter.m_ppc_state; state.pc = 0x1000; state.npc = 0x2000;
      f.cache.dispatch_for_test = [&] { auto* b = f.cache.GetBlockFromStartAddress(state.pc, state.feature_flags); return b ? b->normalEntry : nullptr; };
      const L::Context* installed = nullptr; unsigned calls = 0;
      perf_callback = [&] {
        auto* context = L::active_context;
        require(context && context->owner == &f.cache && context->state == &state,
                "every block retains current cache/PPC owner identity");
        require(context->completed == nullptr, "completion must be cleared before each actual callback begins");
        if (!installed) installed = context; else require(installed == context, "successful chaining retains a single installed TLS scope");
        require(context->epoch == f.cache.StaticLinkEpoch() && context->features == state.feature_flags,
                "new block must capture current epoch and complete feature key");
        if (++calls == 1) {
          state.feature_flags = later_features; state.npc = 0x3000;
          if (mode != 0) f.cache.EraseSingleBlock(unrelated);
        }
      };
      f.emitter.ExecuteOneBlock(); perf_callback = {};
      require(calls == 3 && f.cache.dispatch_calls == 2, "source mismatch falls back once, then fresh target context links onward");
      require(state.pc == 0x3000 && state.downcount == -14 && L::active_context == nullptr,
              "three-block accounting and final closure");
    }
  });
  group("nested lean execution restores parent TLS before child miss or profiler callbacks", [] {
    for (bool miss : {false, true}) {
      GateFixture outer, child;
      if (miss) child.cache.EraseSingleBlock(*child.target);
      bool entered_child = false; const L::Context* parent = nullptr;
      perf_callback = [&] {
        if (L::active_context && L::active_context->state == &child.emitter.m_ppc_state) {
          require(L::active_context->owner == &child.cache && L::active_context != parent, "child context owns child cache/state");
          return;
        }
        if (entered_child) return;
        entered_child = true; parent = L::active_context;
        require(parent && parent->owner == &outer.cache, "outer owner installed");
        child.emitter.expected_context_at_jit = parent;
        expected_context_at_profile = parent;
        if (!miss) { s_ppc_block_profile_enabled = true; s_ppc_profile_total_blocks = PPC_PROFILE_SAMPLE_MASK; }
        child.emitter.ExecuteOneBlock();
        s_ppc_block_profile_enabled = false; expected_context_at_profile = nullptr;
        require(L::active_context == parent && parent->owner == &outer.cache,
                "nested return restores parent's active identity");
      };
      outer.emitter.ExecuteOneBlock(); perf_callback = {};
      require(entered_child && outer.cache.dispatch_calls == 1 && outer.emitter.m_ppc_state.downcount == -7,
              "child completion cannot replace parent's successful descriptor");
      require(child.emitter.jit_calls == (miss ? 1u : 0u), "nested miss behavior");
      if (!miss) require(profile_records == 1, "child profiler ran after closing child scope");
      require(L::active_context == nullptr, "outer closes after nested work");
    }
  });
  group("callback unwind closes lean scope and cannot leak completion into later execution", [] {
    GateFixture f; bool threw = false;
    perf_callback = [] { throw std::runtime_error("callback unwind fixture"); };
    try { f.emitter.ExecuteOneBlock(); } catch (const std::runtime_error& e) { threw = std::string(e.what()) == "callback unwind fixture"; }
    perf_callback = {};
    require(threw && L::active_context == nullptr, "unwind restores TLS via scope destructor");
    f.emitter.m_ppc_state = {}; f.emitter.m_ppc_state.pc = 0x1000; f.emitter.m_ppc_state.npc = 0x2000;
    f.cache.dispatch_calls = 0; f.emitter.ExecuteOneBlock();
    require(f.cache.dispatch_calls == 1 && f.emitter.m_ppc_state.downcount == -7 && L::active_context == nullptr,
            "fresh execution works after an abandoned scope");
  });
  group("actual outer loop uses linked next entry without changing PPC accounting", [] {
    PowerPC::PowerPCState reference;
    for (bool resolve : {false, true}) {
      GateFixture f(resolve); f.emitter.ExecuteOneBlock();
      require(f.cache.dispatch_calls == (resolve ? 1u : 2u), "link changes only the post-block Dispatch lookup");
      require(f.emitter.m_ppc_state.pc == 0x2000 && f.emitter.m_ppc_state.downcount == -7, "both original accounting callbacks executed");
      require(f.emitter.jit_calls == 0 && L::active_context == nullptr, "normal completion closes context");
      if (!resolve) reference = f.emitter.m_ppc_state; else require(reference == f.emitter.m_ppc_state, "linked and fallback PPC state differ");
    }
  });
  group("actual SingleStep preserves timing advance and never redispatches", [] {
    GateFixture f; f.emitter.SingleStep();
    require(f.emitter.m_system.timing.advances == 1 && f.cache.dispatch_calls == 1, "SingleStep advance/dispatch contract");
    require(f.emitter.m_ppc_state.downcount == 93 && f.emitter.m_ppc_state.effects.size() == 1, "SingleStep executes exactly one block");
    require(helper_checks == 0, "allow=false short circuits helper policy check");
  });
  group("original disabled profiler downcount and CPU-state gates retain short circuit", [] {
    void* protected_state = TestProtectedPage();
    require(protected_state != nullptr, "protected CPU-state page");
    for (unsigned mode = 0; mode < 6; ++mode) {
      GateFixture f;
      if (mode < 4) f.emitter.m_system.cpu.pointer = static_cast<const CPU::State*>(protected_state);
      if (mode == 1) helper_disabled = true;
      if (mode == 2) { s_ppc_block_profile_enabled = true; s_ppc_profile_total_blocks = PPC_PROFILE_SAMPLE_MASK; }
      if (mode == 3) f.emitter.m_ppc_state.downcount = 7;
      if (mode == 4) f.emitter.m_system.cpu.state = CPU::State::Stepping;
      if (mode == 5) f.emitter.m_system.cpu.state = CPU::State::PowerDown;
      f.emitter.ExecuteOneBlock(mode != 0);
      require(f.cache.dispatch_calls == 1 && f.emitter.m_ppc_state.effects.size() == 1, "disabled/stopped gate chained a second block");
      require(helper_checks == (mode ? 1u : 0u), "policy short-circuit call count");
      if (mode == 2) require(profile_records == 1, "profiler still records original one-block sample");
      require(L::active_context == nullptr, "non-redispatch exit restores context");
    }
    require(TestFreeProtectedPage(protected_state) != 0, "release protected page");
  });
  group("debug branchwatch profiling and no-link settings retain ordinary fallback", [] {
    for (unsigned mode = 0; mode < 4; ++mode) {
      GateFixture f;
      f.emitter.debug = mode == 0; f.emitter.branchwatch = mode == 1; f.emitter.profiling = mode == 2;
      SConfig::GetInstance().bJITNoBlockLinking = mode == 3;
      f.emitter.ExecuteOneBlock();
      require(f.cache.dispatch_calls == 2 && f.emitter.m_ppc_state.downcount == -7, "conservative link gate changes lookup only");
    }
  });
  group("actual miss path closes source scope before Jit", [] {
    GateFixture f; f.cache.EraseSingleBlock(*f.target); f.emitter.ExecuteOneBlock();
    require(f.emitter.jit_calls == 1 && f.emitter.jit_pc == 0x2000 && f.cache.dispatch_calls == 2, "uncached successor keeps original compile/miss path");
    require(L::active_context == nullptr, "miss leaves no context");
  });
  group("source and target invalidation during actual terminal accounting cannot consume stale cells", [] {
    for (bool source : {false, true}) {
      GateFixture f; bool once = false;
      perf_callback = [&] {
        if (once) return; once = true;
        if (source) {
          int nested_state = 0;
          { L::Scope nested(&f.cache, &nested_state, f.cache.StaticLinkEpoch(), 2);
            f.cache.EraseSingleBlock(*f.source);
            f.emitter.js.downcountAmount = 7; f.source = &f.emit(0x1000, 2, 0, L::Fallthrough(0x2000));
            L::Publish(&nested_state, &f.descriptor(*f.source)); }
        } else f.cache.EraseSingleBlock(*f.target);
      };
      f.emitter.ExecuteOneBlock();
      require(f.cache.dispatch_calls == 2, "destroy epoch must force ordinary lookup");
      require(f.emitter.jit_calls == (source ? 0u : 1u), "valid replacement target versus erased target");
      require(L::active_context == nullptr, "invalidation path restores context");
    }
  });
  group("actual callback loop stops at early FPU failure without borrowing later terminal", [] {
    GateFixture f(false); auto& state = f.emitter.m_ppc_state; state.msr.FP = false;
    PowerPC::PowerPCManager manager{&state}; f.source->linkData.clear();
    f.emitter.js.curBlock = f.source; f.emitter.SetCodePtr(f.source->normalEntry, f.storage.data() + 256);
    f.emitter.Write(CachedInterpreter::CheckFPU, CachedInterpreter::CheckHaltOperands{manager, 0x1000, 7});
    f.emitter.WriteEndBlock(L::Fallthrough(0x2000)); f.source->near_end = f.emitter.GetWritableCodePtr();
    f.cache.FinalizeLinkRegistration(*f.source); f.emitter.ExecuteOneBlock();
    require(state.pc == 0x2000 && state.downcount == -7 && state.effects.size() == 1, "early FPU path preserves original execution/accounting");
    require(f.cache.dispatch_calls == 2, "coincidentally matching exception PC requires ordinary dispatch");
    require(L::active_context == nullptr, "FPU early path closes context");
  });
  group("generic and direct-WASM callback dispatch both publish only normal terminal completion", [] {
    for (bool direct : {false, true}) for (bool halted : {false, true}) {
      GateFixture f(true, true); f.emitter.native_direct_wasm = direct;
      wasm_call = [halted](s32, PowerPC::PowerPCState& state) { state.pc = state.npc = 0x2000; return halted ? 1 : 0; };
      f.emitter.ExecuteOneBlock();
      require(f.cache.dispatch_calls == (halted ? 2u : 1u), "WASM halt must not produce a linked hit at matching PC");
      require(f.emitter.m_ppc_state.downcount == (halted ? 0 : -7), "WASM halted/normal accounting retained");
      require(L::active_context == nullptr, "direct/generic loop closes context");
    }
  });
  std::cout << "{\"passed\":["; for (std::size_t i = 0; i < passed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(passed[i]); }
  std::cout << "],\"failed\":["; for (std::size_t i = 0; i < failed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(failed[i]); }
  std::cout << "]}\n"; return failed.empty() ? 0 : 1;
}

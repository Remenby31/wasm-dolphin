#include <optional>
#define ASSERT(x) assert(x)

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
  std::cout << "{\"passed\":["; for (std::size_t i = 0; i < passed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(passed[i]); }
  std::cout << "],\"failed\":["; for (std::size_t i = 0; i < failed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(failed[i]); }
  std::cout << "]}\n"; return failed.empty() ? 0 : 1;
}

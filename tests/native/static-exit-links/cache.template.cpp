#include <atomic>
#include <algorithm>
#include <array>
#include <bit>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <unordered_map>
#include <vector>
#include "CachedInterpreterLink.h"
#include "WasmDeferredCompileQueue.h"

using u8 = std::uint8_t; using u32 = std::uint32_t; using u64 = std::uint64_t; using s32 = std::int32_t;
using CPUEmuFeatureFlags = u32;
constexpr u32 FEATURE_FLAG_MSR_IR = 1;
#define DEBUG_ASSERT(x) assert(x)
namespace L = StaticExitLinks;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
namespace PowerPC { struct PowerPCState { u32 pc = 0, npc = 0; s32 downcount = 100; std::vector<std::string> effects; }; }
namespace fmt { template<class... T> void println(std::ostream& stream, const char*, const T&...) { stream << "record\n"; } }
void UpdatePerformanceMonitorIfNeeded(u32 cycles, u32 loads, u32 fp, PowerPC::PowerPCState& state)
{ state.effects.push_back("perf:" + std::to_string(cycles) + ':' + std::to_string(loads) + ':' + std::to_string(fp)); }

struct JitBlock
{
  struct ProfileData { unsigned ends = 0, cycles = 0; static void EndProfiling(ProfileData* p, u32 c) { ++p->ends; p->cycles += c; } };
/* LINK_DATA */
  u8 *normalEntry = nullptr, *near_begin = nullptr, *near_end = nullptr;
  CPUEmuFeatureFlags feature_flags = 0;
  u32 effectiveAddress = 0, physicalAddress = 0;
  std::size_t fast_block_map_index = 0;
  std::vector<LinkData> linkData;
  std::vector<std::pair<u32, u32>> physical_addresses;
  std::unique_ptr<ProfileData> profile_data;
  explicit JitBlock(bool profiling) : profile_data(profiling ? std::make_unique<ProfileData>() : nullptr) {}
  bool OverlapsPhysicalRange(u32 address, u32 length) const {
    for (auto [from, to] : physical_addresses) if (from < address + length && address < to) return true;
    return false;
  }
};
struct JitBase
{
  struct { std::set<u32> fifoWriteAddresses, pairedQuantizeAddresses, noSpeculativeConstantsAddresses; } js;
  struct { struct Translation { bool valid; u32 address; }; Translation JitCache_TranslateAddress(u32 address) { return {true, address}; } } m_mmu;
};
class JitBaseBlockCache
{
public:
  explicit JitBaseBlockCache(JitBase& jit) : m_jit(jit) {}
  virtual ~JitBaseBlockCache() = default;
  virtual void Init() {}
  void Clear();
  JitBlock* GetBlockFromStartAddress(u32 address, CPUEmuFeatureFlags features);
  void LinkBlockExits(JitBlock& block); void LinkBlock(JitBlock& block); void UnlinkBlock(const JitBlock& block);
  virtual void DestroyBlock(JitBlock& block);
  void EraseSingleBlock(const JitBlock& block); void ErasePhysicalRange(u32 address, u32 length);
  virtual void WriteLinkBlock(const JitBlock::LinkData&, const JitBlock*) = 0;
  virtual void WriteDestroyBlock(const JitBlock&) = 0;
  JitBlock& Add(u32 pc, u32 features, u8* begin, u8* end, bool profile = false) {
    auto it = block_map.emplace(std::piecewise_construct, std::forward_as_tuple(pc), std::forward_as_tuple(profile));
    auto& block = it->second; block.effectiveAddress = block.physicalAddress = pc; block.feature_flags = features;
    block.normalEntry = block.near_begin = begin; block.near_end = end; block.physical_addresses = {{pc, pc + 4}};
    block_range_map[pc & BLOCK_RANGE_MAP_MASK].insert(&block); return block;
  }
  void FinalizeLinkRegistration(JitBlock& block, bool block_link = true) {
/* REGISTER_LINKS */
  }
  std::size_t Count() const { return block_map.size(); }
  std::size_t Incoming(u32 pc) const { auto i = links_to.find(pc); return i == links_to.end() ? 0 : i->second.size(); }
protected:
  static constexpr u32 BLOCK_RANGE_SIZE = 0x100, BLOCK_RANGE_MAP_MASK = ~(BLOCK_RANGE_SIZE - 1);
  JitBase& m_jit;
  std::multimap<u32, JitBlock> block_map;
  std::map<u32, std::set<JitBlock*>> links_to, block_range_map;
  u8** m_entry_points_ptr = nullptr;
  std::array<JitBlock*, 8> m_fast_block_map_fallback{};
  struct { void ClearAll() {} } valid_block;
  struct { void Clear() {} } m_entry_points_arena;
};

/* EMITTER_CLASS */
/* EMITTER_WRITE */
s32 CachedInterpreterEmitter::PoisonCallback(PowerPC::PowerPCState&, const void*) { throw std::runtime_error("poisoned callback executed"); }
/* CACHE_CLASS */
/* BASE_METHODS */
/* CACHE_METHODS */

struct SConfig { bool bJITNoBlockLinking = false; static SConfig& GetInstance() { static SConfig c; return c; } };
class CachedInterpreter : public CachedInterpreterEmitter
{
public:
  explicit CachedInterpreter(CachedInterpreterBlockCache& cache) : m_block_cache(cache) {}
  CachedInterpreterBlockCache& m_block_cache;
  JitBaseBlockCache* GetBlockCache() { return &m_block_cache; }
  void ClearCache(); void FreeRanges(); void ResetFreeMemoryRanges();
  struct Ranges { std::vector<std::pair<u8*, u8*>> ranges; void clear() { ranges.clear(); } void insert(u8* from, u8* to) { ranges.emplace_back(from, to); } } m_free_ranges;
  u8* region = nullptr; std::size_t region_size = 0;
  void ClearCodeSpace() { if (region) std::memset(region, 0, region_size); SetCodePtr(region, region + region_size); }
  void RefreshConfig() {}
  template<bool> struct EndBlockOperands;
  template<bool P> static s32 EndBlock(PowerPC::PowerPCState&, const EndBlockOperands<P>&);
  template<bool P> static s32 EndBlock(std::ostream&, const EndBlockOperands<P>&);
  bool debug = false, branchwatch = false, profiling = false;
  bool IsDebuggingEnabled() const { return debug; } bool IsBranchWatchEnabled() const { return branchwatch; }
  bool IsProfilingEnabled() const { return profiling; }
  bool StaticExitLinksEnabled() const;
  void RegisterStaticExitLinks(L::Descriptor* links);
  void WriteEndBlock(L::Descriptor links = {});
  struct { JitBlock* curBlock = nullptr; u32 downcountAmount = 7, numLoadStoreInst = 3, numFloatingPointInst = 2; } js;
  using CachedInterpreterEmitter::AnyCallback;
};
/* END_OPERANDS */
bool s_wasm_jit_enabled = true;
std::unordered_map<CachedInterpreter*, DeferredJit::Queue> s_deferred_wasm_queues;
constexpr unsigned COMPILE_THROTTLE_MAX_PER_SLICE = 8;
// Off-thread compiles (patch 0074): not exercised by these groups.
std::atomic<bool> s_wasm_off_thread_compile{false};
static void RetryOffThreadWasmBlocks(CachedInterpreter&) {}
static void ResetOffThreadCompiles() {}
static void UnverifyAllRegions() {}
static void ForgetAllRegions() {}
void Host_JitCacheInvalidation() {}
#define __EMSCRIPTEN__ 1
/* INTERPRETER_METHODS */
/* DEFERRED_RETRY */
#undef __EMSCRIPTEN__
/* DISASSEMBLY_METHODS */

class JitInterface
{
public:
  struct Handle { JitBaseBlockCache* cache; JitBaseBlockCache* GetBlockCache() { return cache; } };
  Handle* m_jit = nullptr; void ClearSafe();
};
/* CLEAR_SAFE */

struct Fixture
{
  JitBase jit; CachedInterpreterBlockCache cache{jit}; CachedInterpreter emitter{cache};
  alignas(16) std::array<u8, 4096> storage{};
  Fixture() { emitter.region = storage.data(); emitter.region_size = storage.size(); }
  JitBlock& emit(u32 pc, u32 features, std::size_t offset, L::Descriptor links = {}, bool profile = false) {
    auto& block = cache.Add(pc, features, storage.data() + offset, storage.data() + offset + 256, profile);
    emitter.js.curBlock = &block; emitter.profiling = profile;
    emitter.SetCodePtr(block.normalEntry, block.near_end); emitter.WriteEndBlock(links);
    require(!emitter.HasWriteFailed(), "fixture emitter overflow"); block.near_end = emitter.GetWritableCodePtr();
    cache.FinalizeLinkRegistration(block, emitter.StaticExitLinksEnabled()); return block;
  }
  L::Descriptor& descriptor(JitBlock& b) { return reinterpret_cast<CachedInterpreter::EndBlockOperands<false>*>(b.normalEntry + sizeof(CachedInterpreter::AnyCallback))->links; }
};
std::vector<std::string> passed, failed;
void group(const char* name, const std::function<void()>& test) { try { SConfig::GetInstance().bJITNoBlockLinking = false; test(); passed.emplace_back(name); }
  catch (const std::exception& e) { failed.push_back(std::string(name) + ": " + e.what()); } }

int main()
{
  group("cache epoch is nonzero and advances at initialization", [] {
    Fixture f; const auto before = f.cache.StaticLinkEpoch(); require(before != 0, "fresh cache epoch cannot be zero");
    f.cache.Init(); require(f.cache.StaticLinkEpoch() > before, "Init advances lifetime epoch");
  });
  group("actual base linking supports both compilation orders and feature variants", [] {
    for (bool target_first : {false, true}) {
      Fixture f; JitBlock* source = nullptr; JitBlock* target = nullptr;
      auto emit_source = [&] { source = &f.emit(0x1000, 2, 0, L::Fallthrough(0x2000)); };
      auto emit_target = [&] { target = &f.emit(0x2000, 2, 512); };
      if (target_first) { emit_target(); emit_source(); } else { emit_source(); require(!f.descriptor(*source).cells[0].entry, "uncompiled target unresolved"); emit_target(); }
      require(f.descriptor(*source).cells[0].entry == target->normalEntry && source->linkData[0].linkStatus, "actual base registry links matching feature target");
      auto& alternate = f.emit(0x3000, 4, 1024, L::Fallthrough(0x2000));
      require(!f.descriptor(alternate).cells[0].entry, "target with different feature key cannot link");
      auto& alternate_target = f.emit(0x2000, 4, 1536);
      require(f.descriptor(alternate).cells[0].entry == alternate_target.normalEntry, "later matching variant linked");
      require(f.descriptor(*source).cells[0].entry == target->normalEntry, "existing variant unaffected");
    }
  });
  group("actual emitter registers stable deduplicated cells and honors policy", [] {
    Fixture f; auto d = L::Branch((18u << 26) | 5u, 0x1000);
    auto& source = f.emit(0x1000, 2, 0, d);
    require(source.linkData.size() == 1 && source.linkData[0].call, "deduplicated call/continuation registered once");
    require(source.linkData[0].exitPtrs == reinterpret_cast<u8*>(&f.descriptor(source).cells[0]), "registered pointer belongs to emitted callback storage");
    L::Add(d, 0x7777); require(f.descriptor(source).count == 1, "emission copies temporary descriptor");
    for (unsigned gate = 0; gate < 4; ++gate) {
      f.emitter.debug = gate == 0; f.emitter.branchwatch = gate == 1; SConfig::GetInstance().bJITNoBlockLinking = gate == 2;
      auto& disabled = f.emit(0x3000 + gate * 4, 2, 512 + gate * 512, L::Fallthrough(0x2000), gate == 3);
      require(disabled.linkData.empty(), "debug/branchwatch/no-link/profiling prohibits registration");
    }
  });
  group("actual target erase clears incoming cells and relinks same PC/address replacement", [] {
    Fixture f; auto& source = f.emit(0x1000, 2, 0, L::Fallthrough(0x2000)); auto& target = f.emit(0x2000, 2, 512);
    auto* entry = target.normalEntry; const auto epoch = f.cache.StaticLinkEpoch();
    f.cache.EraseSingleBlock(target);
    require(!f.descriptor(source).cells[0].entry && !source.linkData[0].linkStatus, "real UnlinkBlock clears incoming cell/status");
    require(f.cache.StaticLinkEpoch() > epoch && !f.cache.GetRangesToFree().empty(), "erase advances epoch before deferred reclamation");
    auto& replacement = f.emit(0x2000, 2, 512);
    require(replacement.normalEntry == entry && f.descriptor(source).cells[0].entry == entry, "replacement safely reuses identical callback address");
  });
  group("actual source erase rejects saved descriptor before same-storage reuse", [] {
    Fixture f; auto& source = f.emit(0x1000, 2, 0, L::Fallthrough(0x2000)); f.emit(0x2000, 2, 512);
    int state = 0; L::Scope scope(&f.cache, &state, f.cache.StaticLinkEpoch(), 2); L::Publish(&state, &f.descriptor(source));
    f.cache.EraseSingleBlock(source); f.emit(0x1000, 2, 0, L::Fallthrough(0x2000));
    require(scope.Resolve(&f.cache, &state, f.cache.StaticLinkEpoch(), 2, 0x2000).decision == L::Decision::EpochMismatch, "old context cannot read recompiled source descriptor");
    require(f.cache.Incoming(0x2000) == 1, "destroy removes old source registry entry before replacement");
  });
  group("ClearSafe uses actual base Clear virtual destroy and unlinks all cells", [] {
    Fixture f; auto& source = f.emit(0x1000, 2, 0, L::Fallthrough(0x2000)); f.emit(0x2000, 2, 512);
    auto* cell = &f.descriptor(source).cells[0]; const auto epoch = f.cache.StaticLinkEpoch();
    JitInterface::Handle handle{&f.cache}; JitInterface interface; interface.m_jit = &handle; interface.ClearSafe();
    require(f.cache.Count() == 0 && !cell->entry, "base clear clears blocks and incoming/outgoing cells");
    require(f.cache.StaticLinkEpoch() >= epoch + 2, "virtual destruction advances lifetime for every cleared block");
    require(f.cache.GetRangesToFree().size() == 2, "callback ranges retained until reclamation");
  });
  group("actual physical invalidation removes overlapping sources and targets", [] {
    Fixture f; auto& source = f.emit(0x1000, 2, 0, L::Fallthrough(0x2000)); f.emit(0x2000, 2, 512);
    f.cache.ErasePhysicalRange(0x2000, 4);
    require(f.cache.Count() == 1 && !f.descriptor(source).cells[0].entry, "physical target invalidation unlinks incoming cell");
    f.cache.ErasePhysicalRange(0x1000, 4); require(f.cache.Count() == 0 && f.cache.Incoming(0x2000) == 0, "physical source invalidation removes registry");
  });
  group("failed emitter write does not register pointers into incomplete storage", [] {
    for (bool profiled : {false, true}) for (std::size_t capacity : {0u, 1u, 8u, 16u}) {
      Fixture f; auto& block = f.cache.Add(0x1000, 2, f.storage.data(), f.storage.data() + capacity, profiled);
      f.emitter.profiling = profiled; f.emitter.js.curBlock = &block; f.emitter.SetCodePtr(block.normalEntry, block.near_end);
      f.emitter.WriteEndBlock(L::Fallthrough(0x2000));
      require(f.emitter.HasWriteFailed() && block.linkData.empty(), "failed/tiny record remains unpublished");
    }
  });
  group("actual full ClearCache invalidates empty storage and clears deferred pending state", [] {
    Fixture f; int state = 0; auto d = L::Fallthrough(0x2000);
    const auto epoch = f.cache.StaticLinkEpoch(); L::Scope context(&f.cache, &state, epoch, 2); L::Publish(&state, &d);
    s_deferred_wasm_queues[&f.emitter].Defer(0x2000, 2, f.storage.data());
    f.emitter.ClearCache();
    require(f.cache.StaticLinkEpoch() >= epoch + 2, "full clear/reset must advance even with zero live blocks");
    require(!s_deferred_wasm_queues.contains(&f.emitter) && f.cache.GetRangesToFree().empty(), "full clear purges deferred queue/ranges");
    require(context.Resolve(&f.cache, &state, f.cache.StaticLinkEpoch(), 2, 0x2000).decision == L::Decision::EpochMismatch, "full storage reset invalidates source context");
  });
  group("0065 actual deferred replacement reaches base erase unlink before reclamation", [] {
    Fixture f; auto& source = f.emit(0x1000, 2, 0, L::Fallthrough(0x2000)); auto& target = f.emit(0x2000, 2, 512);
    const auto epoch = f.cache.StaticLinkEpoch(); auto* old = target.normalEntry;
    s_deferred_wasm_queues[&f.emitter].Defer(0x2000, 2, old);
    RetryDeferredWasmBlocks(f.emitter);
    require(!f.descriptor(source).cells[0].entry && !source.linkData[0].linkStatus, "deferred retry uses real base unlink");
    require(f.cache.StaticLinkEpoch() > epoch && !f.cache.GetRangesToFree().empty(), "deferred erase records epoch/range before free");
    f.emitter.FreeRanges(); require(f.cache.GetRangesToFree().empty(), "actual FreeRanges consumes retirement ranges");
    auto& replacement = f.emit(0x2000, 2, 512);
    require(replacement.normalEntry == old && f.descriptor(source).cells[0].entry == old, "replacement can relink the same address");
    s_deferred_wasm_queues[&f.emitter].Defer(0x2000, 2, old + 8); // Stale queued identity.
    RetryDeferredWasmBlocks(f.emitter);
    require(f.cache.GetBlockFromStartAddress(0x2000, 2) == &replacement, "stale deferred identity must not erase replacement");
  });
  group("both actual EndBlock record variants preserve accounting and disassembly sizes", [] {
    for (bool profile : {false, true}) {
      Fixture f; auto& block = f.emit(0x1000, 2, 0, L::Fallthrough(0x2000), profile);
      PowerPC::PowerPCState state; state.npc = 0x2000; const auto epoch = f.cache.StaticLinkEpoch();
      L::Scope scope(&f.cache, &state, epoch, 2, !profile); std::ostringstream text; s32 bytes;
      if (profile) { auto& op = *reinterpret_cast<const CachedInterpreter::EndBlockOperands<true>*>(block.normalEntry + sizeof(CachedInterpreter::AnyCallback));
        require(CachedInterpreter::EndBlock<true>(state, op) == 0, "profiled terminal return"); bytes = CachedInterpreter::EndBlock<true>(text, op);
        require(block.profile_data->ends == 1 && block.profile_data->cycles == 7, "profile accounting preserved"); }
      else { auto& op = *reinterpret_cast<const CachedInterpreter::EndBlockOperands<false>*>(block.normalEntry + sizeof(CachedInterpreter::AnyCallback));
        require(CachedInterpreter::EndBlock<false>(state, op) == 0, "unprofiled terminal return"); bytes = CachedInterpreter::EndBlock<false>(text, op); }
      require(state.pc == 0x2000 && state.downcount == 93 && state.effects == std::vector<std::string>{"perf:7:3:2"}, "PC/downcount/perf accounting");
      require(block.normalEntry + bytes == block.near_end, "actual disassembly advances to exact next record boundary");
      require(scope.Resolve(&f.cache, &state, epoch, 2, 0x2000).decision == (profile ? L::Decision::Disabled : L::Decision::Unlinked), "normal terminal publishes matching descriptor");
    }
  });
  std::cout << "{\"passed\":["; for (std::size_t i = 0; i < passed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(passed[i]); }
  std::cout << "],\"failed\":["; for (std::size_t i = 0; i < failed.size(); ++i) { if (i) std::cout << ','; std::cout << std::quoted(failed[i]); }
  std::cout << "]}\n"; return failed.empty() ? 0 : 1;
}

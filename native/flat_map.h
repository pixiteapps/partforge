// An open-addressing hash map for the core's hot loops, in place of
// std::unordered_map, which allocates a heap node per entry and chases a
// pointer per lookup. Linear probing over one power-of-two array of
// {key, value} slots, so a lookup touches one cache line; no erase (callers
// that "delete" store a sentinel value instead, which keeps a JS Map's
// semantics without tombstones).
//
// Keys are uint64 and ~0 marks an empty slot, so no key may be ~0: callers key
// by a uint32 (widened), or by a pair packed as i * n + j with i, j < n < 2^32,
// which stays below it.
//
// Iteration order is NOT insertion order, so nothing may iterate one of these
// where the order decides a result — the callers only find and insert.
#pragma once

#include <cstdint>
#include <vector>

namespace flat {

inline uint64_t mix(uint64_t k) {
  k ^= k >> 33; k *= 0xff51afd7ed558ccdULL;
  k ^= k >> 33; k *= 0xc4ceb9fe1a85ec53ULL;
  return k ^ (k >> 33);
}

template <class V>
class Map {
 public:
  static constexpr uint64_t EMPTY = ~0ULL;

  explicit Map(size_t expected = 16) { rehash(capFor(expected)); }

  // The value for `k`, or nullptr.
  V* find(uint64_t k) {
    for (size_t i = mix(k) & mask_;; i = (i + 1) & mask_) {
      Slot& s = slots_[i];
      if (s.key == k) return &s.val;
      if (s.key == EMPTY) return nullptr;
    }
  }
  // The value for `k`, inserting `v` first if absent; `inserted` says which.
  // The reference is valid until the next insert.
  V& insert(uint64_t k, const V& v, bool* inserted = nullptr) {
    if ((size_ + 1) * 4 > (mask_ + 1) * 3) rehash((mask_ + 1) * 2);
    for (size_t i = mix(k) & mask_;; i = (i + 1) & mask_) {
      Slot& s = slots_[i];
      if (s.key == k) { if (inserted) *inserted = false; return s.val; }
      if (s.key == EMPTY) {
        s.key = k; s.val = v; size_++;
        if (inserted) *inserted = true;
        return s.val;
      }
    }
  }
  size_t size() const { return size_; }

 private:
  struct Slot { uint64_t key; V val; };
  static size_t capFor(size_t n) { size_t c = 16; while (c * 3 < n * 4) c <<= 1; return c; }
  void rehash(size_t c) {
    std::vector<Slot> slots(c, Slot{EMPTY, V()});
    const size_t m = c - 1;
    for (const Slot& s : slots_) {
      if (s.key == EMPTY) continue;
      size_t i = mix(s.key) & m;
      while (slots[i].key != EMPTY) i = (i + 1) & m;
      slots[i] = s;
    }
    slots_.swap(slots);
    mask_ = m;
  }

  std::vector<Slot> slots_;
  size_t mask_ = 0, size_ = 0;
};

}  // namespace flat

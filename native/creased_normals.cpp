// C++ port of partforge's creasedNormals (creased-normals.js). See that file for WHY each rule exists; the comments here only
// note where the port has to work to match the JS bit for bit:
//   - storage is float32 where the JS uses Float32Array, arithmetic is double
//     everywhere the JS does arithmetic on Numbers;
//   - hypot is partforge's own (js_math.h / js-math.js), never Math.hypot;
//   - every cosine comes from the caller, never from this file's libm;
//   - iteration orders that decide a result (weld candidates, incidence lists,
//     edge pairing) follow the JS's Map insertion order.
//
// Its data structures are not the JS's, and need not be — only the order of
// anything that decides a result is:
//   - hash lookups go through flat::Map (one probe array, no allocation per
//     entry);
//   - a weld cell is a linked list through one `next` array, in insertion
//     order (the JS's array per cell);
//   - what a pass reads about a triangle (facet normal, thinness, surface,
//     policy row) sits in one 24-byte record rather than four arrays;
//   - the normals pass walks vertex by vertex, so a vertex's neighbours are
//     gathered once for all of its corners (see cn_finish);
//   - feature edges are paired by sorted per-vertex buckets instead of a hash
//     map, then judged in the JS's order (see cn_finish).
#include "creased_normals.h"
#include "blend_surfaces.h"

#include <algorithm>
#include <cmath>

#include "flat_map.h"
#include "js_math.h"
#include <cstring>
#include <vector>

namespace {

// shading-policy.js / creased-normals.js constants.
constexpr double MIN_EDGE = 0.01;
constexpr double MIN_EDGE2 = MIN_EDGE * MIN_EDGE;
constexpr double MIN_FACE = 0.04;
constexpr double SHADE_WELD = 5e-5;
constexpr double SHADE_CELL = 1e-3;
constexpr double SHADE_SLIVER = 1e-3;

inline double jsHypot(double a, double b, double c) { return jsmath::hypot3(a, b, c); }

// Math.imul(x, k) on ToInt32(x), then `^` and `| 0`.
inline int32_t imul(int32_t a, int32_t b) { return (int32_t)((uint32_t)a * (uint32_t)b); }
inline int32_t cellHash(int32_t x, int32_t y, int32_t z) {
  return imul(x, 73856093) ^ imul(y, 19349663) ^ imul(z, 83492791);
}
// ToInt32 of a Math.floor result (always integral here).
inline int32_t toInt32(double d) {
  if (!std::isfinite(d)) return 0;
  double m = std::fmod(std::trunc(d), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (int32_t)(uint32_t)m;
}

struct Policy { double creaseCos; bool boundaryLines; bool sameSurfaceLines; int32_t labelId; };

}  // namespace

struct CNState {
  // inputs (borrowed)
  const float* vp; uint32_t np, nVert;
  const uint32_t* tris; uint32_t nTri;
  uint32_t nRun = 0;
  // phase 1
  std::vector<uint32_t> remap, weld, triOID, triRun;
  std::vector<float> fn, thin;
  std::vector<uint32_t> incStart, incList;  // CSR over canonical vertex: corners t * 3 + k
  // outputs
  std::vector<float> positions, normals, edges;
  std::vector<uint16_t> featureIds;
  std::vector<int32_t> featureLabels;
};

extern "C" CNState* cn_create(const float* vp, uint32_t np, uint32_t nVert,
                              const uint32_t* tris, uint32_t nTri,
                              const uint32_t* mf, const uint32_t* mt, uint32_t nMerge,
                              const uint32_t* ri, const uint32_t* roid, uint32_t nRun) {
  // Refuse (null) a triangle naming a vertex that does not exist: the JS reads
  // undefined there and carries on, this would read out of bounds. The caller
  // runs the JS pass instead. (Run and merge tables are checked in JS.)
  for (size_t i = 0; i < (size_t)nTri * 3; i++)
    if (tris[i] >= nVert) return nullptr;
  CNState* s = new CNState();
  s->vp = vp; s->np = np; s->nVert = nVert; s->tris = tris; s->nTri = nTri; s->nRun = nRun;

  s->remap.resize(nVert);
  for (uint32_t i = 0; i < nVert; i++) s->remap[i] = i;
  for (uint32_t i = 0; i < nMerge; i++) s->remap[mf[i]] = mt[i];

  s->triOID.assign(nTri, 0);
  s->triRun.assign(nTri, 0);
  for (uint32_t r = 0; r < nRun; r++)
    for (uint32_t t = ri[r] / 3; t < ri[r + 1] / 3; t++) { s->triOID[t] = roid[r]; s->triRun[t] = r; }

  s->fn.resize((size_t)nTri * 3);
  s->thin.resize(nTri);
  for (uint32_t t = 0; t < nTri; t++) {
    const size_t a = (size_t)tris[t * 3] * np, b = (size_t)tris[t * 3 + 1] * np, c = (size_t)tris[t * 3 + 2] * np;
    const double ux = (double)vp[b] - vp[a], uy = (double)vp[b + 1] - vp[a + 1], uz = (double)vp[b + 2] - vp[a + 2];
    const double vx = (double)vp[c] - vp[a], vy = (double)vp[c + 1] - vp[a + 1], vz = (double)vp[c + 2] - vp[a + 2];
    const double wx = (double)vp[c] - vp[b], wy = (double)vp[c + 1] - vp[b + 1], wz = (double)vp[c + 2] - vp[b + 2];
    const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const double L0 = jsHypot(nx, ny, nz), L = L0 != 0 && !std::isnan(L0) ? L0 : 1;
    s->fn[t * 3] = (float)(nx / L); s->fn[t * 3 + 1] = (float)(ny / L); s->fn[t * 3 + 2] = (float)(nz / L);
    const double longest = jsmath::jsmax(ux * ux + uy * uy + uz * uz,
                                         jsmath::jsmax(vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz));
    s->thin[t] = longest > 0 ? (float)(L0 / std::sqrt(longest)) : 0.0f;
  }

  // Shading weld (hash grid, first-inserted representative wins).
  s->weld = s->remap;
  {
    const double inv = 1 / SHADE_CELL, edge = SHADE_WELD / SHADE_CELL, tol2 = SHADE_WELD * SHADE_WELD;
    // cell hash -> cell; a cell's vertices are a list through `next`, in
    // insertion order (head/tail per cell).
    constexpr uint32_t NONE = 0xffffffffu;
    flat::Map<uint32_t> cells(nVert);
    std::vector<uint32_t> head, tail, next(nVert, NONE);
    for (uint32_t i = 0; i < nVert; i++) {
      const size_t o = (size_t)i * np;
      const double x = vp[o], y = vp[o + 1], z = vp[o + 2];
      const double fx = x * inv, fy = y * inv, fz = z * inv;
      const double cxd = std::floor(fx), cyd = std::floor(fy), czd = std::floor(fz);
      const int32_t cx = toInt32(cxd), cy = toInt32(cyd), cz = toInt32(czd);
      auto offs = [&](double f, int* out) -> int {
        out[0] = 0;
        if (f < edge) { out[1] = -1; return 2; }
        if (f > 1 - edge) { out[1] = 1; return 2; }
        return 1;
      };
      int ox[2], oy[2], oz[2];
      const int nx = offs(fx - cxd, ox), ny = offs(fy - cyd, oy), nz = offs(fz - czd, oz);
      int64_t hit = -1;
      for (int a = 0; a < nx && hit < 0; a++)
        for (int b = 0; b < ny && hit < 0; b++)
          for (int c = 0; c < nz && hit < 0; c++) {
            const uint32_t* cell = cells.find((uint32_t)cellHash(cx + ox[a], cy + oy[b], cz + oz[c]));
            if (!cell) continue;
            for (uint32_t j = head[*cell]; j != NONE; j = next[j]) {
              const size_t q = (size_t)j * np;
              const double dx = vp[q] - x, dy = vp[q + 1] - y, dz = vp[q + 2] - z;
              if (dx * dx + dy * dy + dz * dz <= tol2) { hit = j; break; }
            }
          }
      if (hit >= 0) { s->weld[i] = s->weld[hit]; continue; }
      bool inserted;
      const uint32_t cell = cells.insert((uint32_t)cellHash(cx, cy, cz), (uint32_t)head.size(), &inserted);
      if (inserted) { head.push_back(i); tail.push_back(i); }
      else { next[tail[cell]] = i; tail[cell] = i; }
    }
  }

  // canonical vertex -> incident corners (t * 3 + k), in (t, k) order like
  // the JS Map.
  s->incStart.assign((size_t)nVert + 1, 0);
  for (uint32_t t = 0; t < nTri; t++)
    for (int k = 0; k < 3; k++) s->incStart[s->weld[tris[t * 3 + k]] + 1]++;
  for (uint32_t i = 0; i < nVert; i++) s->incStart[i + 1] += s->incStart[i];
  s->incList.resize((size_t)nTri * 3);
  {
    std::vector<uint32_t> fill(s->incStart.begin(), s->incStart.end() - 1);
    for (uint32_t t = 0; t < nTri; t++)
      for (int k = 0; k < 3; k++) s->incList[fill[s->weld[tris[t * 3 + k]]]++] = t * 3 + k;
  }
  return s;
}


extern "C" void cn_finish(CNState* s, const uint32_t* oids, const double* creaseCos, const uint8_t* flags,
                          const int32_t* labelIds, uint32_t numOids,
                          double coplanarCos, double analyticCos,
                          const int32_t* runDesc, const double* runXf,
                          const double* descData, const uint32_t* descOffsets, uint32_t numDesc) {
  const float* vp = s->vp; const uint32_t np = s->np, nTri = s->nTri, nVert = s->nVert;
  const uint32_t* tris = s->tris;
  const std::vector<uint32_t>& weld = s->weld;
  constexpr uint32_t NONE = 0xffffffffu;

  // Per-triangle policy. A surface missing from the table is SMOOTH, whose
  // cosine the caller supplies as the table's last row (oid ignored).
  flat::Map<uint32_t> rowOf(numOids);
  for (uint32_t i = 0; i + 1 < numOids; i++) rowOf.insert(oids[i], i);
  std::vector<Policy> pol(numOids);
  for (uint32_t i = 0; i < numOids; i++)
    pol[i] = {creaseCos[i], (flags[i] & 1) != 0, (flags[i] & 2) != 0, labelIds[i]};

  // What a pass reads about a triangle, together (the facet normal and
  // thinness exactly as the float32 arrays held them).
  struct Tri { float fn[3]; float thin; uint32_t oid; uint32_t pol; };
  std::vector<Tri> tri(nTri);
  for (uint32_t t = 0; t < nTri; t++) {
    const uint32_t* row = rowOf.find(s->triOID[t]);
    tri[t] = {{s->fn[t * 3], s->fn[t * 3 + 1], s->fn[t * 3 + 2]}, s->thin[t], s->triOID[t], row ? *row : numOids - 1};
  }

  // Per-run analytic evaluators (blend_surfaces.cpp): a run has one when its
  // surface id has a descriptor and its transform is invertible — the JS
  // `runEval[r]`. anyEval is the JS `runEval` truthiness.
  std::vector<blend::Descriptor> descs(numDesc);
  for (uint32_t i = 0; i < numDesc; i++)
    blend::parse(descData + descOffsets[i], descOffsets[i + 1] - descOffsets[i], descs[i]);
  std::vector<blend::Evaluator> evals;
  bool anyEval = false;
  if (runDesc && numDesc) {
    evals.resize(s->nRun);
    for (uint32_t r = 0; r < s->nRun; r++) {
      const int32_t di = runDesc[r];
      if (di < 0 || (uint32_t)di >= numDesc) continue;
      evals[r] = blend::makeEvaluator(&descs[di], runXf + (size_t)r * 12);
      anyEval |= evals[r].valid;
    }
  }
  // (run, vertex) -> analytic normal, evaluated on first use like the JS memo.
  struct Memo { bool ok; double n[3]; };
  flat::Map<uint32_t> memoAt(anyEval ? 1024 : 16);
  std::vector<Memo> memo;
  // analyticAt(t2, cv): the analytic normal of t2's run at vertex cv, oriented
  // with t2's facet — or false.
  auto analyticAt = [&](uint32_t t2, uint32_t cv, double out[3]) -> bool {
    const uint32_t r = s->triRun[t2];
    blend::Evaluator& ev = evals[r];
    if (!ev.valid) return false;
    bool inserted;
    const uint32_t mi = memoAt.insert((uint64_t)r * nVert + cv, (uint32_t)memo.size(), &inserted);
    if (inserted) {
      Memo m{};
      const size_t o = (size_t)cv * np;
      const double x[3] = {vp[o], vp[o + 1], vp[o + 2]};
      m.ok = blend::evaluate(ev, x, m.n);
      memo.push_back(m);
    }
    const Memo& m = memo[mi];
    if (!m.ok) return false;
    const double* n = m.n;
    const float* f = tri[t2].fn;
    const double d = n[0] * (double)f[0] + n[1] * (double)f[1] + n[2] * (double)f[2];
    if (std::fabs(d) < analyticCos) return false;
    if (d < 0) { out[0] = -n[0]; out[1] = -n[1]; out[2] = -n[2]; }
    else { out[0] = n[0]; out[1] = n[1]; out[2] = n[2]; }
    return true;
  };

  s->positions.resize((size_t)nTri * 9);
  s->normals.resize((size_t)nTri * 9);
  float* positions = s->positions.data();
  float* normals = s->normals.data();
  const uint32_t* incStart = s->incStart.data();
  const uint32_t* incList = s->incList.data();
  // Vertex by vertex: every corner at a canonical vertex reads the same
  // neighbours, so they are gathered once into `nb` (in incidence order) and
  // stay in cache for all of that vertex's corners. Each corner's normal
  // depends only on its own triangle and those neighbours, so this order gives
  // the same bits as the JS's triangle-by-triangle walk.
  std::vector<Tri> nb;
  std::vector<uint32_t> nbTri;
  for (uint32_t cv = 0; cv < nVert; cv++) {
    const uint32_t b0 = incStart[cv], d = incStart[cv + 1] - b0;
    if (!d) continue;
    nb.resize(d); nbTri.resize(d);
    for (uint32_t i = 0; i < d; i++) { nbTri[i] = incList[b0 + i] / 3; nb[i] = tri[nbTri[i]]; }
    for (uint32_t c = 0; c < d; c++) {
      const uint32_t corner = incList[b0 + c];
      const Tri& T = nb[c];
      const double fx = T.fn[0], fy = T.fn[1], fz = T.fn[2];
      const Policy& P = pol[T.pol];
      const double sharpCos = P.creaseCos;
      const uint32_t v = tris[corner];
      const size_t o = (size_t)corner * 3, vv = (size_t)v * np;
      if (anyEval && T.thin < MIN_FACE) {
        double ax = 0, ay = 0, az = 0; bool any = false;
        for (uint32_t i = 0; i < d; i++) {
          if (nb[i].thin < MIN_FACE) continue;
          double an[3];
          if (analyticAt(nbTri[i], cv, an)) { ax += an[0]; ay += an[1]; az += an[2]; any = true; }
        }
        const double L = jsHypot(ax, ay, az);
        if (any && L > 1e-9) {
          positions[o] = vp[vv]; positions[o + 1] = vp[vv + 1]; positions[o + 2] = vp[vv + 2];
          normals[o] = (float)(ax / L); normals[o + 1] = (float)(ay / L); normals[o + 2] = (float)(az / L);
          continue;
        }
      }
      double nx = 0, ny = 0, nz = 0, ax = 0, ay = 0, az = 0, sx = 0, sy = 0, sz = 0;
      bool analytic = false, solid = false;
      for (uint32_t i = 0; i < d; i++) {
        const Tri& T2 = nb[i];
        if (T2.oid != T.oid && !(pol[T2.pol].boundaryLines || P.boundaryLines)) continue;
        const double f0 = T2.fn[0], f1 = T2.fn[1], f2 = T2.fn[2];
        if (f0 * fx + f1 * fy + f2 * fz < sharpCos) continue;
        if (T2.thin < SHADE_SLIVER) { sx += f0; sy += f1; sz += f2; }
        else { nx += f0; ny += f1; nz += f2; solid = true; }
        if (anyEval) {
          double an[3];
          if (analyticAt(nbTri[i], cv, an)) { ax += an[0]; ay += an[1]; az += an[2]; analytic = true; }
        }
      }
      if (!solid) { nx = sx; ny = sy; nz = sz; }
      if (analytic && jsHypot(ax, ay, az) > 1e-9) { nx = ax; ny = ay; nz = az; }
      double L = jsHypot(nx, ny, nz);
      if (L == 0 || std::isnan(L)) L = 1;
      positions[o] = vp[vv]; positions[o + 1] = vp[vv + 1]; positions[o + 2] = vp[vv + 2];
      normals[o] = (float)(nx / L); normals[o + 1] = (float)(ny / L); normals[o + 2] = (float)(nz / L);
    }
  }

  // Feature edges. The JS walks each triangle's three edges (corner edges,
  // pos = t * 3 + e) keyed by their welded endpoints, and a Map pairs each
  // edge's sightings in order: the 2nd sighting meets the 1st, the 4th the 3rd
  // (the key is deleted on its second sighting) — and the pair is judged at
  // the second. Instead of a hash table, the same pairs come from buckets by
  // lower endpoint: each bucket's (upper endpoint, pos) entries sorted, then
  // paired in runs of equal upper endpoint. `partner[pos]` records each pair at
  // its second sighting, and the sweep below judges them in pos order — the
  // JS's order, so the same edges come out in the same order.
  s->edges.clear();
  {
    const std::vector<uint32_t>& remap = s->remap;
    const size_t nPos = (size_t)nTri * 3;
    std::vector<uint32_t> start((size_t)nVert + 1, 0);
    for (size_t pos = 0; pos < nPos; pos++) {
      const uint32_t i = remap[tris[pos]], j = remap[tris[pos - pos % 3 + (pos + 1) % 3]];
      if (i != j) start[(i < j ? i : j) + 1]++;
    }
    for (uint32_t v = 0; v < nVert; v++) start[v + 1] += start[v];
    std::vector<uint64_t> entry(start[nVert]);  // (upper endpoint << 32) | pos
    {
      std::vector<uint32_t> fill(start.begin(), start.end() - 1);
      for (size_t pos = 0; pos < nPos; pos++) {
        const uint32_t i = remap[tris[pos]], j = remap[tris[pos - pos % 3 + (pos + 1) % 3]];
        if (i == j) continue;
        const uint32_t lo = i < j ? i : j, hi = i < j ? j : i;
        entry[fill[lo]++] = ((uint64_t)hi << 32) | (uint64_t)pos;
      }
    }
    std::vector<uint32_t> partner(nPos, NONE);
    for (uint32_t v = 0; v < nVert; v++) {
      uint64_t* e = entry.data() + start[v];
      const uint32_t n = start[v + 1] - start[v];
      // Sorting the packed value orders by upper endpoint, then pos. The values
      // are distinct (pos is), so any sort gives this one order.
      if (n > 16) std::sort(e, e + n);
      else
        for (uint32_t x = 1; x < n; x++) {
          const uint64_t key = e[x];
          uint32_t y = x;
          while (y > 0 && e[y - 1] > key) { e[y] = e[y - 1]; y--; }
          e[y] = key;
        }
      for (uint32_t x = 0; x + 1 < n;) {
        if ((e[x] >> 32) == (e[x + 1] >> 32)) { partner[(uint32_t)e[x + 1]] = (uint32_t)e[x]; x += 2; }
        else x++;
      }
    }
    for (size_t pos = 0; pos < nPos; pos++) {
      if (partner[pos] == NONE) continue;
      const uint32_t t = (uint32_t)(pos / 3), prev = partner[pos] / 3;
      const uint32_t i = remap[tris[pos]], j = remap[tris[pos - pos % 3 + (pos + 1) % 3]];
      const Tri& Tp = tri[prev];
      const Tri& Tt = tri[t];
      const Policy& Pp = pol[Tp.pol];
      const Policy& Pt = pol[Tt.pol];
      const bool sameOID = Tp.oid == Tt.oid;
      const bool boundary = !sameOID && Pp.boundaryLines != Pt.boundaryLines;
      if (!boundary && (Tp.thin < MIN_FACE || Tt.thin < MIN_FACE)) continue;
      const double dot = (double)Tp.fn[0] * Tt.fn[0] + (double)Tp.fn[1] * Tt.fn[1] + (double)Tp.fn[2] * Tt.fn[2];
      const bool bends = std::fabs(dot) < coplanarCos;
      const bool bothBlend = !sameOID && Pp.boundaryLines && Pt.boundaryLines;
      const bool hard = boundary || (bends && ((sameOID || bothBlend) ? (Pt.sameSurfaceLines && dot < Pt.creaseCos) : true));
      if (!hard) continue;
      const size_t ai = (size_t)i * np, bj = (size_t)j * np;
      const double dx = (double)vp[ai] - vp[bj], dy = (double)vp[ai + 1] - vp[bj + 1], dz = (double)vp[ai + 2] - vp[bj + 2];
      if (dx * dx + dy * dy + dz * dz >= MIN_EDGE2) {
        const float seg[6] = {vp[ai], vp[ai + 1], vp[ai + 2], vp[bj], vp[bj + 1], vp[bj + 2]};
        s->edges.insert(s->edges.end(), seg, seg + 6);
      }
    }
  }

  // Feature ids: label ids numbered by first appearance, 1-based.
  s->featureIds.clear();
  s->featureLabels.clear();
  {
    flat::Map<uint16_t> indexOf;
    std::vector<uint16_t> ids(nTri, 0);
    for (uint32_t t = 0; t < nTri; t++) {
      const int32_t label = pol[tri[t].pol].labelId;
      if (label < 0) continue;
      bool inserted;
      uint16_t& fi = indexOf.insert((uint32_t)label, 0, &inserted);
      if (inserted) {
        s->featureLabels.push_back(label);
        fi = (uint16_t)s->featureLabels.size();
      }
      ids[t] = fi;
    }
    if (!s->featureLabels.empty()) s->featureIds.swap(ids);
  }
}

extern "C" const float* cn_positions(const CNState* s) { return s->positions.data(); }
extern "C" const float* cn_normals(const CNState* s) { return s->normals.data(); }
extern "C" const float* cn_edges(const CNState* s) { return s->edges.data(); }
extern "C" uint32_t cn_edge_floats(const CNState* s) { return (uint32_t)s->edges.size(); }
extern "C" const uint16_t* cn_feature_ids(const CNState* s) { return s->featureIds.empty() ? nullptr : s->featureIds.data(); }
extern "C" uint32_t cn_feature_count(const CNState* s) { return (uint32_t)s->featureLabels.size(); }
extern "C" const int32_t* cn_feature_labels(const CNState* s) { return s->featureLabels.data(); }
extern "C" void cn_destroy(CNState* s) { delete s; }

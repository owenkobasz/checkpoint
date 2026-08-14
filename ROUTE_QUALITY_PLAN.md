# Route Quality Plan — Audit & Optimizer Redesign

This document has two parts. **Part I** is a full audit of the codebase as it stands
(commit `65fab0b`, all of `src/` read end-to-end). **Part II** is a detailed plan for the
headline improvement the audit surfaces: replacing the route optimizer so it stops
producing the suboptimal orderings observed in real races — specifically the case where
the fastest riders front-loaded the ride by hitting the furthest checkpoint first and
working back, while Checkpoint recommended the opposite.

---

# Part I — Audit

## How the app works today (verified against source)

State lives in module-level variables in `src/main.ts` (`startCoords`, `finishCoords`,
`controlCoords: Map<number, Coord>`, `resolvedRoute: RoutePoint[]`), debounce-persisted
to localStorage via `src/persistence.ts`. The flow:

1. **Input** — start (GPS or geocoded address), finish, and N control inputs with
   autocomplete (`attachAutocomplete`, `main.ts:133`). Provider is Mapbox by default,
   Google behind a SHA-256 unlock (`src/unlock.ts`), Nominatim as a rate-limited fallback.
2. **Optimize** (`runOptimize`, `main.ts:552`) — geocodes anything uncached, then calls
   `nearestNeighbor(resolvedStart, resolvedControls)` (`main.ts:333`) and appends the
   finish to the result (`main.ts:621-630`). Renders the Leaflet map and a drag-sortable
   list; start and finish rows are pinned.
3. **Export** (`runExport`, `main.ts:652`) — fetches a street geometry from the public
   OSRM demo server (`src/router.ts`), builds GPX with `<wpt>` elements plus a `<trk>`,
   and downloads or hands it to the mobile share sheet.
4. **Share** — base64-encoded JSON payload in the URL hash (`src/share.ts`).

What's genuinely good: the geocoder provider abstraction is clean; autocomplete handles
abort/debounce/keyboard nav correctly; persistence is versioned and debounced; XML is
escaped; the share URL is stripped from history after import. The codebase is small and
readable.

> **Note (2026-08-14):** A5's fix has since landed in the working tree — geocoding now
> goes through the referer-restrictable Maps JS API, Google is the default provider for
> everyone, and the unlock gate (`src/unlock.ts` and its modal) is gone. Part I's
> descriptions and line numbers refer to the audited commit `65fab0b`; that change
> shifted `main.ts` numbering by −6 lines from `haversine` onward. Part II's line
> references have been updated to the current tree.

## Findings

Severity reflects impact on the app's core promise: *get a racer the best checkpoint
order, on a bike, reliably.* Every finding carries a recommended fix; the ones marked
**→ Part II** are solved in depth by the optimizer plan below.

### High

**A1 — The optimizer never looks at the finish.** `nearestNeighbor` (`main.ts:333`)
orders controls greedily from the start only; the finish is concatenated afterward at
`main.ts:629`. The final leg — often the longest in the ride — is invisible to the
optimizer. This is the primary cause of the "furthest checkpoint first" anecdote.
**Fix (→ Part II):** treat the problem as a fixed-endpoint path TSP — the finish leg
joins the objective, solved exactly by Held-Karp for ≤ 14 controls.

**A2 — Greedy nearest-neighbor with no improvement pass.** Even ignoring A1, NN is known
to produce tours 20–35% longer than optimal on typical point sets, and its signature
failure is exactly what was observed: it consumes nearby points first, strands the far
cluster, and pays for it with long backtracking legs at the end. There is no 2-opt or
any refinement pass. **Fix (→ Part II):** exact DP for the common race sizes; above the
cutoff, keep NN only as a seed and refine with 2-opt + Or-opt to a local optimum.

**A3 — Distances are straight-line, not street.** `haversine` (`main.ts:321`) ignores
rivers, bridges, one-ways, and the street grid. In Philadelphia (the app's home turf per
the placeholder text) two points 400 m apart across the Schuylkill can be a 2 km ride.
**Fix (→ Part II, phase 2):** fetch a real cycling duration matrix from the Mapbox
Matrix API (existing token, one request per optimize) and solve on that, with haversine
as the automatic offline fallback.

**A4 — The exported GPX track is car-routed, not bike-routed.** `src/router.ts:6`
requests `route/v1/cycling/...` from `router.project-osrm.org`, but the public OSRM demo
server only hosts the driving dataset — the profile segment in the URL is ignored.
Verified empirically: identical byte-for-byte responses for `cycling` and `driving`, with
implied speeds of ~42 km/h. The green line riders load onto their Wahoo can legally-for-cars
but illegally-or-badly-for-bikes route (one-way violations don't occur, but highway
ramps and bike-hostile arterials do, and bike paths are never used). It also carries no
SLA and no rate guarantee — export hard-fails when it's down (see A9).
**Fix:** switch `fetchRoute` to a router that actually serves a bike profile — the
cheapest drop-in is Mapbox Directions with `mapbox/cycling` (same token, generous free
tier, one URL change in `router.ts`); alternatives are OpenRouteService's free
`cycling-regular` (API key, 2 000 req/day) or a self-hosted OSRM with a bike profile.
Short of that, at minimum relabel the export so riders know the track is car-routed and
lean on the `<rte>` waypoints (the Wahoo re-routes between them anyway per the README).

**A5 — The Google API key ships to every visitor.** *(Resolved 2026-08-14, together
with a product change: Google is now the default provider for everyone and the unlock
gate is removed.)* `VITE_GOOGLE_MAPS_KEY` is baked into the bundle at build time
(`src/geocoder.ts`), and the key originally had *application restriction: none* because
`GoogleGeocoder.geocode` called the Geocoding **REST** endpoint, which doesn't support
HTTP-referer restrictions. The unlock modal gated the UI, not the key.
**Fix (implemented):** `geocode()` now uses the Maps **JS API** `Geocoder`
(`importLibrary('geocoding')`) instead of the REST endpoint, so every Google call goes
through the JS API and the key can be **referer-restricted** to the app's domains —
making it safe to expose and safe to hand to all users by default. Remaining manual
step: in Google Cloud Console, switch the key's application restriction to
**Websites** (`localhost:5173`, production domain) and set daily quota caps as a
billing backstop.

### Medium

**A6 — Share links break on non-Latin-1 labels.** `buildShareURL` uses
`btoa(JSON.stringify(payload))` (`src/share.ts:22`). `btoa` throws
`InvalidCharacterError` for any character above U+00FF — an é in a street name, a ñ, an
emoji in a label.
**Fix:** encode via UTF-8 bytes: `btoa(String.fromCharCode(...new TextEncoder().encode(json)))`
with the mirrored `TextDecoder` decode in `loadShareURL`. Keep accepting the old format
on decode (try UTF-8 path first, fall back to plain `atob` parse) so existing shared
links keep working.

**A7 — Stale routes are exportable.** Editing, adding, or removing controls after
Optimize does not invalidate `resolvedRoute`; the Export button stays enabled and will
happily export the old route with the map still showing it. There is no signal that the
route no longer matches the inputs.
**Fix:** add a `markRouteStale()` helper called from the control `input` listener
(`main.ts:298`), `addControl`, `removeControl`, and the start/finish input listeners.
When a route exists and inputs change: disable Export, set the status line to
`ROUTE OUT OF DATE — RE-OPTIMIZE`, and dim the route block. Populating
`RoutePoint.controlId` (A12, done in Part II) is the groundwork.

**A8 — GPX content issues.** Start/finish exported as `<wpt>` polluting the cue sheet,
no `<sym>` icons, `application/octet-stream` MIME, timestamp filenames.
**Fix:** implement `GPX_FIX_PLAN.md` as written — it is already a complete,
code-referenced plan for exactly these four defects (with `WAHOO_WAYPOINTS_PLAN.md`
covering the device-rendering path). Not re-planned here; those docs stand.

**A9 — Export has a single point of failure.** If OSRM is down, `runExport` throws and
the racer gets nothing at the start line. A `<rte>`-only GPX (ordered waypoints, no
track) is always constructible offline and is exactly what the README says the Wahoo
needs ("The Wahoo handles on-device routing between waypoints").
**Fix:** wrap the `fetchRoute` call in `runExport` (`main.ts:661`) in its own try/catch;
on failure, build a track-less GPX from `resolvedRoute` alone and export it with status
`[OK] EXPORTED WITHOUT TRACK — WAHOO WILL ROUTE`, instead of failing the whole export.

**A10 — Cancelling the share sheet reports an error.** `navigator.share` rejects with
`AbortError` when the user dismisses the sheet; `runExport` catches it and shows
`[ERR] ...` (`main.ts:665`).
**Fix:** in `runExport`'s catch, early-return on
`err instanceof DOMException && err.name === 'AbortError'` (restore the neutral status
line, no error).

**A11 — Optimize-time geocodes are never cached back.** `runOptimize` geocodes free-typed
control values (`main.ts:613`) but doesn't write results into `controlCoords`, so every
re-optimize re-geocodes everything — painful on Nominatim with its 1.1 s inter-call delay.
**Fix:** one line — `controlCoords.set(id, coord)` after each successful geocode in the
loop (and the equivalent assignments for `startCoords`/`finishCoords`), followed by
`scheduleSave()` so the cache also persists. Included in Part II's integration.

**A12 — `RoutePoint.controlId` is always `null`.** The field exists
(`persistence.ts:9`) but `runOptimize` never populates it (`main.ts:622-629`).
**Fix (→ Part II):** thread `controlEntries[i].id` through the optimizer result into
each control `RoutePoint` — the Part II integration code does this — which is the
groundwork A7's invalidation and future re-sync features need.

### Low

- **A13** — Google `suggest` returns `lat: 0, lon: 0` sentinels resolved on selection
  (`google.ts:59-63`, `main.ts:166`), and Google's `AutocompleteService` is deprecated.
  **Fix:** add an optional `needsResolve?: boolean` to `Coord` and branch on that instead
  of the magic coordinates; migrate to the `AutocompleteSuggestion` API in the same pass.
- **A14** — `shareBtn` handler rebuilds the exact snapshot `persistCurrentState` just
  built (`main.ts:766-785` vs `main.ts:32-52`).
  **Fix:** extract a `snapshotState(): PersistedState` helper used by both
  `persistCurrentState` and the share handler.
- **A15** — `user-scalable=no, maximum-scale=1.0` (`index.html:5`) blocks pinch-zoom —
  an accessibility regression whose old iOS rationale no longer applies.
  **Fix:** drop both directives, keeping `width=device-width, initial-scale=1.0`; if
  double-tap zoom on buttons ever annoys, `touch-action: manipulation` on interactive
  elements is the modern answer.
- **A16** — No tests, no lint, no CI; `node_modules` currently not installed so even
  `typecheck` can't run.
  **Fix:** `npm install`; add Vitest with the Part II solver tests as the first suite
  (§5); add a GitHub Actions workflow running `typecheck` + `test` + `build` on push —
  Vercel already handles deploy, so CI only needs to guard correctness.
- **A17** — `savedAt` is written but never read; a months-old session restores silently.
  **Fix:** on restore in `loadState`, compare `savedAt` to now; past a soft TTL
  (~14 days), still restore but surface `RESTORED SESSION FROM N DAYS AGO — CLEAR?` in
  the status bar rather than deleting data a racer might still want.
- **A18** — Version string `v0.1.0` is hardcoded in `index.html:23` while
  `package.json` also declares it.
  **Fix:** inject it at build time — set the header text from
  `import.meta.env.VITE_APP_VERSION` populated via `define` in `vite.config.ts` from
  `process.env.npm_package_version`.

---

# Part II — The Optimizer: Understanding, Expected Behavior, Implementation

## 1. Understanding the feature

### What an alleycat asks of a router

An alleycat manifest gives a racer a start, a set of controls (checkpoints) that may be
visited **in any order**, and a finish — usually a bar, usually near the start or
otherwise central. The racer's problem is: *choose the visiting order that minimizes
total ride time.* Formally this is the **path Travelling Salesman Problem with fixed
endpoints**: find the minimum-cost Hamiltonian path from `start` through all controls to
`finish`. It is *not* the "open-ended nearest walk" problem the current code solves.

Two properties of that formalization matter enormously in practice:

1. **The finish leg is part of the objective.** When the finish is near the start (the
   common case — race HQ and the bar are the same neighborhood), the optimal path is
   roughly a loop: it heads *out* to the far checkpoints early and sweeps *back* through
   the near ones, arriving at the bar with a short final leg. This is precisely the
   "front-load the furthest checkpoint" strategy the fast riders used. The current
   optimizer can never discover it because the finish isn't in its objective at all (A1).

2. **Greedy ordering strands far points.** Nearest-neighbor's known pathology: it eats
   the cheap nearby points first, leaving remote points to be collected at the end with
   long dead-head legs, and it produces crossing paths (a crossing is always removable
   by a 2-opt swap for a strict improvement — optimal paths never self-cross under a
   metric). Both defects compound A1.

A concrete, fully checkable miniature on a single straight street (positions in km
along it): start and finish both at the bar at 0; controls at +1, −2, and +5.

- **Current behavior (greedy):** 0 → +1 → −2 → +5 → 0 = 1 + 3 + 7 + 5 = **16 km**.
- **Optimal:** 0 → +5 → +1 → −2 → 0 — far checkpoint first, sweep home — =
  5 + 4 + 3 + 2 = **14 km**. Greedy rides 2 km (14%) further, and the optimal order is
  exactly the front-loaded shape the fast riders rode.

Three collinear controls is the *smallest* possible demonstration. With 8–15 controls
scattered over a 2-D street grid, greedy's crossings and stranded clusters compound,
and gaps of 20–35% over optimal are typical (the classic nearest-neighbor bound cited
in A2) — the magnitude riders actually noticed.

### Expected behavior after the change

- **Objective.** Minimize total cost of `start → σ(controls) → finish` over all
  permutations σ. Cost is straight-line km in phase 1, real cycling seconds in phase 2.
- **Optimality.** For **≤ 14 controls** the returned order is *provably optimal* for the
  given cost matrix (exact dynamic programming). Typical alleycats have 6–15 controls,
  so most races get an exact answer. Above 14, the order is near-optimal
  (nearest-neighbor seed + 2-opt + Or-opt to local optimum, empirically within a few
  percent on Euclidean instances).
- **Speed.** No perceptible latency. Exact solve at n=14 is ~3 million inner-loop
  operations — single-digit milliseconds. The heuristic path handles n=40 in well under
  50 ms. Phase 2 adds one HTTP round-trip (~200–500 ms) for the distance matrix,
  with an automatic, silent fallback to phase-1 behavior offline.
- **Determinism.** Same inputs → same route. No randomized restarts.
- **Transparency.** The route header shows total distance
  (`7 CONTROLS — 23.4 KM`), and it live-updates when the racer drags the order around,
  so a manual override is an informed decision, not a guess. When street distances were
  used the status line says so; when the app fell back to air distances it says that too.
- **What does not change.** One Optimize button. Drag-to-reorder still wins — the
  optimizer proposes, the racer disposes. `RoutePoint`/persistence schema unchanged
  (the distance shown is derived, not stored). No new npm dependencies.

### Explicitly out of scope

- Time-window or point-value controls (some alleycats score checkpoints differently) —
  a different objective; not now.
- Elevation-aware costs — Mapbox cycling durations already partially reflect this.
- Turn-by-turn navigation — the Wahoo does that.

## 2. Technical design

### 2.1 New module: `src/optimize.ts`

All solver logic in one dependency-free module. Node indexing convention throughout:
a cost matrix over `m = n + 2` nodes where **index 0 = start, 1…n = controls (in input
order), n+1 = finish**, stored as a flat `Float64Array` (`cost(i,j) = mat[i*m + j]`).

```typescript
// src/optimize.ts
import type { Coord } from './providers/types'

// The public API is two functions: optimizeOrder(mat, n) → number[] (indices into
// the input controls array, in visit order) and pathCost(mat, order, n) → total
// cost of start → ordered controls → finish under that matrix.

// 2^14 states × 14 endpoints ≈ 1.8 MB of Float64 — solves in single-digit ms.
// Above this, memory and time grow 2× per control; the heuristic takes over.
const EXACT_LIMIT = 14

export function haversineKm(a: Coord, b: Coord): number {
  const R = 6371
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

export function buildAirMatrix(nodes: Coord[]): Float64Array {
  const m = nodes.length
  const mat = new Float64Array(m * m)
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++) {
      const d = haversineKm(nodes[i], nodes[j])
      mat[i * m + j] = d
      mat[j * m + i] = d
    }
  return mat
}

export function optimizeOrder(mat: Float64Array, n: number): number[] {
  if (n <= 1) return n === 1 ? [0] : []
  if (n <= EXACT_LIMIT) return heldKarp(mat, n)

  const m = n + 2
  const cost = (a: number, b: number) => mat[a * m + b]
  const path = [0, ...nearestNeighborSeed(mat, n).map(i => i + 1), m - 1]
  refine(path, cost)
  return path.slice(1, -1).map(node => node - 1)
}

export function pathCost(mat: Float64Array, order: number[], n: number): number {
  const m = n + 2
  const path = [0, ...order.map(i => i + 1), m - 1]
  let total = 0
  for (let k = 0; k < path.length - 1; k++)
    total += mat[path[k] * m + path[k + 1]]
  return total
}
```

**Exact solver — Held-Karp for a fixed-endpoint path.** `dp[mask][j]` = cheapest cost of
starting at `start`, visiting exactly the control set `mask`, and currently standing on
control `j`. Close every full-mask state with its finish leg and take the best.

```typescript
function heldKarp(mat: Float64Array, n: number): number[] {
  const m = n + 2
  const size = 1 << n
  const dp     = new Float64Array(size * n).fill(Infinity)
  const parent = new Int16Array(size * n).fill(-1)

  for (let j = 0; j < n; j++)
    dp[(1 << j) * n + j] = mat[0 * m + (j + 1)]           // start → control j

  for (let mask = 1; mask < size; mask++)
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue
      const cur = dp[mask * n + j]
      if (cur === Infinity) continue
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue
        const nextMask = mask | (1 << k)
        const cand = cur + mat[(j + 1) * m + (k + 1)]     // control j → control k
        if (cand < dp[nextMask * n + k]) {
          dp[nextMask * n + k]     = cand
          parent[nextMask * n + k] = j
        }
      }
    }

  const full = size - 1
  let best = Infinity
  let end  = 0
  for (let j = 0; j < n; j++) {
    const cand = dp[full * n + j] + mat[(j + 1) * m + (n + 1)]  // control j → finish
    if (cand < best) { best = cand; end = j }
  }

  const order: number[] = []
  for (let mask = full, j = end; j !== -1; ) {
    order.push(j)
    const p = parent[mask * n + j]
    mask &= ~(1 << j)
    j = p
  }
  return order.reverse()
}
```

**Heuristic path for n > 14.** The current greedy is kept only as a *seed*; the quality
comes from local search over the full path *including both fixed endpoints*, which is
what un-strands far clusters:

```typescript
function nearestNeighborSeed(mat: Float64Array, n: number): number[] {
  const m = n + 2
  const remaining = new Set(Array.from({ length: n }, (_, i) => i))
  const order: number[] = []
  let at = 0                                   // node index; controls are 1…n
  while (remaining.size > 0) {
    let bestCtrl = -1
    let bestCost = Infinity
    for (const c of remaining) {
      const cand = mat[at * m + (c + 1)]
      if (cand < bestCost) { bestCost = cand; bestCtrl = c }
    }
    remaining.delete(bestCtrl)
    order.push(bestCtrl)
    at = bestCtrl + 1
  }
  return order
}

// 2-opt delta with the full reversal cost. Reversing path[i..j] flips the
// direction of EVERY edge inside the segment, not just the two boundary edges —
// so on asymmetric matrices (street durations: one-ways, turn costs) the classic
// boundary-only shortcut is wrong: it can accept a "gain" that is actually a
// loss. Summing the internal edges keeps the delta exact for any matrix at
// O(segment length) per candidate — worst case ~2M ops per pass at n=40, still
// well under 50 ms. For symmetric matrices the internal sums cancel to zero.
function twoOptDelta(
  path: number[], i: number, j: number,
  cost: (a: number, b: number) => number
): number {
  let before = cost(path[i - 1], path[i]) + cost(path[j], path[j + 1])
  let after  = cost(path[i - 1], path[j]) + cost(path[i], path[j + 1])
  for (let k = i; k < j; k++) {
    before += cost(path[k], path[k + 1])     // forward internal edges
    after  += cost(path[k + 1], path[k])     // the same edges, reversed
  }
  return after - before
}

// 2-opt (segment reversal) + Or-opt (segment relocation, lengths 1–3) to a local
// optimum. path[0] and path[path.length-1] are fixed and never moved. The
// 60-round cap is a safety bound; convergence is typically < 10 rounds.
function refine(path: number[], cost: (a: number, b: number) => number): void {
  const EPS = 1e-9
  for (let rounds = 0; rounds < 60; rounds++) {
    let improved = false

    for (let i = 1; i < path.length - 2; i++)             // 2-opt
      for (let j = i + 1; j < path.length - 1; j++) {
        if (twoOptDelta(path, i, j, cost) < -EPS) {
          for (let lo = i, hi = j; lo < hi; lo++, hi--)
            [path[lo], path[hi]] = [path[hi], path[lo]]
          improved = true
        }
      }

    for (let len = 1; len <= 3; len++)                    // Or-opt
      for (let i = 1; i + len < path.length; i++) {
        const removal =
          cost(path[i - 1], path[i + len]) -
          cost(path[i - 1], path[i]) - cost(path[i + len - 1], path[i + len])
        for (let j = 0; j < path.length - 1; j++) {
          if (j >= i - 1 && j <= i + len - 1) continue
          const insertion =
            cost(path[j], path[i]) + cost(path[i + len - 1], path[j + 1]) -
            cost(path[j], path[j + 1])
          if (removal + insertion < -EPS) {
            const seg = path.splice(i, len)
            path.splice(j < i ? j + 1 : j + 1 - len, 0, ...seg)
            improved = true
            i = 0; break                                   // indices shifted; restart row
          }
        }
      }

    if (!improved) break
  }
}
```

### 2.2 Integration into `main.ts`

Delete `haversine` and `nearestNeighbor` (`main.ts:315-350`). In `runOptimize`, replace
the ordering block (`main.ts:612-624`) and the meta line (`main.ts:631`):

```typescript
import { buildAirMatrix, optimizeOrder, haversineKm } from './optimize'

// The ONLY writer of the route meta line — called from runOptimize, onListReorder,
// and applyState. Phase 2 extends this same helper to consult displayCtx (§2.3),
// which is what keeps every display of the distance on one consistent metric.
function setRouteMeta(route: RoutePoint[]): void {
  let km = 0
  for (let i = 0; i < route.length - 1; i++)
    km += haversineKm(route[i].coord, route[i + 1].coord)
  const n = route.length - 2
  routeMeta.textContent = `${n} CONTROL${n !== 1 ? 'S' : ''} — ${km.toFixed(1)} KM`
}

// …inside runOptimize, after geocoding:
setStatus('OPTIMIZING ROUTE...', 'busy')
const nodes = [resolvedStart, ...resolvedControls, resolvedFinish]
const order = optimizeOrder(buildAirMatrix(nodes), resolvedControls.length)

resolvedRoute = [
  { coord: resolvedStart, role: 'start', label: shortLabel(resolvedStart.label), controlId: null },
  ...order.map(i => ({
    coord: resolvedControls[i],
    role: 'control' as PointRole,
    label: shortLabel(resolvedControls[i].label),
    controlId: controlEntries[i].id,          // fixes A12 while we're here
  })),
  { coord: resolvedFinish, role: 'finish', label: shortLabel(resolvedFinish.label), controlId: null },
]
setRouteMeta(resolvedRoute)
```

The three call sites: `runOptimize` as above; `onListReorder` (`main.ts:446`) calls
`setRouteMeta(resolvedRoute)` after rebuilding the array, so dragging gives live
distance feedback; `applyState` calls it when restoring a saved route, so a reload
shows the distance again instead of the bare `N CONTROLS`. `pathCost` stays a public
export of `src/optimize.ts` for the test suite even though `main.ts` doesn't import
it — in phase 1 the helper's haversine leg sum equals `pathCost` on the air matrix by
construction, so there is exactly one displayed number and one place that computes it.

One more touchpoint in the same function — **geocode caching (A11)**:
`controlCoords.set(id, coord)` after each geocode in the control loop
(`main.ts:607`), plus the equivalent assignments for start/finish.

### 2.3 Phase 2 — real cycling distances (Mapbox Matrix)

Straight-line kilometres get the *shape* of the route right but are blind to rivers and
the grid (A3). The Mapbox **Matrix API** fixes this with infrastructure the app already
has: it supports the `mapbox/cycling` profile, up to **25 coordinates** per request
(start + finish + 23 controls — comfortably above alleycat size), returns `durations`
and `distances`, and authenticates with the existing `VITE_MAPBOX_TOKEN`. One request
per optimize.

New module `src/matrix.ts`:

```typescript
import type { Coord } from './providers/types'

export interface StreetMatrix {
  seconds: Float64Array   // durations — the solver objective
  km:      Float64Array   // distances — for display
}

const cache = new Map<string, StreetMatrix>()   // avoid re-billing repeat optimizes

export async function fetchCyclingMatrix(nodes: Coord[]): Promise<StreetMatrix | null> {
  const token = import.meta.env.VITE_MAPBOX_TOKEN
  if (!token || nodes.length > 25) return null

  const key = nodes.map(p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(';')
  const hit = cache.get(key)
  if (hit) return hit

  const coords = nodes.map(p => `${p.lon},${p.lat}`).join(';')
  const url =
    `https://api.mapbox.com/directions-matrix/v1/mapbox/cycling/${coords}` +
    `?annotations=duration,distance&access_token=${token}`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    const data = await res.json() as {
      code: string
      durations: (number | null)[][]
      distances: (number | null)[][]
    }
    if (data.code !== 'Ok') return null

    const m = nodes.length
    const seconds = new Float64Array(m * m)
    const km      = new Float64Array(m * m)
    for (let i = 0; i < m; i++)
      for (let j = 0; j < m; j++) {
        const dur = data.durations[i][j]
        const dst = data.distances[i][j]
        // null = Mapbox couldn't route the pair (typically a coordinate that
        // failed to snap to the network). A sentinel value here would silently
        // distort both the solution and the displayed km, so treat the whole
        // matrix as unusable and let the caller fall back to air distances —
        // predictable and honest beats partially-street.
        if (dur === null || dst === null) return null
        seconds[i * m + j] = dur
        km[i * m + j]      = dst / 1000
      }
    const result = { seconds, km }
    cache.set(key, result)
    return result
  } catch {
    return null                                  // offline / timeout → caller falls back
  }
}
```

`runOptimize` then becomes:

```typescript
setStatus('OPTIMIZING ROUTE...', 'busy')
const nodes  = [resolvedStart, ...resolvedControls, resolvedFinish]
const street = await fetchCyclingMatrix(nodes)
const objective = street ? street.seconds : buildAirMatrix(nodes)
const order  = optimizeOrder(objective, resolvedControls.length)
displayCtx   = street ? { nodes, km: street.km, street: true } : null
// …build resolvedRoute exactly as in §2.2, then setRouteMeta(resolvedRoute) —
// the helper reads displayCtx, so it renders street km here and haversine on fallback.
// status: '[OK] ROUTE READY (STREET-ROUTED)' vs '[OK] ROUTE READY (AIR DISTANCES)'
```

Key properties: the solver is metric-agnostic — it just consumes a matrix — and every
piece is safe on **asymmetric** matrices, which street durations are (one-ways, turn
costs): Held-Karp and Or-opt use directed entries as-is and never reverse anything,
while 2-opt reverses a segment and therefore uses the full-reversal delta
(`twoOptDelta` in §2.1) rather than the symmetric boundary-edge shortcut, which is
invalid on asymmetric costs. This matters in a real reachable band: races with
**15–23 controls** are above `EXACT_LIMIT` but within the 25-coordinate matrix cap, so
they hit the heuristic solver *with* an asymmetric matrix. Failure of the fetch
degrades silently to phase-1 behavior; the 4-second timeout means a flaky start-line
connection costs at most 4 s before the offline answer appears. The cache holds at
most a handful of coordinate sets per session, so unbounded growth is not a practical
concern; clear it from the CLEAR SESSION handler for tidiness.

**Display consistency on reorder.** The optimizer's meta line and the drag-updated
meta line must use the *same* metric, or a manual reorder would be compared against an
incomparable number (street 27.3 km vs air 24.9 km reads as an improvement that isn't
real). Keep a module-level display context in `main.ts`, set by `runOptimize`:

```typescript
let displayCtx: { nodes: Coord[]; km: Float64Array; street: boolean } | null = null
```

`setRouteMeta` (§2.2) consults it: map each `RoutePoint` back to its matrix index by a
`lat.toFixed(6),lon.toFixed(6)` key over `displayCtx.nodes` (duplicate coordinates
collapse to the same node, which is fine — their legs cost the same) and sum matrix
legs; if the context is missing (route restored from localStorage after a reload, or
phase-1/fallback mode) sum haversine legs instead. Label the metric honestly:
`27.3 KM` when street distances were used, `24.9 KM (AIR)` otherwise, so a racer never
mistakes an air number for a street number. `runOptimize` sets
`displayCtx = street ? { nodes, km: street.km, street: true } : null` right after the
solve.

**Optional hardening:** an env kill switch `VITE_STREET_MATRIX=off` checked at the top
of `fetchCyclingMatrix`, for quota emergencies without a code change (add the variable
to `env.d.ts` alongside the existing keys).

### 2.4 Cost & quota (admin-facing)

Matrix billing is per **element** (sources × destinations). One optimize of n controls
costs `(n+2)²` elements: 12 controls → 196 elements. Mapbox's free tier
(100 000 elements/month) covers ~500 twelve-control optimizes; the in-memory cache means
repeat clicks on an unchanged route cost zero. Rate limit is 30 requests/min — irrelevant
at this scale.

## 3. Journeys

### Racer at the start line (happy path)

Manifest in hand, 11 controls. Types them in, taps Optimize. ~400 ms later:
`[OK] ROUTE READY (STREET-ROUTED)` and `11 CONTROLS — 27.3 KM`. The map shows an
out-and-sweep-back loop — far checkpoints early, bar-adjacent ones last. n = 11 ≤ 14, so
this order is *provably* the shortest street path for the matrix; there is no order of
these 11 controls with a lower total. Exports, races.

### Racer who knows something the map doesn't

Same route, but the racer knows the bridge on leg 4 is closed. Drags control 6 earlier.
The meta line updates live: `27.3 KM` → `29.1 KM`. They see the override costs ~2 km and
decide it's worth it. (Optional phase-3 nicety: keep the optimizer's number visible as a
baseline, e.g. `29.1 KM (OPT 27.3)`.)

### Dead zone at the start line

No signal. Matrix fetch times out at 4 s; status reads `(AIR DISTANCES)` and the meta
line shows `KM (AIR)`; the order is the exact haversine-optimal path — same behavior as
phase 1, no error, no blocking.
Export's OSRM call will still fail (A9) — which is why the audit recommends the
`<rte>`-fallback export as a companion fix.

### The mega-alleycat

30 controls. n > 14 → heuristic path (NN seed + 2-opt/Or-opt), still < 50 ms; n+2 = 32 >
25 → matrix skipped, haversine used. Everything works, just with "very good" instead of
"provably optimal", which is the right trade at that size. The in-between band matters
too: a 15–23-control race is above the exact cutoff but *within* the matrix cap, so it
runs the heuristic on an asymmetric street matrix — the case `twoOptDelta`'s
full-reversal accounting exists for.

### Organizer sharing a manifest

Organizer enters controls, taps Copy Share Link, posts it. Each racer opens it, gets the
raw controls (share deliberately excludes `resolvedRoute`), and runs their own Optimize —
now they all get the same provably-optimal baseline, and race strategy shifts to manual
overrides, which is where it should live.

### Admin (deploy & operate)

Phase 1 needs **zero** configuration changes — pure client code. Phase 2 reuses
`VITE_MAPBOX_TOKEN` (default public-token scopes include Matrix; the token's URL
restrictions already cover the app's origins). Post-deploy checklist: run one optimize,
confirm `(STREET-ROUTED)`; check the Mapbox dashboard's Matrix element count after a
race weekend; know the `VITE_STREET_MATRIX=off` + redeploy kill switch. Failure drill:
Mapbox outage → app silently degrades to air distances; nothing to page about.

## 4. Alternatives considered

### Solver

| Option | Quality | Cost/complexity | Verdict |
|---|---|---|---|
| **A. Status quo** (greedy NN, finish ignored) | Poor — the observed failures | zero | Rejected |
| **B. NN + 2-opt/Or-opt only** | Good (typically within a few % of optimal) | ~60 lines | Solid, but leaves free optimality on the table for the common case |
| **C. Held-Karp ≤ 14 + B above 14** ✅ | *Optimal* for most real races; good beyond | ~120 lines, no deps | **Chosen** — max quality per line of code; deterministic; instant |
| **D. OSRM `/trip` API** (server-side TSP, `roundtrip=false&source=first&destination=last`) | Unknown heuristic, not exact | one HTTP call | Rejected as solver: car profile only on the demo server (A4!), no SLA, offline = no optimize at all. Local search stays in our hands |
| **E. Mapbox Optimization API v1** | Good | 12-coordinate cap | Rejected — 12 coords = only 10 controls, below real race sizes |
| **F. Metaheuristics / LKH-via-WASM** | Optimal-ish at any n | heavy dep, nondeterministic | Rejected — alleycat n never justifies it |

Why 14 as the exact cutoff: memory is `2ⁿ·n` doubles (n=14 → 1.8 MB; n=18 → 37 MB) and
time doubles per extra control; 14 keeps worst case in single-digit milliseconds and
small memory on old phones, while covering effectively every real manifest.

### Cost metric

| Option | Fidelity | Dependency | Verdict |
|---|---|---|---|
| **1. Haversine** ✅ phase 1 | Shape-correct, river-blind | none — works offline | **Ship first**; permanent fallback |
| **2. Mapbox Matrix `cycling`** ✅ phase 2 | Real bike durations incl. one-ways (asymmetric) | existing token; 25-coord cap; per-element billing | **Chosen upgrade** — one fetch, silent fallback |
| 3. OSRM demo `/table` | Free, no key | car dataset (A4), no SLA | Rejected — wrong vehicle, unowned reliability |
| 4. Self-hosted OSRM/Valhalla with bike profile | Best possible | a server to run — the README's "fully static" promise dies | Rejected for now; revisit only if Mapbox billing ever bites |

Also considered and rejected: **duration vs distance as the displayed number** — we
*solve* on duration (what racers actually minimize) but *display* kilometres (what
racers can sanity-check against a manifest); the Matrix response carries both, so this
costs nothing.

## 5. Testing

Add Vitest (`npm i -D vitest`, `"test": "vitest run"`) — the solver is pure functions
over typed arrays, ideal first unit-test surface (A16). Mechanics: name test files
`src/*.test.ts`; import the APIs explicitly
(`import { describe, it, expect, vi } from 'vitest'`) so `tsc --noEmit` and
`npm run build` need no tsconfig changes and Vite never bundles them; use a small
seeded PRNG (e.g. an inline mulberry32) for the random-instance tests so any failure
is reproducible from the seed:

1. **`haversineKm`** against known pairs (degree-based geodesic constants; Philadelphia
   City Hall → Liberty Bell ≈ 1.3 km as a real-city sanity range).
2. **Held-Karp vs brute force** — for 200 random instances, n ∈ [2, 8], assert
   `pathCost(heldKarp order) === min over all n! permutations` (exact equality; same
   float ops). This is the load-bearing test.
3. **Refine never regresses** — for random n ∈ [15, 40], cost after `refine` ≤ NN-seed cost.
4. **Asymmetric matrices** — a hand-built instance with n = 4 controls (6 nodes,
   directed costs): assert `heldKarp`'s order matches the brute-force optimum, and
   assert `refine` rejects a seeded reversal that looks improving by boundary edges
   alone but is a net loss once internal edges reverse (this pins `twoOptDelta`). Do
   *not* assert `refine` reaches a global optimum — it is a local search; its testable
   guarantees are non-regression (test 3) and correct deltas, nothing stronger.
5. **The regression fixture** — encode the bug report as *cost* assertions, not
   position assertions: on the collinear §1 fixture (start/finish at 0, controls at
   +1, −2, +5 km) the solver's `pathCost` must be 14, strictly beating greedy's 16;
   on a 2-D "bar near start, far cluster north" fixture, `pathCost` of the returned
   order must equal the brute-force minimum. (Asserting *where* the far control lands
   is not robust: with start ≈ finish, a path and its reverse cost nearly the same
   under a symmetric metric, so a correct solver may legitimately visit the far
   control last.)
6. **`fetchCyclingMatrix` fallback** — stub the network with
   `vi.stubGlobal('fetch', …)` and the token with `vi.stubEnv('VITE_MAPBOX_TOKEN', …)`:
   non-OK response, `code !== 'Ok'`, any null cell, timeout, >25 nodes → every case
   returns `null` (whole-matrix fallback, no partial data), never throws.

Manual QA: 12-control Philly route on phone — order sanity, meta line, drag-updates-km,
`(STREET-ROUTED)` vs airplane-mode `(AIR DISTANCES)`, export unchanged.

## 6. Rollout

- **Phase 1** — `src/optimize.ts` (exact + heuristic on haversine), integration, km in
  the meta line, live km on drag, `controlId` population (A12), geocode cache-back (A11),
  Vitest with tests 1–5. Pure client change, no config. *Ship this alone; it fixes the
  reported bug outright.*
- **Phase 2** — `src/matrix.ts`, duration objective, street/air status, the
  `displayCtx` reorder-display consistency and `(AIR)` labeling, kill switch (+ its
  `env.d.ts` entry), test 6. One config sanity-check on the Mapbox token.
- **Phase 3 (optional polish)** — stale-route invalidation (A7: re-enable Optimize +
  disable Export when inputs change under a computed route), `(OPT n KM)` baseline in
  the meta line, `<rte>`-fallback export (A9).

§7 breaks these phases into discrete, ordered tasks; the only structural difference is
that test infrastructure is split out there as Phase 0 so it lands before any solver
code.

Independently of this plan, the highest-value audit items to schedule next:
**A4** (bike-correct export track — self-hosted profile or accept-and-document),
**A5** (Google key exposure — since resolved), **A6** (share-link Unicode crash — a
5-line fix).

## 7. Implementation todo

Tracks every discrete step. Work top to bottom — each phase depends on the ones before
it; within a phase, tasks are ordered so nothing references code that doesn't exist
yet. Section references (§) point into this document; line references are to the
current tree.

### Phase 0 — Test infrastructure

- [x] **Install Vitest** — `npm i -D vitest`; add `"test": "vitest run"` to
  `package.json` scripts
- [x] **Smoke-check the runner** — one trivial passing test following the conventions
  in §5 (`src/*.test.ts`, explicit `import { … } from 'vitest'` so `tsc --noEmit`
  needs no config change); `npm run test` green
- [x] **Baseline checks** — `npm run typecheck` and `npm run build` clean before any
  optimizer work begins

### Phase 1 — Exact optimizer on air distances (§2.1–2.2)

**New module `src/optimize.ts`** (§2.1 — all pure functions, no imports beyond `Coord`;
note: `nearestNeighborSeed`, `twoOptDelta`, and `refine` ended up exported so the test
suite can exercise them directly — `heldKarp` stays internal, covered via
`optimizeOrder`):

- [x] **`haversineKm(a, b)`** — moved from `main.ts`, exported
- [x] **`buildAirMatrix(nodes)`** — flat symmetric `Float64Array`, node convention
  0 = start, 1…n = controls, n+1 = finish
- [x] **`heldKarp(mat, n)`** *(internal)* — fixed-endpoint path DP with `Float64Array`
  dp table, `Int16Array` parents, finish-leg closing, parent-pointer reconstruction
- [x] **`nearestNeighborSeed(mat, n)`** — greedy seed for the heuristic branch
- [x] **`twoOptDelta(path, i, j, cost)`** — full-reversal delta including
  internal edges (asymmetric-safe)
- [x] **`refine(path, cost)`** — 2-opt via `twoOptDelta` + Or-opt
  (segment lengths 1–3), 60-round safety cap, fixed endpoints never moved
- [x] **`optimizeOrder(mat, n)`** — n ≤ 1 trivial return; n ≤ `EXACT_LIMIT` (14) →
  `heldKarp`; else seed + `refine`
- [x] **`pathCost(mat, order, n)`** — leg sum start → ordered controls → finish

**Unit tests** (§5 — write against `src/optimize.ts` before touching `main.ts`; use a
seeded PRNG for all random instances so failures are reproducible):

- [x] **Test 1: `haversineKm`** — degree-based geodesic constants (111.195 km/degree,
  antipodal half-circumference), zero distance for identical coords, City Hall →
  Liberty Bell in the 1.0–1.6 km range
- [x] **Test 2: Held-Karp vs brute force** — 200 seeded random instances (150
  coordinate-based, 50 directed matrices), n ∈ [2, 8]: `pathCost` of the returned
  order equals the minimum over all n! permutations
- [x] **Test 3: refine never regresses** — seeded n ∈ {15, 20, 30, 40}: heuristic
  cost ≤ NN-seed cost, measured with `pathCost`; order is always a permutation
- [x] **Test 4: asymmetric matrices** — directed random instances equal brute-force
  optimum (folded into test 2's second block); `twoOptDelta` rejects the
  boundary-looks-improving-but-net-loss reversal on a hand-built cost table, and
  `refine` never increases cost under it
- [x] **Test 5: regression fixture** — cost assertions per §5.5: collinear §1 fixture
  solves to `pathCost` 14 vs greedy's 16; 2-D far-cluster fixture solves to the
  brute-force minimum

**Integration into `src/main.ts`** (§2.2):

- [x] **Delete `haversine` and `nearestNeighbor`** (`main.ts:315-350`)
- [x] **Import** `buildAirMatrix, optimizeOrder, haversineKm` from `./optimize`
  (`pathCost` stays exported for the tests; `main.ts` doesn't need it)
- [x] **Add `setRouteMeta(route)` helper** — the *only* writer of the meta line:
  `N CONTROLS — X.X KM` via haversine leg sum; wire the `onListReorder`
  (`main.ts:446`) and `applyState` call sites now (restored sessions get a distance
  again)
- [x] **Rewrite the ordering block in `runOptimize`** (`main.ts:612-624`) — build
  nodes array, air matrix, `optimizeOrder`, map order back through
  `resolvedControls`, end with `setRouteMeta(resolvedRoute)` replacing the old meta
  line (`main.ts:631`)
- [x] **Populate `RoutePoint.controlId`** from `controlEntries[i].id` in the same
  block (A12)
- [x] **Cache geocodes back** (A11) — `controlCoords.set(id, coord)` after each
  control geocode (`main.ts:607`), same for start/finish, then `scheduleSave()`

**Phase 1 verification:**

- [x] **`npm run typecheck` + `npm run test` + `npm run build`** — all clean
  (10 tests passing)
- [ ] **Manual QA** — *deferred: needs a browser/phone session* — 6-control Philly
  route: order is loop-shaped (no long final leg), km shown, drag updates km live,
  reload restores route with km, export unchanged
- [x] **Commit** — Phase 1 ships alone; it fixes the reported bug outright

### Phase 2 — Street distances via Mapbox Matrix (§2.3–2.4)

- [x] **New module `src/matrix.ts`** — `fetchCyclingMatrix(nodes)` per §2.3: existing
  `VITE_MAPBOX_TOKEN`, ≤ 25 coordinates, `annotations=duration,distance`, 4 s
  timeout, coord-keyed cache, **any null cell → return `null`** (whole-matrix
  fallback, no partial data)
- [x] **Kill switch** — check `VITE_STREET_MATRIX === 'off'` at the top of
  `fetchCyclingMatrix`; add the variable to `src/env.d.ts`
- [x] **Export `clearMatrixCache()`** — called from the CLEAR SESSION handler
- [x] **`runOptimize` becomes matrix-aware** — await `fetchCyclingMatrix`; objective =
  street seconds when present, else air matrix; set
  `displayCtx = street ? { nodes, km: street.km, street: true } : null` *before* the
  `setRouteMeta` call so the displayed km comes from the same matrix that was solved
- [x] **Status suffixes** — `[OK] ROUTE READY (STREET-ROUTED)` vs
  `... (AIR DISTANCES)`
- [x] **Extend `setRouteMeta` for display consistency** — consume `displayCtx`
  (coord-key lookup into `nodes`, matrix leg sum) with haversine fallback when
  context is missing; append `(AIR)` whenever air distances are shown
- [x] **Reset `displayCtx`** on CLEAR SESSION and whenever a fresh optimize runs
- [x] **Test 6: `fetchCyclingMatrix` fallback** — stub `fetch` via `vi.stubGlobal`
  and the token via `vi.stubEnv`: non-OK response, `code !== 'Ok'`, any null cell,
  timeout, >25 nodes → every case returns `null`, never throws; kill switch returns
  `null`; plus success parsing and cache-hit coverage
- [x] **Token sanity check** — verified live: the project token returns
  `code: Ok` with asymmetric cycling distances from the Matrix API (2026-08-14)
- [x] **`npm run typecheck` + `npm run test` + `npm run build`** — all clean
  (19 tests passing)
- [ ] **Manual QA** — *deferred: needs a browser/phone session* — online:
  `(STREET-ROUTED)`, plausible street km, drag keeps the same metric; airplane
  mode: `(AIR DISTANCES)` + `KM (AIR)` within ~4 s, no error; 15+ controls:
  heuristic path on street matrix behaves
- [ ] **Post-deploy** — *deferred until this branch deploys* — one live optimize on
  production; check the Mapbox dashboard's Matrix element count after a race
  weekend (~196 elements per 12-control optimize, §2.4)

### Phase 3 — Polish (optional, §6)

- [ ] **Stale-route invalidation (A7)** — `markRouteStale()` wired into control
  `input` listeners (`main.ts:292`), `addControl`, `removeControl`, start/finish
  listeners; disables Export, dims the route block, status
  `ROUTE OUT OF DATE — RE-OPTIMIZE`
- [ ] **Optimizer baseline in the meta line** — after a manual reorder, show
  `29.1 KM (OPT 27.3)` so the cost of an override stays visible
- [ ] **Track-less export fallback (A9)** — on `fetchRoute` failure, export a
  `<rte>`-only GPX with status `[OK] EXPORTED WITHOUT TRACK — WAHOO WILL ROUTE`
- [ ] **Manual QA** — edit-after-optimize flow, override-cost display, export with
  network blocked

### Definition of done

- [ ] All boxes above checked, or consciously deferred with a note here
- [ ] Tests 1–6 in CI-runnable form (`npm run test` green from a fresh clone)
- [ ] The §3 journeys hold up when walked through by hand on a phone
- [ ] `README.md` updated if any env variable or behavior described there changed
  (`VITE_STREET_MATRIX`, distance display)

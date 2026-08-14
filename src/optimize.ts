import type { Coord } from './providers/types'

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

function heldKarp(mat: Float64Array, n: number): number[] {
  const m = n + 2
  const size = 1 << n
  const dp = new Float64Array(size * n).fill(Infinity)
  const parent = new Int16Array(size * n).fill(-1)

  for (let j = 0; j < n; j++)
    dp[(1 << j) * n + j] = mat[j + 1]

  for (let mask = 1; mask < size; mask++)
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue
      const cur = dp[mask * n + j]
      if (cur === Infinity) continue
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue
        const nextMask = mask | (1 << k)
        const cand = cur + mat[(j + 1) * m + (k + 1)]
        if (cand < dp[nextMask * n + k]) {
          dp[nextMask * n + k] = cand
          parent[nextMask * n + k] = j
        }
      }
    }

  const full = size - 1
  let best = Infinity
  let end = 0
  for (let j = 0; j < n; j++) {
    const cand = dp[full * n + j] + mat[(j + 1) * m + (n + 1)]
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

export function nearestNeighborSeed(mat: Float64Array, n: number): number[] {
  const m = n + 2
  const remaining = new Set(Array.from({ length: n }, (_, i) => i))
  const order: number[] = []
  let at = 0
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

// Reversing path[i..j] flips the direction of every edge inside the segment, so
// on asymmetric matrices the boundary-only 2-opt shortcut is invalid — the delta
// must include the internal edges in both directions.
export function twoOptDelta(
  path: number[], i: number, j: number,
  cost: (a: number, b: number) => number
): number {
  let before = cost(path[i - 1], path[i]) + cost(path[j], path[j + 1])
  let after = cost(path[i - 1], path[j]) + cost(path[i], path[j + 1])
  for (let k = i; k < j; k++) {
    before += cost(path[k], path[k + 1])
    after += cost(path[k + 1], path[k])
  }
  return after - before
}

export function refine(path: number[], cost: (a: number, b: number) => number): void {
  const EPS = 1e-9
  for (let rounds = 0; rounds < 60; rounds++) {
    let improved = false

    for (let i = 1; i < path.length - 2; i++)
      for (let j = i + 1; j < path.length - 1; j++) {
        if (twoOptDelta(path, i, j, cost) < -EPS) {
          for (let lo = i, hi = j; lo < hi; lo++, hi--) {
            const t = path[lo]
            path[lo] = path[hi]
            path[hi] = t
          }
          improved = true
        }
      }

    for (let len = 1; len <= 3; len++)
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
            i = 0
            break
          }
        }
      }

    if (!improved) break
  }
}

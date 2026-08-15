import { describe, it, expect } from 'vitest'
import type { Coord } from './providers/types'
import {
  haversineKm,
  buildAirMatrix,
  optimizeOrder,
  pathCost,
  nearestNeighborSeed,
  twoOptDelta,
  refine,
} from './optimize'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function permutations(arr: number[]): number[][] {
  if (arr.length <= 1) return [arr]
  const out: number[][] = []
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const p of permutations(rest)) out.push([arr[i], ...p])
  }
  return out
}

function controlIndices(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function bruteForceMin(mat: Float64Array, n: number): number {
  let best = Infinity
  for (const p of permutations(controlIndices(n))) {
    const c = pathCost(mat, p, n)
    if (c < best) best = c
  }
  return best
}

function randomCoords(rng: () => number, count: number): Coord[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: 39.9 + rng() * 0.2,
    lon: -75.3 + rng() * 0.3,
    label: `p${i}`,
  }))
}

function randomAsymmetricMatrix(rng: () => number, m: number): Float64Array {
  const mat = new Float64Array(m * m)
  for (let i = 0; i < m; i++)
    for (let j = 0; j < m; j++)
      if (i !== j) mat[i * m + j] = 1 + rng() * 99
  return mat
}

const KM_PER_LON_DEGREE = (2 * Math.PI * 6371) / 360

function equatorPoint(km: number, label: string): Coord {
  return { lat: 0, lon: km / KM_PER_LON_DEGREE, label }
}

describe('haversineKm', () => {
  it('matches known geodesic distances', () => {
    const origin: Coord = { lat: 0, lon: 0, label: 'o' }
    expect(haversineKm(origin, { lat: 0, lon: 1, label: 'e' })).toBeCloseTo(111.195, 2)
    expect(haversineKm(origin, { lat: 1, lon: 0, label: 'n' })).toBeCloseTo(111.195, 2)
    expect(haversineKm(origin, { lat: 0, lon: 180, label: 'anti' })).toBeCloseTo(20015.09, 1)
    expect(haversineKm(origin, origin)).toBe(0)
  })

  it('is plausible for a real city pair', () => {
    const cityHall: Coord = { lat: 39.9526, lon: -75.1652, label: 'City Hall' }
    const libertyBell: Coord = { lat: 39.9496, lon: -75.1503, label: 'Liberty Bell' }
    const d = haversineKm(cityHall, libertyBell)
    expect(d).toBeGreaterThan(1.0)
    expect(d).toBeLessThan(1.6)
  })
})

describe('optimizeOrder — exact (Held-Karp)', () => {
  it('equals the brute-force optimum on random coordinate instances', () => {
    const rng = mulberry32(1234)
    for (let run = 0; run < 150; run++) {
      const n = 2 + Math.floor(rng() * 7)
      const nodes = randomCoords(rng, n + 2)
      const mat = buildAirMatrix(nodes)
      const order = optimizeOrder(mat, n)
      expect(order.slice().sort((a, b) => a - b)).toEqual(controlIndices(n))
      expect(pathCost(mat, order, n)).toBe(bruteForceMin(mat, n))
    }
  })

  it('equals the brute-force optimum on random asymmetric instances', () => {
    const rng = mulberry32(4321)
    for (let run = 0; run < 50; run++) {
      const n = 2 + Math.floor(rng() * 6)
      const mat = randomAsymmetricMatrix(rng, n + 2)
      const order = optimizeOrder(mat, n)
      expect(pathCost(mat, order, n)).toBe(bruteForceMin(mat, n))
    }
  })

  it('handles the trivial sizes', () => {
    expect(optimizeOrder(new Float64Array(4), 0)).toEqual([])
    const nodes = randomCoords(mulberry32(7), 3)
    expect(optimizeOrder(buildAirMatrix(nodes), 1)).toEqual([0])
  })
})

describe('optimizeOrder — heuristic (n > 14)', () => {
  it('never regresses below the nearest-neighbor seed', () => {
    const rng = mulberry32(99)
    for (const n of [15, 20, 30, 40]) {
      for (let run = 0; run < 5; run++) {
        const nodes = randomCoords(rng, n + 2)
        const mat = buildAirMatrix(nodes)
        const seedOrder = nearestNeighborSeed(mat, n)
        const order = optimizeOrder(mat, n)
        expect(order.slice().sort((a, b) => a - b)).toEqual(controlIndices(n))
        expect(pathCost(mat, order, n)).toBeLessThanOrEqual(pathCost(mat, seedOrder, n))
      }
    }
  })
})

describe('twoOptDelta on asymmetric costs', () => {
  const edges = new Map<string, number>([
    ['0,1', 10], ['3,4', 10], ['0,3', 1], ['1,4', 1],
    ['1,2', 1], ['2,3', 1], ['3,2', 50], ['2,1', 50],
  ])
  const cost = (a: number, b: number): number => edges.get(`${a},${b}`) ?? 20

  it('rejects a reversal that only looks improving by its boundary edges', () => {
    const path = [0, 1, 2, 3, 4]
    const boundaryOnly =
      cost(path[0], path[3]) + cost(path[1], path[4]) -
      cost(path[0], path[1]) - cost(path[3], path[4])
    expect(boundaryOnly).toBeLessThan(0)
    expect(twoOptDelta(path, 1, 3, cost)).toBeGreaterThan(0)
  })

  it('refine never increases the path cost under it', () => {
    const path = [0, 1, 2, 3, 4]
    const total = (p: number[]): number => {
      let sum = 0
      for (let k = 0; k < p.length - 1; k++) sum += cost(p[k], p[k + 1])
      return sum
    }
    const before = total(path)
    refine(path, cost)
    expect(total(path)).toBeLessThanOrEqual(before)
    expect(path[0]).toBe(0)
    expect(path[path.length - 1]).toBe(4)
  })
})

describe('regression: front-loaded routes', () => {
  it('beats greedy on the collinear fixture (controls at +1, −2, +5 km)', () => {
    const bar = equatorPoint(0, 'bar')
    const controls = [
      equatorPoint(1, 'c+1'),
      equatorPoint(-2, 'c-2'),
      equatorPoint(5, 'c+5'),
    ]
    const mat = buildAirMatrix([bar, ...controls, bar])
    const greedyCost = pathCost(mat, nearestNeighborSeed(mat, 3), 3)
    const solvedCost = pathCost(mat, optimizeOrder(mat, 3), 3)
    expect(greedyCost).toBeCloseTo(16, 2)
    expect(solvedCost).toBeCloseTo(14, 2)
    expect(solvedCost).toBeLessThan(greedyCost)
  })

  it('solves the far-cluster fixture to the brute-force optimum', () => {
    const start: Coord = { lat: 39.95, lon: -75.16, label: 'start' }
    const finish: Coord = { lat: 39.951, lon: -75.159, label: 'finish' }
    const controls: Coord[] = [
      { lat: 39.955, lon: -75.15, label: 'near1' },
      { lat: 39.945, lon: -75.17, label: 'near2' },
      { lat: 39.96, lon: -75.155, label: 'near3' },
      { lat: 40.03, lon: -75.16, label: 'far' },
    ]
    const mat = buildAirMatrix([start, ...controls, finish])
    const order = optimizeOrder(mat, 4)
    expect(pathCost(mat, order, 4)).toBe(bruteForceMin(mat, 4))
  })
})

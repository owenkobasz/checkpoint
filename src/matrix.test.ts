import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Coord } from './providers/types'
import { fetchCyclingMatrix, clearMatrixCache } from './matrix'

function makeNodes(count: number): Coord[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: 39.9 + i * 0.01,
    lon: -75.1 - i * 0.01,
    label: `n${i}`,
  }))
}

function grid(m: number, value: number | null): (number | null)[][] {
  return Array.from({ length: m }, () => Array.from({ length: m }, () => value))
}

function okBody(m: number): string {
  return JSON.stringify({ code: 'Ok', durations: grid(m, 60), distances: grid(m, 1500) })
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  clearMatrixCache()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.test')
  vi.stubEnv('VITE_STREET_MATRIX', '')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('fetchCyclingMatrix', () => {
  it('parses durations and distances on success', async () => {
    fetchMock.mockResolvedValue(new Response(okBody(3), { status: 200 }))
    const result = await fetchCyclingMatrix(makeNodes(3))
    expect(result).not.toBeNull()
    expect(result?.seconds[1]).toBe(60)
    expect(result?.km[1]).toBe(1.5)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('serves repeat requests for the same coordinates from cache', async () => {
    fetchMock.mockResolvedValue(new Response(okBody(3), { status: 200 }))
    const nodes = makeNodes(3)
    const first = await fetchCyclingMatrix(nodes)
    const second = await fetchCyclingMatrix(nodes)
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null on a non-OK HTTP response', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }))
    expect(await fetchCyclingMatrix(makeNodes(3))).toBeNull()
  })

  it('returns null when the API code is not Ok', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'InvalidInput', durations: [], distances: [] }))
    )
    expect(await fetchCyclingMatrix(makeNodes(3))).toBeNull()
  })

  it('rejects the whole matrix on any null cell', async () => {
    const durations = grid(3, 60)
    durations[1][2] = null
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'Ok', durations, distances: grid(3, 1500) }))
    )
    expect(await fetchCyclingMatrix(makeNodes(3))).toBeNull()
  })

  it('returns null when fetch rejects (offline / timeout)', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    expect(await fetchCyclingMatrix(makeNodes(3))).toBeNull()
  })

  it('skips the network entirely above 25 coordinates', async () => {
    expect(await fetchCyclingMatrix(makeNodes(26))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips the network without a token', async () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', '')
    expect(await fetchCyclingMatrix(makeNodes(3))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honors the kill switch', async () => {
    vi.stubEnv('VITE_STREET_MATRIX', 'off')
    expect(await fetchCyclingMatrix(makeNodes(3))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

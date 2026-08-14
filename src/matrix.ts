import type { Coord } from './providers/types'

export interface StreetMatrix {
  seconds: Float64Array
  km: Float64Array
}

const cache = new Map<string, StreetMatrix>()

export function clearMatrixCache(): void {
  cache.clear()
}

export async function fetchCyclingMatrix(nodes: Coord[]): Promise<StreetMatrix | null> {
  if (import.meta.env.VITE_STREET_MATRIX === 'off') return null
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
    const km = new Float64Array(m * m)
    for (let i = 0; i < m; i++)
      for (let j = 0; j < m; j++) {
        const dur = data.durations[i][j]
        const dst = data.distances[i][j]
        // One unroutable cell would silently distort the solution and the
        // displayed km — reject the whole matrix and fall back to air.
        if (dur === null || dst === null) return null
        seconds[i * m + j] = dur
        km[i * m + j] = dst / 1000
      }
    const result = { seconds, km }
    cache.set(key, result)
    return result
  } catch {
    return null
  }
}

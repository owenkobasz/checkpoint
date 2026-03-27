import type { Coord } from './providers/types'

export async function fetchRoute(waypoints: Coord[]): Promise<[number, number][]> {
  const coords = waypoints.map(p => `${p.lon},${p.lat}`).join(';')
  const url =
    `https://router.project-osrm.org/route/v1/cycling/${coords}` +
    `?overview=full&geometries=geojson`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`ROUTING ERROR (${res.status})`)

  const data = await res.json() as {
    code: string
    routes: Array<{
      geometry: { coordinates: [number, number][] }
    }>
  }

  if (data.code !== 'Ok' || data.routes.length === 0) {
    throw new Error(`ROUTER: ${data.code}`)
  }

  // OSRM returns [lon, lat] — swap to [lat, lon]
  return data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon])
}

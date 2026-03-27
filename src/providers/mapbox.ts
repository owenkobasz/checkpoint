import type { Coord, GeocoderProvider } from './types'

export class MapboxGeocoder implements GeocoderProvider {
  private readonly token: string

  constructor(token: string) {
    this.token = token
  }

  async geocode(query: string): Promise<Coord> {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${this.token}&limit=1`

    const res = await fetch(url)
    if (!res.ok) throw new Error(`GEOCODER ERROR (${res.status})`)

    const data = await res.json() as {
      features: Array<{
        place_name: string
        geometry: { coordinates: [number, number] }
      }>
    }

    if (data.features.length === 0) throw new Error(`NOT FOUND: "${query}"`)

    const f = data.features[0]
    return {
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: f.place_name,
    }
  }

  async suggest(query: string, signal: AbortSignal): Promise<Coord[]> {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${this.token}&autocomplete=true&types=address,place,poi&limit=5`

    const res = await fetch(url, { signal })
    if (!res.ok) return []

    const data = await res.json() as {
      features: Array<{
        place_name: string
        geometry: { coordinates: [number, number] }
      }>
    }

    return data.features.map(f => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: f.place_name,
    }))
  }
}

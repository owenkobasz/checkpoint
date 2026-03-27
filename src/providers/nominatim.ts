import type { Coord, GeocoderProvider } from './types'

export class NominatimGeocoder implements GeocoderProvider {
  async geocode(query: string): Promise<Coord> {
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(query)}&format=json&limit=1`

    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } })
    if (!res.ok) throw new Error(`GEOCODER ERROR (${res.status})`)

    const data = await res.json() as Array<{ lat: string; lon: string; display_name: string }>
    if (data.length === 0) throw new Error(`NOT FOUND: "${query}"`)

    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      label: data[0].display_name,
    }
  }

  async suggest(query: string, signal: AbortSignal): Promise<Coord[]> {
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(query)}&format=json&limit=5`

    const res = await fetch(url, { signal, headers: { 'Accept-Language': 'en' } })
    if (!res.ok) return []

    const data = await res.json() as Array<{ lat: string; lon: string; display_name: string }>
    return data.map(item => ({
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
      label: item.display_name,
    }))
  }
}

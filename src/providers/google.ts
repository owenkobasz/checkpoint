import { setOptions, importLibrary } from '@googlemaps/js-api-loader'
import type { Coord, GeocoderProvider } from './types'

export class GoogleGeocoder implements GeocoderProvider {
  private readonly apiKey: string
  private placesLib: google.maps.PlacesLibrary | null = null

  constructor(apiKey: string) {
    this.apiKey = apiKey
    setOptions({ key: apiKey, v: 'weekly' })
  }

  private async ensureLoaded(): Promise<google.maps.PlacesLibrary> {
    if (this.placesLib) return this.placesLib
    this.placesLib = await importLibrary('places') as google.maps.PlacesLibrary
    return this.placesLib
  }

  async geocode(query: string): Promise<Coord> {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(query)}&key=${this.apiKey}`

    const res = await fetch(url)
    if (!res.ok) throw new Error(`GEOCODER ERROR (${res.status})`)

    const data = await res.json() as {
      status: string
      results: Array<{
        formatted_address: string
        geometry: { location: { lat: number; lng: number } }
      }>
    }

    if (data.status !== 'OK' || data.results.length === 0) {
      throw new Error(`${data.status}: "${query}"`)
    }

    const r = data.results[0]
    return {
      lat: r.geometry.location.lat,
      lon: r.geometry.location.lng,
      label: r.formatted_address,
    }
  }

  async suggest(query: string, signal: AbortSignal): Promise<Coord[]> {
    if (signal.aborted) return []

    const lib = await this.ensureLoaded()
    if (signal.aborted) return []

    const service = new lib.AutocompleteService()

    try {
      const response = await service.getPlacePredictions({ input: query })
      if (signal.aborted) return []

      return response.predictions.slice(0, 5).map(p => ({
        lat: 0,
        lon: 0,
        label: p.description,
      }))
    } catch {
      return []
    }
  }
}

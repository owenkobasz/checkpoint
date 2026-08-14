import { setOptions, importLibrary } from '@googlemaps/js-api-loader'
import type { Coord, GeocoderProvider } from './types'

export class GoogleGeocoder implements GeocoderProvider {
  private placesLib: google.maps.PlacesLibrary | null = null
  private geocoder: google.maps.Geocoder | null = null

  constructor(apiKey: string) {
    setOptions({ key: apiKey, v: 'weekly' })
  }

  private async ensureLoaded(): Promise<google.maps.PlacesLibrary> {
    if (this.placesLib) return this.placesLib
    this.placesLib = await importLibrary('places') as google.maps.PlacesLibrary
    return this.placesLib
  }

  private async ensureGeocoder(): Promise<google.maps.Geocoder> {
    if (this.geocoder) return this.geocoder
    const lib = await importLibrary('geocoding') as google.maps.GeocodingLibrary
    this.geocoder = new lib.Geocoder()
    return this.geocoder
  }

  // Uses the Maps JS API Geocoder (not the REST endpoint) so the API key can be
  // HTTP-referer-restricted and safely shipped to the browser.
  async geocode(query: string): Promise<Coord> {
    const geocoder = await this.ensureGeocoder()

    let results: google.maps.GeocoderResult[]
    try {
      results = (await geocoder.geocode({ address: query })).results
    } catch {
      // The JS Geocoder rejects on ZERO_RESULTS and quota/denial states alike
      throw new Error(`NOT FOUND: "${query}"`)
    }
    if (results.length === 0) throw new Error(`NOT FOUND: "${query}"`)

    const r = results[0]
    return {
      lat: r.geometry.location.lat(),
      lon: r.geometry.location.lng(),
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

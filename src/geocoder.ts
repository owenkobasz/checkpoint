import type { GeocoderProvider } from './providers/types'
import { NominatimGeocoder } from './providers/nominatim'
import { GoogleGeocoder } from './providers/google'

export type { Coord } from './providers/types'

export function getGeocoder(): GeocoderProvider {
  const provider = import.meta.env.VITE_GEOCODER_PROVIDER ?? 'nominatim'
  if (provider === 'google') {
    const key = import.meta.env.VITE_GOOGLE_MAPS_KEY
    if (!key) throw new Error('VITE_GOOGLE_MAPS_KEY not set')
    return new GoogleGeocoder(key)
  }
  return new NominatimGeocoder()
}

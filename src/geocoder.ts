import type { GeocoderProvider } from './providers/types'
import { MapboxGeocoder }    from './providers/mapbox'
import { GoogleGeocoder }    from './providers/google'
import { NominatimGeocoder } from './providers/nominatim'

export type { Coord } from './providers/types'
export type ProviderName = 'mapbox' | 'google' | 'nominatim'

let _instance: GeocoderProvider
let _providerName: ProviderName

function makeProvider(name: ProviderName): GeocoderProvider {
  if (name === 'google') {
    const key = import.meta.env.VITE_GOOGLE_MAPS_KEY
    if (!key) throw new Error('VITE_GOOGLE_MAPS_KEY not set')
    return new GoogleGeocoder(key)
  }
  if (name === 'mapbox') {
    const token = import.meta.env.VITE_MAPBOX_TOKEN
    if (!token) throw new Error('VITE_MAPBOX_TOKEN not set')
    return new MapboxGeocoder(token)
  }
  return new NominatimGeocoder()
}

function init(): void {
  const name = (import.meta.env.VITE_GEOCODER_PROVIDER ?? 'mapbox') as ProviderName
  _providerName = name
  _instance = makeProvider(name)
}

init()

export function getGeocoder(): GeocoderProvider {
  return _instance
}

export function getProviderName(): ProviderName {
  return _providerName
}

export function switchProvider(name: ProviderName): void {
  _instance = makeProvider(name)
  _providerName = name
}

/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_GEOCODER_PROVIDER: 'google' | 'mapbox' | 'nominatim'
  readonly VITE_GOOGLE_MAPS_KEY: string
  readonly VITE_MAPBOX_TOKEN: string
  readonly VITE_UNLOCK_HASH: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_GEOCODER_PROVIDER: 'google' | 'nominatim'
  readonly VITE_GOOGLE_MAPS_KEY: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

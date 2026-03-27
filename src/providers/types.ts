export interface Coord {
  lat: number
  lon: number
  label: string
}

export interface GeocoderProvider {
  geocode(query: string): Promise<Coord>
  suggest(query: string, signal: AbortSignal): Promise<Coord[]>
}

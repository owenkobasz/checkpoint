export interface Coord {
  lat: number
  lon: number
  label: string
}

export interface GeocoderProvider {
  geocode(query: string, near?: Coord): Promise<Coord>
  suggest(query: string, signal: AbortSignal, near?: Coord): Promise<Coord[]>
}

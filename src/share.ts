import type { Coord } from './providers/types'
import type { PersistedState, PersistedControl } from './persistence'

interface SharePayload {
  s: [number, number, string] | null
  f: [number, number, string] | null
  c: [number, number, string][]
}

export function buildShareURL(state: PersistedState): string {
  const payload: SharePayload = {
    s: state.startCoords
      ? [state.startCoords.lat, state.startCoords.lon, state.startLabel]
      : null,
    f: state.finishCoords
      ? [state.finishCoords.lat, state.finishCoords.lon, state.finishLabel]
      : null,
    c: state.controls
      .filter((ctrl): ctrl is PersistedControl & { coord: Coord } => ctrl.coord !== null)
      .map(ctrl => [ctrl.coord.lat, ctrl.coord.lon, ctrl.inputLabel]),
  }
  const encoded = btoa(JSON.stringify(payload))
  return `${location.origin}${location.pathname}#share=${encoded}`
}

export function loadShareURL(): Partial<PersistedState> | null {
  const hash = location.hash
  if (!hash.startsWith('#share=')) return null
  try {
    const payload = JSON.parse(atob(hash.slice(7))) as SharePayload
    const controls: PersistedControl[] = (payload.c ?? []).map((c, i) => ({
      id:         i + 1,
      inputLabel: c[2],
      coord:      { lat: c[0], lon: c[1], label: c[2] },
    }))
    const result: Partial<PersistedState> = {
      startCoords:  payload.s ? { lat: payload.s[0], lon: payload.s[1], label: payload.s[2] } : null,
      startLabel:   payload.s?.[2] ?? '',
      finishCoords: payload.f ? { lat: payload.f[0], lon: payload.f[1], label: payload.f[2] } : null,
      finishLabel:  payload.f?.[2] ?? '',
      controls,
      controlCount: controls.length,
      resolvedRoute: null,
    }
    return result
  } catch {
    return null
  }
}

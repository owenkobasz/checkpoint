import type { Coord } from './providers/types'

export type PointRole = 'start' | 'control' | 'finish'

export interface RoutePoint {
  coord:     Coord
  role:      PointRole
  label:     string
  controlId: number | null
}

export interface PersistedControl {
  id:         number
  inputLabel: string
  coord:      Coord | null
}

export interface PersistedState {
  version:       1
  savedAt:       number
  startLabel:    string
  startCoords:   Coord | null
  finishLabel:   string
  finishCoords:  Coord | null
  controls:      PersistedControl[]
  controlCount:  number
  resolvedRoute: RoutePoint[] | null
}

const KEY            = 'alleycat_v1'
const SCHEMA_VERSION = 1

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state, savedAt: Date.now() }))
  } catch { /* QuotaExceededError — ignore */ }
}

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as PersistedState
    return data.version === SCHEMA_VERSION ? data : null
  } catch {
    return null
  }
}

export function clearState(): void {
  localStorage.removeItem(KEY)
}

import './style.css'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import Sortable from 'sortablejs'
import { getGeocoder, getProviderName } from './geocoder'
import type { Coord } from './geocoder'
import { tryUnlock, isUnlocked, lock } from './unlock'
import { fetchRoute } from './router'

// ── Types ───────────────────────────────────────────────────────
type PointRole = 'start' | 'control' | 'finish'
type StatusType = 'ok' | 'warn' | 'error' | 'busy'

interface RoutePoint {
  coord:     Coord
  role:      PointRole
  label:     string
  controlId: number | null
}

// ── State ───────────────────────────────────────────────────────
let startCoords:   Coord | null = null
let finishCoords:  Coord | null = null
let controlCount  = 0
let resolvedRoute: RoutePoint[] | null = null

const controlCoords = new Map<number, Coord>()

let mapInstance:   L.Map         | null = null
let markersLayer:  L.LayerGroup  | null = null
let polylineLayer: L.Polyline    | null = null
let sortable:      Sortable      | null = null

function needsRateLimit(): boolean {
  return getProviderName() === 'nominatim'
}

// ── DOM refs ────────────────────────────────────────────────────
const statusBar   = document.getElementById('status')        as HTMLDivElement
const statusMsg   = document.getElementById('statusMsg')     as HTMLSpanElement
const gpsBtn      = document.getElementById('gpsBtn')        as HTMLButtonElement
const gpsBtnLabel = document.getElementById('gpsBtnLabel')   as HTMLSpanElement
const startInput  = document.getElementById('startInput')    as HTMLInputElement
const finishInput = document.getElementById('finishInput')   as HTMLInputElement
const controlsList= document.getElementById('controls-list') as HTMLDivElement
const addBtn      = document.getElementById('addBtn')        as HTMLButtonElement
const optimizeBtn = document.getElementById('optimizeBtn')   as HTMLButtonElement
const exportBtn   = document.getElementById('exportBtn')     as HTMLButtonElement
const routeBlock  = document.getElementById('block-route')   as HTMLElement
const routeMeta   = document.getElementById('routeMeta')     as HTMLSpanElement
const routeList   = document.getElementById('route-list')    as HTMLOListElement

const providerBtn       = document.getElementById('providerBtn')       as HTMLButtonElement
const providerIndicator = document.getElementById('providerIndicator') as HTMLSpanElement
const unlockModal       = document.getElementById('unlockModal')       as HTMLDivElement
const unlockInput       = document.getElementById('unlockInput')       as HTMLInputElement
const unlockSubmit      = document.getElementById('unlockSubmit')      as HTMLButtonElement
const unlockError       = document.getElementById('unlockError')       as HTMLParagraphElement
const modalClose        = document.getElementById('modalClose')        as HTMLButtonElement

// ── Status bar ──────────────────────────────────────────────────
function setStatus(msg: string, type: StatusType = 'ok'): void {
  statusBar.className = `status-bar ${type}`
  statusMsg.textContent = msg.toUpperCase()
}

// ── GPS ─────────────────────────────────────────────────────────
async function getGPS(): Promise<void> {
  if (!('geolocation' in navigator)) {
    setStatus('[ERR] GPS NOT SUPPORTED — ENTER ADDRESS MANUALLY', 'error')
    return
  }

  gpsBtn.classList.add('scanning')
  gpsBtnLabel.textContent = 'ACQUIRING...'
  setStatus('REQUESTING GPS COORDINATES...', 'busy')

  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
      })
    )
    const { latitude: lat, longitude: lon } = pos.coords
    startCoords = { lat, lon, label: 'Current Location' }
    startInput.value = ''
    startInput.placeholder = `${lat.toFixed(5)}, ${lon.toFixed(5)}`
    gpsBtn.classList.add('locked')
    gpsBtnLabel.textContent = `GPS LOCKED — ${lat.toFixed(4)}, ${lon.toFixed(4)}`
    setStatus('[OK] GPS LOCKED', 'ok')
  } catch {
    setStatus('[ERR] GPS UNAVAILABLE — ENTER ADDRESS MANUALLY', 'error')
    gpsBtnLabel.textContent = 'ACQUIRE GPS SIGNAL'
  } finally {
    gpsBtn.classList.remove('scanning')
  }
}

// ── Autocomplete ─────────────────────────────────────────────────
function shortLabel(displayName: string): string {
  return displayName.split(',').slice(0, 3).join(',').trim()
}

function attachAutocomplete(
  inputEl: HTMLInputElement,
  onSelect: (coord: Coord) => void
): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let suggestions: Coord[] = []
  let highlightedIdx = -1

  const dropdown = document.createElement('ul')
  dropdown.className = 'autocomplete-dropdown hidden'

  const wrap = inputEl.closest('.input-wrap')
  if (wrap) wrap.appendChild(dropdown)

  function setHighlight(idx: number): void {
    highlightedIdx = idx
    dropdown.querySelectorAll<HTMLElement>('.autocomplete-item').forEach((item, i) => {
      item.classList.toggle('highlighted', i === idx)
    })
  }

  function close(): void {
    dropdown.classList.add('hidden')
    dropdown.innerHTML = ''
    suggestions = []
    highlightedIdx = -1
  }

  async function selectItem(idx: number): Promise<void> {
    let coord = suggestions[idx]
    if (!coord) return

    if (coord.lat === 0 && coord.lon === 0) {
      inputEl.value = shortLabel(coord.label)
      inputEl.disabled = true
      try {
        coord = await getGeocoder().geocode(coord.label)
      } finally {
        inputEl.disabled = false
      }
    } else {
      inputEl.value = shortLabel(coord.label)
    }

    onSelect(coord)
    close()
  }

  function show(coords: Coord[]): void {
    suggestions = coords
    highlightedIdx = -1
    dropdown.innerHTML = ''

    if (coords.length === 0) {
      dropdown.classList.add('hidden')
      return
    }

    coords.forEach((coord, i) => {
      const li = document.createElement('li')
      li.className = 'autocomplete-item'
      li.textContent = shortLabel(coord.label)
      li.addEventListener('mousedown', e => {
        e.preventDefault()
        void selectItem(i)
      })
      dropdown.appendChild(li)
    })

    dropdown.classList.remove('hidden')

    // Flip upward if there isn't enough space below the input
    const rect = inputEl.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - 16
    const dropHeight = Math.min(coords.length * 38, 220)
    dropdown.classList.toggle('opens-up', spaceBelow < dropHeight)
  }

  inputEl.addEventListener('input', () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    controller?.abort()

    const query = inputEl.value.trim()
    if (query.length < 3) { close(); return }

    debounceTimer = setTimeout(() => {
      controller = new AbortController()
      const signal = controller.signal

      getGeocoder().suggest(query, signal)
        .then(results => { if (!signal.aborted) show(results) })
        .catch(() => {})
    }, 500)
  })

  inputEl.addEventListener('keydown', e => {
    if (dropdown.classList.contains('hidden')) return
    const count = suggestions.length

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((highlightedIdx + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((highlightedIdx - 1 + count) % count)
    } else if (e.key === 'Enter' && highlightedIdx >= 0) {
      e.preventDefault()
      void selectItem(highlightedIdx)
    } else if (e.key === 'Escape') {
      close()
    }
  })

  inputEl.addEventListener('blur', () => {
    setTimeout(close, 150)
  })
}

// ── Controls list ────────────────────────────────────────────────
function addControl(): void {
  controlCount++
  const id = controlCount

  const row = document.createElement('div')
  row.className = 'control-row'
  row.dataset['id'] = String(id)

  const indexSpan = document.createElement('span')
  indexSpan.className = 'control-index'
  indexSpan.textContent = String(controlCount).padStart(2, '0')

  const wrap = document.createElement('div')
  wrap.className = 'input-wrap'
  wrap.style.flex = '1'

  const inputRow = document.createElement('div')
  inputRow.className = 'input-row'

  const cursor = document.createElement('span')
  cursor.className = 'input-cursor'
  cursor.setAttribute('aria-hidden', 'true')
  cursor.textContent = '_'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'terminal-input'
  input.id = `control-${id}`
  input.placeholder = 'INTERSECTION OR ADDRESS'
  input.autocomplete = 'off'

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.className = 'remove-btn'
  removeBtn.textContent = '✕'
  removeBtn.addEventListener('click', () => removeControl(id))

  inputRow.appendChild(cursor)
  inputRow.appendChild(input)
  wrap.appendChild(inputRow)

  row.appendChild(indexSpan)
  row.appendChild(wrap)
  row.appendChild(removeBtn)
  controlsList.appendChild(row)

  input.addEventListener('input', () => controlCoords.delete(id))
  attachAutocomplete(input, coord => controlCoords.set(id, coord))

  input.focus()
  renumberControls()
}

function removeControl(id: number): void {
  const row = controlsList.querySelector(`.control-row[data-id="${id}"]`)
  if (row) row.remove()
  controlCoords.delete(id)
  renumberControls()
}

function renumberControls(): void {
  controlsList.querySelectorAll<HTMLElement>('.control-row').forEach((row, i) => {
    const span = row.querySelector('.control-index')
    if (span) span.textContent = String(i + 1).padStart(2, '0')
  })
}

// ── Optimization ─────────────────────────────────────────────────
function haversine(a: Coord, b: Coord): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * (Math.PI / 180)
  const dLon = (b.lon - a.lon) * (Math.PI / 180)
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * (Math.PI / 180)) *
      Math.cos(b.lat * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

function nearestNeighbor(start: Coord, points: Coord[]): Coord[] {
  const unvisited = [...points]
  const ordered: Coord[] = []
  let current = start

  while (unvisited.length > 0) {
    let nearestIdx = 0
    let nearestDist = Infinity

    unvisited.forEach((pt, i) => {
      const d = haversine(current, pt)
      if (d < nearestDist) {
        nearestDist = d
        nearestIdx = i
      }
    })

    const next = unvisited.splice(nearestIdx, 1)[0]
    ordered.push(next)
    current = next
  }

  return ordered
}

// ── Map ───────────────────────────────────────────────────────────
function initMap(): void {
  mapInstance = L.map('route-map', { zoomControl: true, attributionControl: false })
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mapInstance)
  markersLayer = L.layerGroup().addTo(mapInstance)
}

function markerIcon(label: string, role: PointRole): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="map-marker marker-${role}">${label}</div>`,
    iconSize:   [24, 24],
    iconAnchor: [12, 12],
  })
}

function renderMap(route: RoutePoint[]): void {
  if (!mapInstance || !markersLayer) return

  markersLayer.clearLayers()
  polylineLayer?.remove()

  const latlngs: L.LatLngExpression[] = route.map(p => [p.coord.lat, p.coord.lon])

  route.forEach((pt, i) => {
    const label = pt.role === 'start' ? 'S'
                : pt.role === 'finish' ? 'F'
                : String(i)
    L.marker([pt.coord.lat, pt.coord.lon], {
      icon: markerIcon(label, pt.role),
    }).addTo(markersLayer!)
  })

  polylineLayer = L.polyline(latlngs, {
    color: '#00FF41',
    weight: 1.5,
    opacity: 0.7,
    dashArray: '4 4',
  }).addTo(mapInstance)

  mapInstance.fitBounds(polylineLayer.getBounds(), { padding: [20, 20] })
}

// ── Route list ────────────────────────────────────────────────────
function buildRouteList(route: RoutePoint[]): void {
  routeList.innerHTML = ''

  route.forEach((pt, i) => {
    const isFixed = pt.role === 'start' || pt.role === 'finish'
    const indexLabel = pt.role === 'start' ? 'S' : pt.role === 'finish' ? 'F' : String(i)

    const li = document.createElement('li')
    li.className = `route-item${isFixed ? ' route-item--fixed' : ''}`
    li.dataset['idx'] = String(i)

    const handle = document.createElement('span')
    handle.className = `drag-handle${isFixed ? ' drag-handle--hidden' : ''}`
    handle.setAttribute('aria-hidden', 'true')
    handle.textContent = '⠿'

    const indexEl = document.createElement('span')
    indexEl.className = 'route-item-index'
    indexEl.textContent = indexLabel

    const labelEl = document.createElement('span')
    labelEl.className = 'route-item-label'
    labelEl.textContent = pt.label

    const roleEl = document.createElement('span')
    roleEl.className = `route-item-role role-${pt.role}`
    roleEl.textContent = pt.role.toUpperCase()

    li.appendChild(handle)
    li.appendChild(indexEl)
    li.appendChild(labelEl)
    li.appendChild(roleEl)
    routeList.appendChild(li)
  })

  sortable?.destroy()
  sortable = Sortable.create(routeList, {
    animation: 120,
    handle: '.drag-handle',
    filter: '.route-item--fixed',
    onMove: evt => {
      const items = routeList.querySelectorAll('.route-item')
      if (evt.related === items[0]) return false
      if (evt.related === items[items.length - 1]) return false
      return true
    },
    onEnd: onListReorder,
  })
}

function onListReorder(): void {
  if (!resolvedRoute) return

  const snapshot = resolvedRoute.slice()
  const items = Array.from(routeList.querySelectorAll<HTMLElement>('.route-item'))

  resolvedRoute = items.map(item => snapshot[Number(item.dataset['idx'])])

  items.forEach((item, i) => { item.dataset['idx'] = String(i) })

  updateListIndices()
  renderMap(resolvedRoute)
}

function updateListIndices(): void {
  const items = routeList.querySelectorAll<HTMLElement>('.route-item')
  let controlNum = 1
  items.forEach(item => {
    const indexEl = item.querySelector('.route-item-index')
    if (!indexEl) return
    const role = resolvedRoute?.[Number(item.dataset['idx'])]?.role
    if (role === 'start') indexEl.textContent = 'S'
    else if (role === 'finish') indexEl.textContent = 'F'
    else { indexEl.textContent = String(controlNum); controlNum++ }
  })
}

// ── GPX ───────────────────────────────────────────────────────────
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildRoutedGPX(
  trackPoints: [number, number][],
  waypoints: RoutePoint[]
): string {
  const trkpts = trackPoints
    .map(([lat, lon]) =>
      `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`
    )
    .join('\n')

  const wpts = waypoints
    .map(
      p =>
        `  <wpt lat="${p.coord.lat.toFixed(6)}" lon="${p.coord.lon.toFixed(6)}">\n` +
        `    <name>${escapeXml(p.label)}</name>\n` +
        `  </wpt>`
    )
    .join('\n')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Checkpoint"\n` +
    `     xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata>\n` +
    `    <name>Alleycat Route</name>\n` +
    `    <time>${new Date().toISOString()}</time>\n` +
    `  </metadata>\n` +
    wpts + '\n' +
    `  <trk>\n` +
    `    <name>Alleycat Route</name>\n` +
    `    <trkseg>\n` +
    trkpts + '\n' +
    `    </trkseg>\n` +
    `  </trk>\n` +
    `</gpx>`
  )
}

async function exportGPX(gpxString: string): Promise<void> {
  const filename = `checkpoint-${Date.now()}.gpx`
  const file = new File([gpxString], filename, { type: 'application/gpx+xml' })

  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: 'Alleycat Route' })
    return
  }

  // Fallback: direct download
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Core flow ─────────────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runOptimize(): Promise<void> {
  optimizeBtn.disabled = true
  optimizeBtn.textContent = 'OPTIMIZING...'

  try {
    const startVal  = startInput.value.trim()
    const finishVal = finishInput.value.trim()

    const controlEntries = Array.from(
      controlsList.querySelectorAll<HTMLElement>('.control-row')
    )
      .map(row => ({
        id:    Number(row.dataset['id']),
        value: (row.querySelector<HTMLInputElement>('input')?.value ?? '').trim(),
      }))
      .filter(e => e.value.length > 0)

    if (!startCoords && !startVal) {
      setStatus('[ERR] SET START LOCATION OR ACQUIRE GPS', 'error')
      return
    }
    if (!finishCoords && !finishVal) {
      setStatus('[ERR] SET FINISH LOCATION', 'error')
      return
    }
    if (controlEntries.length === 0) {
      setStatus('[ERR] ADD AT LEAST ONE CONTROL', 'error')
      return
    }

    let needsDelay = false

    let resolvedStart: Coord
    if (startCoords) {
      resolvedStart = startCoords
    } else {
      setStatus('GEOCODING START...', 'busy')
      if (needsRateLimit() && needsDelay) await delay(1100)
      resolvedStart = await getGeocoder().geocode(startVal)
      needsDelay = true
    }

    let resolvedFinish: Coord
    if (finishCoords) {
      resolvedFinish = finishCoords
    } else {
      setStatus('GEOCODING FINISH...', 'busy')
      if (needsRateLimit() && needsDelay) await delay(1100)
      resolvedFinish = await getGeocoder().geocode(finishVal)
      needsDelay = true
    }

    const resolvedControls: Coord[] = []
    for (let i = 0; i < controlEntries.length; i++) {
      const { id, value } = controlEntries[i]
      const cached = controlCoords.get(id)
      if (cached) {
        resolvedControls.push(cached)
      } else {
        setStatus(`GEOCODING CONTROL ${i + 1} OF ${controlEntries.length}...`, 'busy')
        if (needsRateLimit() && needsDelay) await delay(1100)
        resolvedControls.push(await getGeocoder().geocode(value))
        needsDelay = true
      }
    }

    setStatus('OPTIMIZING ROUTE...', 'busy')
    const ordered = nearestNeighbor(resolvedStart, resolvedControls)

    resolvedRoute = [
      { coord: resolvedStart,  role: 'start',   label: shortLabel(resolvedStart.label),  controlId: null },
      ...ordered.map(c => ({
        coord: c,
        role: 'control' as PointRole,
        label: shortLabel(c.label),
        controlId: null,
      })),
      { coord: resolvedFinish, role: 'finish',  label: shortLabel(resolvedFinish.label), controlId: null },
    ]

    routeBlock.classList.remove('hidden')
    if (!mapInstance) initMap()
    buildRouteList(resolvedRoute)
    renderMap(resolvedRoute)

    routeMeta.textContent = `${ordered.length} CONTROL${ordered.length !== 1 ? 'S' : ''}`
    exportBtn.disabled = false
    setStatus('[OK] ROUTE READY — REORDER IF NEEDED', 'ok')
    routeBlock.scrollIntoView({ behavior: 'smooth' })

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'UNKNOWN ERROR'
    setStatus(`[ERR] ${msg}`, 'error')
  } finally {
    optimizeBtn.disabled = false
    optimizeBtn.textContent = '▶ OPTIMIZE ROUTE'
  }
}

async function runExport(): Promise<void> {
  if (!resolvedRoute) return

  exportBtn.disabled = true
  exportBtn.textContent = 'ROUTING...'
  setStatus('FETCHING ROUTE...', 'busy')

  try {
    const waypoints = resolvedRoute.map(p => p.coord)
    const trackPoints = await fetchRoute(waypoints)
    const gpx = buildRoutedGPX(trackPoints, resolvedRoute)
    await exportGPX(gpx)
    setStatus('[OK] GPX EXPORTED', 'ok')
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'UNKNOWN ERROR'
    setStatus(`[ERR] ${msg}`, 'error')
  } finally {
    exportBtn.disabled = false
    exportBtn.textContent = '↓ EXPORT GPX'
  }
}

// ── Event listeners ───────────────────────────────────────────────
gpsBtn.addEventListener('click', () => { void getGPS() })
addBtn.addEventListener('click', addControl)
optimizeBtn.addEventListener('click', () => { void runOptimize() })
exportBtn.addEventListener('click', () => { void runExport() })

startInput.addEventListener('input', () => {
  if (startInput.value.trim().length > 0 && startCoords) {
    startCoords = null
    gpsBtn.classList.remove('locked')
    gpsBtnLabel.textContent = 'ACQUIRE GPS SIGNAL'
    startInput.placeholder = 'E.G. BROAD & GIRARD, PHILADELPHIA'
  }
})

finishInput.addEventListener('input', () => {
  if (finishInput.value.trim().length > 0 && finishCoords) {
    finishCoords = null
  }
})

attachAutocomplete(startInput,  coord => { startCoords  = coord })
attachAutocomplete(finishInput, coord => { finishCoords = coord })

addControl()

// ── Provider unlock UI ────────────────────────────────────────────
function updateProviderUI(): void {
  if (isUnlocked()) {
    providerIndicator.textContent = '◉ GOOGLE'
    providerBtn.classList.add('unlocked')
  } else {
    providerIndicator.textContent = '◎ MAPBOX'
    providerBtn.classList.remove('unlocked')
  }
}

providerBtn.addEventListener('click', () => {
  if (isUnlocked()) {
    lock()
    updateProviderUI()
    setStatus('[OK] SWITCHED TO MAPBOX', 'ok')
  } else {
    unlockInput.value = ''
    unlockError.classList.add('hidden')
    unlockModal.classList.remove('hidden')
    setTimeout(() => unlockInput.focus(), 50)
  }
})

modalClose.addEventListener('click', () => {
  unlockModal.classList.add('hidden')
})

unlockModal.addEventListener('click', e => {
  if (e.target === unlockModal) unlockModal.classList.add('hidden')
})

unlockSubmit.addEventListener('click', () => {
  void (async () => {
    unlockSubmit.disabled = true
    unlockSubmit.textContent = 'CHECKING...'

    const ok = await tryUnlock(unlockInput.value)

    unlockSubmit.disabled = false
    unlockSubmit.textContent = 'UNLOCK'

    if (ok) {
      unlockModal.classList.add('hidden')
      updateProviderUI()
      setStatus('[OK] GOOGLE GEOCODER ACTIVE', 'ok')
    } else {
      unlockError.classList.remove('hidden')
      unlockInput.select()
    }
  })()
})

unlockInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') unlockSubmit.click()
  if (e.key === 'Escape') unlockModal.classList.add('hidden')
})

updateProviderUI()

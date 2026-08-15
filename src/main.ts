import './style.css'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import Sortable from 'sortablejs'
import { getGeocoder, getProviderName, switchProvider } from './geocoder'
import type { Coord, ProviderName } from './geocoder'
import { buildAirMatrix, optimizeOrder, haversineKm } from './optimize'
import { fetchCyclingMatrix, clearMatrixCache } from './matrix'
import { fetchRoute } from './router'
import { saveState, loadState, clearState } from './persistence'
import type { PersistedState, PersistedControl, RoutePoint, PointRole } from './persistence'
import { buildShareURL, loadShareURL } from './share'
import { scanManifest, isDuplicate, cityTokenSet, labelWithCity } from './scan'

// ── Types ───────────────────────────────────────────────────────
type StatusType = 'ok' | 'warn' | 'error' | 'busy'

// ── State ───────────────────────────────────────────────────────
let startCoords:   Coord | null = null
let finishCoords:  Coord | null = null
let controlCount  = 0
let resolvedRoute: RoutePoint[] | null = null

const controlCoords = new Map<number, Coord>()

interface ControlMeta {
  source:   'manual' | 'scanned'
  note:     string | null
  verified: boolean
}

const controlMeta = new Map<number, ControlMeta>()

let mapInstance:   L.Map         | null = null
let markersLayer:  L.LayerGroup  | null = null
let polylineLayer: L.Polyline    | null = null
let sortable:      Sortable      | null = null

// ── Persistence ─────────────────────────────────────────────────
let saveTimer: ReturnType<typeof setTimeout> | null = null

function collectControls(): PersistedControl[] {
  const controls: PersistedControl[] = []
  controlsList.querySelectorAll<HTMLElement>('.control-row').forEach(row => {
    const id    = parseInt(row.dataset['id'] ?? '0', 10)
    const input = row.querySelector<HTMLInputElement>('input')
    const meta  = controlMeta.get(id)
    controls.push({
      id,
      inputLabel: input?.value ?? '',
      coord: controlCoords.get(id) ?? null,
      ...(meta ? { source: meta.source, note: meta.note, verified: meta.verified } : {}),
    })
  })
  return controls
}

function persistCurrentState(): void {
  const controls = collectControls()

  const state: PersistedState = {
    version:       1,
    savedAt:       Date.now(),
    startLabel:    startInput.value,
    startCoords,
    finishLabel:   finishInput.value,
    finishCoords,
    controls,
    controlCount,
    resolvedRoute,
  }
  saveState(state)
}

function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(persistCurrentState, 600)
}

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
const clearBtn    = document.getElementById('clearBtn')      as HTMLButtonElement
const shareBtn    = document.getElementById('shareBtn')      as HTMLButtonElement
const routeBlock  = document.getElementById('block-route')   as HTMLElement
const routeMeta   = document.getElementById('routeMeta')     as HTMLSpanElement
const routeList   = document.getElementById('route-list')    as HTMLOListElement

const providerBtn       = document.getElementById('providerBtn')       as HTMLButtonElement
const providerIndicator = document.getElementById('providerIndicator') as HTMLSpanElement

const scanBtn       = document.getElementById('scanBtn')       as HTMLButtonElement
const scanFileInput = document.getElementById('scanFileInput') as HTMLInputElement

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
    markRouteStale()
    scheduleSave()
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
        coord = await getGeocoder().geocode(coord.label, startCoords ?? undefined)
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

      getGeocoder().suggest(query, signal, startCoords ?? undefined)
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
interface AddControlOptions {
  existingId?: number
  prefill?:   string
  note?:      string | null
  scanned?:   boolean
  verified?:  boolean
  focus?:     boolean
}

function clearScannedFlag(id: number): void {
  const meta = controlMeta.get(id)
  if (!meta || meta.source !== 'scanned' || meta.verified) return
  meta.verified = true
  controlsList
    .querySelector(`.control-row[data-id="${id}"]`)
    ?.classList.remove('control-row--scanned')
}

function addControl(opts: AddControlOptions = {}): void {
  const id = opts.existingId ?? ++controlCount

  const row = document.createElement('div')
  row.className = 'control-row'
  row.dataset['id'] = String(id)

  const indexSpan = document.createElement('span')
  indexSpan.className = 'control-index'
  indexSpan.textContent = String(id).padStart(2, '0')

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
  if (opts.prefill) input.value = opts.prefill

  if (opts.scanned) {
    controlMeta.set(id, {
      source:   'scanned',
      note:     opts.note ?? null,
      verified: opts.verified ?? false,
    })
    if (!(opts.verified ?? false)) row.classList.add('control-row--scanned')
  }

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.className = 'remove-btn'
  removeBtn.textContent = '✕'
  removeBtn.addEventListener('click', () => removeControl(id))

  inputRow.appendChild(cursor)
  inputRow.appendChild(input)
  wrap.appendChild(inputRow)

  if (opts.note) {
    const noteEl = document.createElement('div')
    noteEl.className = 'control-note'
    noteEl.textContent = opts.note
    wrap.appendChild(noteEl)
  }

  row.appendChild(indexSpan)
  row.appendChild(wrap)
  row.appendChild(removeBtn)
  controlsList.appendChild(row)

  input.addEventListener('input', () => {
    controlCoords.delete(id)
    clearScannedFlag(id)
    markRouteStale()
    scheduleSave()
  })
  attachAutocomplete(input, coord => {
    controlCoords.set(id, coord)
    clearScannedFlag(id)
    markRouteStale()
    scheduleSave()
  })

  if (opts.focus !== false) input.focus()
  renumberControls()
  markRouteStale()
}

function removeControl(id: number): void {
  const row = controlsList.querySelector(`.control-row[data-id="${id}"]`)
  if (row) row.remove()
  controlCoords.delete(id)
  controlMeta.delete(id)
  renumberControls()
  markRouteStale()
  scheduleSave()
}

function renumberControls(): void {
  controlsList.querySelectorAll<HTMLElement>('.control-row').forEach((row, i) => {
    const span = row.querySelector('.control-index')
    if (span) span.textContent = String(i + 1).padStart(2, '0')
  })
}

// ── Route meta ───────────────────────────────────────────────────
let displayCtx: { nodes: Coord[]; km: Float64Array; street: boolean } | null = null

function coordKey(c: Coord): string {
  return `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`
}

function routeKm(route: RoutePoint[]): { km: number; street: boolean } {
  if (displayCtx) {
    const m = displayCtx.nodes.length
    const index = new Map(displayCtx.nodes.map((c, i) => [coordKey(c), i]))
    const ids: number[] = []
    for (const p of route) {
      const id = index.get(coordKey(p.coord))
      if (id === undefined) break
      ids.push(id)
    }
    if (ids.length === route.length) {
      let km = 0
      for (let k = 0; k < ids.length - 1; k++)
        km += displayCtx.km[ids[k] * m + ids[k + 1]]
      return { km, street: displayCtx.street }
    }
  }
  let km = 0
  for (let i = 0; i < route.length - 1; i++)
    km += haversineKm(route[i].coord, route[i + 1].coord)
  return { km, street: false }
}

let optimizedKm: number | null = null

function setRouteMeta(route: RoutePoint[]): void {
  const { km, street } = routeKm(route)
  const n = route.length - 2
  const baseline =
    optimizedKm !== null && Math.abs(km - optimizedKm) > 0.05
      ? ` (OPT ${optimizedKm.toFixed(1)})`
      : ''
  routeMeta.textContent =
    `${n} CONTROL${n !== 1 ? 'S' : ''} — ${km.toFixed(1)} KM${street ? '' : ' (AIR)'}${baseline}`
}

function markRouteStale(): void {
  if (!resolvedRoute) return
  exportBtn.disabled = true
  routeBlock.classList.add('block--stale')
  setStatus('ROUTE OUT OF DATE — RE-OPTIMIZE', 'warn')
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
  setRouteMeta(resolvedRoute)
  scheduleSave()
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

function gpxDocument(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Checkpoint"\n` +
    `     xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata>\n` +
    `    <name>Alleycat Route</name>\n` +
    `    <time>${new Date().toISOString()}</time>\n` +
    `  </metadata>\n` +
    body +
    `</gpx>`
  )
}

function wptXml(p: RoutePoint): string {
  return (
    `  <wpt lat="${p.coord.lat.toFixed(6)}" lon="${p.coord.lon.toFixed(6)}">\n` +
    `    <name>${escapeXml(p.label)}</name>\n` +
    `  </wpt>`
  )
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

  return gpxDocument(
    waypoints.map(wptXml).join('\n') + '\n' +
    `  <trk>\n` +
    `    <name>Alleycat Route</name>\n` +
    `    <trkseg>\n` +
    trkpts + '\n' +
    `    </trkseg>\n` +
    `  </trk>\n`
  )
}

function buildRouteOnlyGPX(waypoints: RoutePoint[]): string {
  const rtepts = waypoints
    .map(
      p =>
        `    <rtept lat="${p.coord.lat.toFixed(6)}" lon="${p.coord.lon.toFixed(6)}">\n` +
        `      <name>${escapeXml(p.label)}</name>\n` +
        `    </rtept>`
    )
    .join('\n')

  return gpxDocument(
    waypoints.map(wptXml).join('\n') + '\n' +
    `  <rte>\n` +
    `    <name>Alleycat Route</name>\n` +
    rtepts + '\n' +
    `  </rte>\n`
  )
}

async function exportGPX(gpxString: string): Promise<void> {
  const filename = `checkpoint-${Date.now()}.gpx`
  const file = new File([gpxString], filename, { type: 'application/octet-stream' })

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

// ── Manifest scan ─────────────────────────────────────────────────
let scanInFlight = false

function existingControlValues(): string[] {
  return Array.from(controlsList.querySelectorAll<HTMLInputElement>('.control-row input'))
    .map(i => i.value.trim())
    .filter(v => v.length > 0)
}

async function runScan(file: File): Promise<void> {
  if (scanInFlight) return
  scanInFlight = true
  scanBtn.disabled = true
  scanBtn.textContent = '▣ SCANNING...'
  setStatus('SCANNING MANIFEST — KEEP ENTERING CONTROLS', 'busy')

  try {
    const hint = startInput.value.trim()
      || (startCoords ? `${startCoords.lat.toFixed(4)}, ${startCoords.lon.toFixed(4)}` : null)

    const result = await scanManifest(file, hint)
    const cityTok = cityTokenSet(result.city)

    let added = 0, low = 0, skipped = 0
    for (const cp of result.checkpoints) {
      // Re-read existing rows on every iteration: the racer may have typed a
      // new control while this loop's earlier rows were being added, and
      // earlier scanned rows must dedupe against later ones in this batch.
      if (existingControlValues().some(v => isDuplicate(v, cp.name, cityTok))) {
        skipped++
        continue
      }
      addControl({
        prefill: labelWithCity(cp.name, result.city),
        note:    cp.note,
        scanned: true,
        focus:   false,
      })
      added++
      if (cp.confidence === 'low') low++
    }

    scheduleSave()
    const reoptimize = resolvedRoute !== null && added > 0 ? ' — RE-OPTIMIZE TO INCLUDE' : ''
    if (added === 0 && skipped === 0) {
      setStatus('[WARN] NO CHECKPOINTS FOUND — RETAKE PHOTO OR ENTER MANUALLY', 'warn')
    } else {
      const parts = [`${added} SCANNED`]
      if (skipped > 0) parts.push(`${skipped} DUPES SKIPPED`)
      if (low > 0)     parts.push(`${low} LOW CONFIDENCE`)
      setStatus(`[OK] ${parts.join(' — ')} — VERIFY AMBER ROWS${reoptimize}`, low > 0 ? 'warn' : 'ok')
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'SCAN FAILED'
    setStatus(`[ERR] ${msg} — CONTINUE MANUAL ENTRY`, 'error')
  } finally {
    scanInFlight = false
    scanBtn.disabled = false
    scanBtn.textContent = '▣ SCAN MANIFEST'
    scanFileInput.value = ''
  }
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
      resolvedStart = await getGeocoder().geocode(startVal, finishCoords ?? undefined)
      startCoords = resolvedStart
      needsDelay = true
    }

    let resolvedFinish: Coord
    if (finishCoords) {
      resolvedFinish = finishCoords
    } else {
      setStatus('GEOCODING FINISH...', 'busy')
      if (needsRateLimit() && needsDelay) await delay(1100)
      resolvedFinish = await getGeocoder().geocode(finishVal, resolvedStart)
      finishCoords = resolvedFinish
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
        const coord = await getGeocoder().geocode(value, resolvedStart)
        controlCoords.set(id, coord)
        resolvedControls.push(coord)
        needsDelay = true
      }
    }

    setStatus('OPTIMIZING ROUTE...', 'busy')
    const nodes = [resolvedStart, ...resolvedControls, resolvedFinish]
    const street = await fetchCyclingMatrix(nodes)
    const objective = street ? street.seconds : buildAirMatrix(nodes)
    const order = optimizeOrder(objective, resolvedControls.length)
    displayCtx = street ? { nodes, km: street.km, street: true } : null

    resolvedRoute = [
      { coord: resolvedStart,  role: 'start',   label: shortLabel(resolvedStart.label),  controlId: null },
      ...order.map(i => ({
        coord: resolvedControls[i],
        role: 'control' as PointRole,
        label: shortLabel(resolvedControls[i].label),
        controlId: controlEntries[i].id,
      })),
      { coord: resolvedFinish, role: 'finish',  label: shortLabel(resolvedFinish.label), controlId: null },
    ]

    routeBlock.classList.remove('hidden')
    routeBlock.classList.remove('block--stale')
    if (!mapInstance) initMap()
    buildRouteList(resolvedRoute)
    renderMap(resolvedRoute)

    optimizedKm = routeKm(resolvedRoute).km
    setRouteMeta(resolvedRoute)
    exportBtn.disabled = false
    setStatus(
      street
        ? '[OK] ROUTE READY (STREET-ROUTED) — REORDER IF NEEDED'
        : '[OK] ROUTE READY (AIR DISTANCES) — REORDER IF NEEDED',
      'ok'
    )
    routeBlock.scrollIntoView({ behavior: 'smooth' })
    scheduleSave()

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
    let gpx: string
    let trackless = false
    try {
      const trackPoints = await fetchRoute(resolvedRoute.map(p => p.coord))
      gpx = buildRoutedGPX(trackPoints, resolvedRoute)
    } catch {
      gpx = buildRouteOnlyGPX(resolvedRoute)
      trackless = true
    }
    await exportGPX(gpx)
    setStatus(
      trackless ? '[OK] EXPORTED WITHOUT TRACK — WAHOO WILL ROUTE' : '[OK] GPX EXPORTED',
      'ok'
    )
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
addBtn.addEventListener('click', () => addControl())
scanBtn.addEventListener('click', () => scanFileInput.click())
scanFileInput.addEventListener('change', () => {
  const file = scanFileInput.files?.[0]
  if (file) void runScan(file)
})
optimizeBtn.addEventListener('click', () => { void runOptimize() })
exportBtn.addEventListener('click', () => { void runExport() })
clearBtn.addEventListener('click', () => {
  if (!confirm('Start a new session? All checkpoints will be cleared.')) return
  clearState()
  clearMatrixCache()
  displayCtx = null
  location.reload()
})

startInput.addEventListener('input', () => {
  markRouteStale()
  if (startInput.value.trim().length > 0 && startCoords) {
    startCoords = null
    gpsBtn.classList.remove('locked')
    gpsBtnLabel.textContent = 'ACQUIRE GPS SIGNAL'
    startInput.placeholder = 'E.G. BROAD & GIRARD, PHILADELPHIA'
    scheduleSave()
  }
})

finishInput.addEventListener('input', () => {
  markRouteStale()
  if (finishInput.value.trim().length > 0 && finishCoords) {
    finishCoords = null
    scheduleSave()
  }
})

attachAutocomplete(startInput,  coord => { startCoords  = coord; markRouteStale(); scheduleSave() })
attachAutocomplete(finishInput, coord => { finishCoords = coord; markRouteStale(); scheduleSave() })

// ── Restore or init ───────────────────────────────────────────────
function applyState(saved: Pick<PersistedState, 'startCoords' | 'startLabel' | 'finishCoords' | 'finishLabel' | 'controls' | 'controlCount' | 'resolvedRoute'>): void {
  startCoords  = saved.startCoords
  finishCoords = saved.finishCoords
  controlCount = saved.controlCount

  if (saved.startLabel)  startInput.value  = saved.startLabel
  if (saved.finishLabel) finishInput.value = saved.finishLabel

  if (saved.startCoords?.label === 'Current Location') {
    gpsBtn.classList.add('locked')
    gpsBtnLabel.textContent = `GPS LOCKED — ${saved.startCoords.lat.toFixed(4)}, ${saved.startCoords.lon.toFixed(4)}`
  }

  saved.controls.forEach(ctrl => {
    addControl({
      existingId: ctrl.id,
      prefill:    ctrl.inputLabel || undefined,
      note:       ctrl.note ?? null,
      scanned:    ctrl.source === 'scanned',
      verified:   ctrl.verified ?? false,
      focus:      false,
    })
    if (ctrl.coord) controlCoords.set(ctrl.id, ctrl.coord)
  })

  if (saved.resolvedRoute) {
    resolvedRoute = saved.resolvedRoute
    routeBlock.classList.remove('hidden')
    if (!mapInstance) initMap()
    buildRouteList(resolvedRoute)
    renderMap(resolvedRoute)
    setRouteMeta(resolvedRoute)
    exportBtn.disabled = false
  }
}

function restoreFromSaved(): boolean {
  const fromURL = loadShareURL()
  if (fromURL) {
    const full: PersistedState = {
      version:       1,
      savedAt:       Date.now(),
      startLabel:    fromURL.startLabel    ?? '',
      startCoords:   fromURL.startCoords   ?? null,
      finishLabel:   fromURL.finishLabel   ?? '',
      finishCoords:  fromURL.finishCoords  ?? null,
      controls:      fromURL.controls      ?? [],
      controlCount:  fromURL.controlCount  ?? 0,
      resolvedRoute: null,
    }
    saveState(full)
    history.replaceState(null, '', location.pathname)
    applyState(full)
    return true
  }

  const saved = loadState()
  if (!saved) return false
  applyState(saved)
  return true
}

if (!restoreFromSaved()) addControl()

shareBtn.addEventListener('click', () => {
  persistCurrentState()
  const snap: PersistedState = {
    version:       1,
    savedAt:       Date.now(),
    startLabel:    startInput.value,
    startCoords,
    finishLabel:   finishInput.value,
    finishCoords,
    controls:      collectControls(),
    controlCount,
    resolvedRoute,
  }
  const url = buildShareURL(snap)
  navigator.clipboard.writeText(url).then(() => {
    setStatus('[OK] SHARE LINK COPIED TO CLIPBOARD', 'ok')
  }).catch(() => {
    setStatus('[ERR] CLIPBOARD UNAVAILABLE — COPY URL MANUALLY', 'error')
  })
})

// ── Provider toggle ───────────────────────────────────────────────
function updateProviderUI(): void {
  if (getProviderName() === 'google') {
    providerIndicator.textContent = '◉ GOOGLE'
    providerBtn.classList.add('provider-google')
  } else {
    providerIndicator.textContent = '◎ MAPBOX'
    providerBtn.classList.remove('provider-google')
  }
}

providerBtn.addEventListener('click', () => {
  const next: ProviderName = getProviderName() === 'google' ? 'mapbox' : 'google'
  try {
    switchProvider(next)
    setStatus(`[OK] ${next.toUpperCase()} GEOCODER ACTIVE`, 'ok')
  } catch {
    setStatus(`[ERR] ${next.toUpperCase()} GEOCODER NOT CONFIGURED`, 'error')
  }
  updateProviderUI()
})

updateProviderUI()

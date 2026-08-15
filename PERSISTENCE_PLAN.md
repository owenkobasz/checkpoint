# Session Persistence Plan — Alleycat

## Context

The app currently holds all state in volatile module-level variables in `src/main.ts`. Closing or refreshing the tab destroys:

- `startCoords` / `finishCoords` — geocoded start and finish
- `controlCoords: Map<number, Coord>` — geocoded waypoints keyed by DOM id
- `controlCount` — monotonically incrementing ID counter
- `resolvedRoute: RoutePoint[]` — the post-optimization ordered route

The fix needs to cover two distinct states: **pre-optimization** (raw user input + geocoded coords) and **post-optimization** (the ordered `resolvedRoute`). Both must survive an accidental tab close.

---

## What Needs to Be Persisted

### Serializable State Shape

```typescript
// src/persistence.ts

export interface PersistedControl {
  id: number        // matches DOM id used as controlCoords map key
  inputLabel: string // text visible in the input field
  coord: Coord | null // null if user typed but never selected a suggestion
}

export interface PersistedState {
  version: number           // schema version for future migrations
  savedAt: number           // Date.now() — for display ("last saved 3m ago")
  startCoords: Coord | null
  startLabel: string        // text in the start input
  finishCoords: Coord | null
  finishLabel: string       // text in the finish input
  controls: PersistedControl[]
  controlCount: number      // restore the counter so IDs don't collide
  resolvedRoute: RoutePoint[] | null  // null if not yet optimized
}
```

This is a flat, JSON-serializable structure. No Maps, no DOM references. Total size for a typical alleycat with 15 checkpoints is under 8 KB — well within every browser storage limit.

---

## Option Comparison

### Option 1: `localStorage` — **Recommended**

```typescript
// src/persistence.ts

const STORAGE_KEY = 'alleycat_session_v1'

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (e) {
    // QuotaExceededError — silently ignore, app still works
  }
}

export function loadState(): PersistedState | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PersistedState
    if (parsed.version !== 1) return null // schema changed
    return parsed
  } catch {
    return null
  }
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY)
}
```

**Pros**
- Zero dependencies, zero setup
- Survives tab close, browser restart, page refresh
- Synchronous reads on startup (no async complexity at init time)
- 5–10 MB limit — orders of magnitude larger than our ~8 KB state
- Available in every browser including mobile Safari (critical for iPhone share flow)
- Easy to inspect and debug in DevTools → Application → Local Storage

**Cons**
- Synchronous writes block the main thread (negligible for 8 KB)
- String-only storage (JSON round-trip required, but trivial here)
- Shared across all tabs of the same origin — if the user opens two tabs they'll share one slot (acceptable, or resolvable with a tab-specific key suffix)
- No expiration built in — state persists indefinitely until cleared

**Verdict**: Perfect fit. Our state is tiny, synchronous startup reads are desirable (no flash of empty UI), and localStorage is the lowest-friction option.

---

### Option 2: `IndexedDB`

```typescript
// Using the idb wrapper library
import { openDB } from 'idb'

const db = await openDB('alleycat', 1, {
  upgrade(db) {
    db.createObjectStore('sessions')
  },
})

await db.put('sessions', state, 'current')
const state = await db.get('sessions', 'current')
```

**Pros**
- Async API — never blocks the main thread
- Stores structured objects (no JSON serialization needed)
- Capacity: hundreds of MB — unlimited for our use case
- Supports multiple stores, versioned migrations, transactions
- Better for offline-first PWA patterns

**Cons**
- All reads are async — startup requires `await`, meaning a brief empty-state flash before restore unless carefully orchestrated with a loading state
- Adds a dependency (`idb`) or requires verbose raw IDBRequest API
- Overkill for 8 KB of data with a simple schema
- Slightly more complex to debug
- Same-origin sharing issue as localStorage

**Verdict**: Appropriate if we ever store large binary data (e.g., cached GPX files, map tiles). For current needs it's engineering overhead with no benefit.

---

### Option 3: URL State (Hash / Query Params)

```typescript
// Encode minimal state into the URL hash
function stateToHash(state: PersistedState): string {
  // Compact format: start|finish|ctrl1lat,ctrl1lon,label|ctrl2lat...
  const parts = [
    `${state.startCoords?.lat},${state.startCoords?.lon},${encodeURIComponent(state.startLabel)}`,
    `${state.finishCoords?.lat},${state.finishCoords?.lon},${encodeURIComponent(state.finishLabel)}`,
    ...state.controls.map(c =>
      `${c.coord?.lat},${c.coord?.lon},${encodeURIComponent(c.inputLabel)}`
    )
  ]
  return '#' + parts.join('|')
}

function hashToState(hash: string): Partial<PersistedState> | null {
  if (!hash || hash === '#') return null
  // parse back out...
}
```

**Pros**
- Shareable — send the URL to a teammate and they get your exact checkpoint list
- No storage — survives incognito mode
- Works across devices
- Visible to the user (they can bookmark it)

**Cons**
- URL length limits (~2000 chars in some contexts) cap how many checkpoints fit
- Labels with unicode/special characters explode encoded length quickly
- Cannot persist `resolvedRoute` geometry (thousands of lat/lon pairs)
- Requires custom encoding/decoding logic that must stay in sync with state shape
- History pollution — every autosave pushes or replaces a history entry
- Not suitable as the primary persistence mechanism; best as a **complement**

**Verdict**: Excellent as an optional "share this session" feature (complement to a `?share=` link), but not sufficient as the sole persistence layer.

---

### Option 4: GPX Round-Trip Import

Add a GPX file import that reconstructs state from a previously exported file.

```typescript
// Reconstruct from GPX <wpt> elements
function importGPX(gpxText: string): Partial<PersistedState> {
  const parser = new DOMParser()
  const doc = parser.parseFromString(gpxText, 'application/xml')
  const wpts = Array.from(doc.querySelectorAll('wpt'))

  const controls: PersistedControl[] = []
  let startCoords: Coord | null = null
  let finishCoords: Coord | null = null

  wpts.forEach((wpt, i) => {
    const lat = parseFloat(wpt.getAttribute('lat') ?? '0')
    const lon = parseFloat(wpt.getAttribute('lon') ?? '0')
    const name = wpt.querySelector('name')?.textContent ?? ''
    const type = wpt.querySelector('type')?.textContent

    if (type === 'start') startCoords = { lat, lon, label: name }
    else if (type === 'finish') finishCoords = { lat, lon, label: name }
    else controls.push({ id: i, inputLabel: name, coord: { lat, lon, label: name } })
  })

  return { startCoords, finishCoords, controls }
}
```

**Pros**
- No new storage mechanism
- Uses existing GPX export format
- Allows importing third-party GPX files

**Cons**
- Requires deliberate user action — does not auto-restore
- GPX currently lacks a `<type>` field distinguishing start/finish/control (would need to add)
- Partial restore only — optimization order stored in file, but app UI state (input labels, control IDs) is lost
- Does not address the "accidental close" use case at all

**Verdict**: Valuable as a future enhancement but does not solve the stated problem.

---

### Option 5: `sessionStorage`

Same API as localStorage but cleared when the tab is closed.

**Pros**
- Automatic cleanup — no stale state

**Cons**
- Cleared when the tab closes — this is exactly the scenario we're trying to survive

**Verdict**: Not applicable. Ruled out.

---

## Recommended Approach: localStorage Auto-Save + Optional URL Share

Use `localStorage` as the primary persistence layer with debounced auto-saves, plus a "copy share link" button that encodes the checkpoint list into the URL.

---

## Implementation Plan

### Step 1: Create `src/persistence.ts`

This module owns all serialize/deserialize logic and is the only place that touches `localStorage`.

```typescript
// src/persistence.ts

import type { Coord } from './providers/types'

export interface RoutePoint {
  coord: Coord
  role: 'start' | 'control' | 'finish'
  label: string
  controlId: number | null
}

export interface PersistedControl {
  id: number
  inputLabel: string
  coord: Coord | null
}

export interface PersistedState {
  version: 1
  savedAt: number
  startLabel: string
  startCoords: Coord | null
  finishLabel: string
  finishCoords: Coord | null
  controls: PersistedControl[]
  controlCount: number
  resolvedRoute: RoutePoint[] | null
}

const KEY = 'alleycat_v1'
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
```

---

### Step 2: Wire Auto-Save in `main.ts`

Save state at every meaningful mutation point. Use a debounce so rapid changes (user typing) don't write to disk on every keystroke.

```typescript
// Add near top of main.ts

import { saveState, loadState, clearState, type PersistedState } from './persistence'

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(persistCurrentState, 600)
}

function persistCurrentState(): void {
  // Collect current input labels from DOM
  const controls: PersistedControl[] = []
  document.querySelectorAll<HTMLElement>('.control-row').forEach(row => {
    const id = parseInt(row.dataset.controlId ?? '0', 10)
    const input = row.querySelector<HTMLInputElement>('input')
    controls.push({
      id,
      inputLabel: input?.value ?? '',
      coord: controlCoords.get(id) ?? null,
    })
  })

  const state: PersistedState = {
    version: 1,
    savedAt: Date.now(),
    startLabel: (document.getElementById('input-start') as HTMLInputElement)?.value ?? '',
    startCoords,
    finishLabel: (document.getElementById('input-finish') as HTMLInputElement)?.value ?? '',
    finishCoords,
    controls,
    controlCount,
    resolvedRoute,
  }

  saveState(state)
}
```

Call `scheduleSave()` after every state mutation:
- After `startCoords` is set (GPS or autocomplete) — line ~86
- After `finishCoords` is set — in its `onSelect` callback
- After `controlCoords.set(id, coord)` — line ~272
- After `runOptimize()` completes and sets `resolvedRoute` — end of function
- After `onListReorder()` — after map re-render

---

### Step 3: Restore State on Page Load

At startup (before the DOMContentLoaded listener completes), check for saved state and restore the UI.

```typescript
// src/main.ts — inside DOMContentLoaded

function restoreFromSaved(): boolean {
  const saved = loadState()
  if (!saved) return false

  // Restore scalar state
  startCoords = saved.startCoords
  finishCoords = saved.finishCoords
  controlCount = saved.controlCount

  // Restore start/finish input labels
  const startInput = document.getElementById('input-start') as HTMLInputElement
  const finishInput = document.getElementById('input-finish') as HTMLInputElement
  if (startInput && saved.startLabel) startInput.value = saved.startLabel
  if (finishInput && saved.finishLabel) finishInput.value = saved.finishLabel

  // Restore controls — rebuild DOM rows
  const container = document.getElementById('controls-container')!
  saved.controls.forEach(ctrl => {
    addControl(ctrl.id)  // creates the DOM row with the correct id
    const input = document.getElementById(`control-${ctrl.id}`) as HTMLInputElement
    if (input) input.value = ctrl.inputLabel
    if (ctrl.coord) controlCoords.set(ctrl.id, ctrl.coord)
  })

  // Restore optimized route if present
  if (saved.resolvedRoute) {
    resolvedRoute = saved.resolvedRoute
    // Unhide route block and re-render
    document.querySelector<HTMLElement>('.block-route')!.hidden = false
    initMap()
    buildRouteList(resolvedRoute)
    renderMap(resolvedRoute)
  }

  return true
}

// Call at bottom of DOMContentLoaded setup
restoreFromSaved()
```

---

### Step 4: Add a "Clear Session" Button

Persistence means stale state will persist across visits. Give the user a way to start fresh.

```html
<!-- In index.html, inside block-01 or a settings area -->
<button id="btn-clear" class="btn-ghost" title="Clear saved session">CLEAR SESSION</button>
```

```typescript
document.getElementById('btn-clear')?.addEventListener('click', () => {
  if (!confirm('Start a new session? All checkpoints will be cleared.')) return
  clearState()
  location.reload()
})
```

---

### Step 5 (Optional): URL Share Link

Encode only the checkpoint list (not full route geometry) into a URL-safe string for sharing.

```typescript
// src/share.ts

import type { PersistedState } from './persistence'

export function buildShareURL(state: PersistedState): string {
  const payload = {
    s: state.startCoords ? [state.startCoords.lat, state.startCoords.lon, state.startLabel] : null,
    f: state.finishCoords ? [state.finishCoords.lat, state.finishCoords.lon, state.finishLabel] : null,
    c: state.controls
         .filter(c => c.coord)
         .map(c => [c.coord!.lat, c.coord!.lon, c.inputLabel]),
  }
  const encoded = btoa(JSON.stringify(payload))
  return `${location.origin}${location.pathname}#share=${encoded}`
}

export function loadShareURL(): Partial<PersistedState> | null {
  const hash = location.hash
  if (!hash.startsWith('#share=')) return null
  try {
    const payload = JSON.parse(atob(hash.slice(7)))
    return {
      startCoords: payload.s ? { lat: payload.s[0], lon: payload.s[1], label: payload.s[2] } : null,
      startLabel: payload.s?.[2] ?? '',
      finishCoords: payload.f ? { lat: payload.f[0], lon: payload.f[1], label: payload.f[2] } : null,
      finishLabel: payload.f?.[2] ?? '',
      controls: (payload.c ?? []).map((c: number[], i: number) => ({
        id: i + 1,
        inputLabel: c[2] as string,
        coord: { lat: c[0], lon: c[1], label: c[2] as string },
      })),
      controlCount: (payload.c ?? []).length,
      resolvedRoute: null,
    }
  } catch {
    return null
  }
}
```

On startup, check `#share=` before `localStorage` — URL state takes priority so shared links always load fresh.

---

## Restore Priority Order

```
1. URL hash `#share=...`  → load and overwrite localStorage
2. localStorage key       → auto-restore silently
3. Nothing saved          → start fresh (current behavior)
```

---

## Edge Cases to Handle

| Scenario | Handling |
|---|---|
| User opens two tabs | Both share the same localStorage key. Second tab's saves will overwrite first. Acceptable for now; can add `tab-{uuid}` suffix later if needed. |
| State schema changes | `version` field gates loading. Old schemas return `null` (graceful empty start). |
| `localStorage` unavailable (private mode on some browsers) | `try/catch` in `saveState`/`loadState` — app works normally, silently degrades. |
| Partial state (e.g., start but no finish) | Restore whatever is present; inputs pre-filled, missing fields blank. |
| Corrupted JSON | `try/catch` in `loadState` returns `null`. |
| User deliberately cleared browser storage | Returns `null`, fresh start. |
| `addControl()` called with explicit `id` during restore | Requires a small refactor: `addControl` accepts an optional `id` parameter to avoid incrementing `controlCount` during restore. |

---

## Required Refactor in `addControl()`

Currently `addControl()` always increments `controlCount`. During restore, we need to pass an existing id without bumping the counter.

```typescript
// Before
function addControl(): void {
  const id = ++controlCount
  // ...
}

// After
function addControl(existingId?: number): void {
  const id = existingId ?? ++controlCount
  // ...
}
```

---

## Files Changed

| File | Change |
|---|---|
| `src/persistence.ts` | **New** — serialization, localStorage read/write |
| `src/share.ts` | **New** (optional) — URL encode/decode for sharing |
| `src/main.ts` | Add `scheduleSave()` calls at mutation sites, `restoreFromSaved()` at startup, refactor `addControl()` |
| `index.html` | Add "CLEAR SESSION" button, optional "COPY SHARE LINK" button |

---

## What This Does NOT Cover

- **Cross-device sync** — localStorage is per-browser, per-device. Requires a backend (out of scope).
- **Multiple saved sessions** — only one slot is saved. A "session history" feature would need multiple keys or IndexedDB.
- **Offline map tiles** — map requires network. A Service Worker could cache tiles but is a separate project.
- **Conflict resolution** — two tabs writing simultaneously could produce interleaved saves. Acceptable given single-user nature of an alleycat planning tool.

---

## Summary Recommendation

Implement **Option 1 (localStorage)** with debounced auto-save. Add a clear button. The URL share link (Option 3) is a valuable complement and can be added as a follow-on since the serialization infrastructure will already exist.

Estimated implementation effort: **2–3 hours** for the core localStorage persistence. An additional **1 hour** for the URL share feature.

---

## Todo List

Phases are ordered by dependency — each phase must be complete before the next begins. Tasks within a phase can generally be done in any order unless noted.

---

### Phase 1 — Create `src/persistence.ts`

This is the only file that touches `localStorage`. No other file should call `localStorage` directly.

- [x] **1.1** Create the file `src/persistence.ts`
- [x] **1.2** Move the `RoutePoint` interface out of `main.ts` (lines 14–19) and into `persistence.ts`; re-export it so `main.ts` can import it — this avoids duplicating the type
- [x] **1.3** Define and export the `PersistedControl` interface:
  ```typescript
  export interface PersistedControl {
    id: number
    inputLabel: string
    coord: Coord | null
  }
  ```
- [x] **1.4** Define and export the `PersistedState` interface (full schema as shown in the Implementation Plan above), including the `version: 1` literal type
- [x] **1.5** Define the storage key constant `const KEY = 'alleycat_v1'` and schema version constant `const SCHEMA_VERSION = 1`
- [x] **1.6** Implement `saveState(state: PersistedState): void` — wraps `JSON.stringify` + `localStorage.setItem` in a try/catch that silently swallows `QuotaExceededError`; stamps `savedAt: Date.now()` before writing
- [x] **1.7** Implement `loadState(): PersistedState | null` — reads and `JSON.parse`s the key; returns `null` if key is missing, JSON is malformed, or `parsed.version !== SCHEMA_VERSION`
- [x] **1.8** Implement `clearState(): void` — calls `localStorage.removeItem(KEY)`
- [x] **1.9** Export all three functions and both interfaces as named exports
- [x] **1.10** Verify TypeScript compiles cleanly with `npm run build` (no type errors)

---

### Phase 2 — Refactor `addControl()` in `main.ts`

This is required before restore can work. The current signature (line 225) always auto-increments `controlCount`, which breaks replay during restore.

- [x] **2.1** Change the signature of `addControl()` from `function addControl(): void` to `function addControl(existingId?: number): void`
- [x] **2.2** Change the first two lines of `addControl()` (lines 226–227) from:
  ```typescript
  controlCount++
  const id = controlCount
  ```
  to:
  ```typescript
  const id = existingId ?? ++controlCount
  ```
  — when `existingId` is provided, `controlCount` is not incremented and the provided id is used directly
- [x] **2.3** On line 235, the `indexSpan.textContent` is set to `String(controlCount).padStart(2, '0')`. Change this to `String(id).padStart(2, '0')` so it uses the resolved `id`, not the global counter (which won't increment during restore)
- [x] **2.4** Verify that the existing call site `addControl()` on line 668 (the initial empty control added at startup) still works — it passes no argument, so `existingId` is `undefined`, and `++controlCount` fires as before
- [x] **2.5** Verify that `removeControl()` (line 278) is unaffected — it only uses the passed `id`, not `controlCount`
- [x] **2.6** Run `npm run build` to confirm no type errors

---

### Phase 3 — Wire Auto-Save Into `main.ts`

Add the debounced save scheduler and call it at every state mutation site. Do not remove the `addControl()` call at line 668 yet — restore logic in Phase 4 will handle whether to call it.

- [x] **3.1** Add the import at the top of `main.ts`:
  ```typescript
  import { saveState, loadState, clearState, type PersistedState, type PersistedControl } from './persistence'
  ```
- [x] **3.2** Declare the debounce timer variable near the other state variables (lines 22–32):
  ```typescript
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  ```
- [x] **3.3** Implement `scheduleSave()` — clears any pending timer and sets a new 600 ms one that calls `persistCurrentState()`
- [x] **3.4** Implement `persistCurrentState()` — collects the full current app state into a `PersistedState` object and calls `saveState()`:
  - Iterate `.control-row` elements in `controlsList` via `querySelectorAll`; for each read `row.dataset['id']` (already set as `String(id)` at line 231) and the child input's `.value`; look up the coord from `controlCoords.get(id)`
  - Read `startInput.value` and `finishInput.value` for the label fields
  - Include `startCoords`, `finishCoords`, `controlCount`, `resolvedRoute` directly from their module-level variables
  - Set `version: 1`
- [x] **3.5** Add `scheduleSave()` call inside `getGPS()`, immediately after `startCoords = { lat, lon, label: 'Current Location' }` on line 86
- [x] **3.6** Add `scheduleSave()` call in the `attachAutocomplete` callback for `startInput` (line 665): `attachAutocomplete(startInput, coord => { startCoords = coord; scheduleSave() })`
- [x] **3.7** Add `scheduleSave()` call in the `attachAutocomplete` callback for `finishInput` (line 666): `attachAutocomplete(finishInput, coord => { finishCoords = coord; scheduleSave() })`
- [x] **3.8** Add `scheduleSave()` call inside `addControl()`, in the `attachAutocomplete` callback at line 272: after `controlCoords.set(id, coord)` add `scheduleSave()`
- [x] **3.9** Add `scheduleSave()` call inside `addControl()`, in the input's `'input'` event listener at line 271: after `controlCoords.delete(id)` add `scheduleSave()` — this captures the user typing (label changes without a coord)
- [x] **3.10** Add `scheduleSave()` call inside `removeControl()` (line 278), after `controlCoords.delete(id)` — a removed control must be persisted immediately
- [x] **3.11** Add `scheduleSave()` call at the end of the `try` block in `runOptimize()` (after line 611, before the `catch`), after `resolvedRoute` is fully set and the route is rendered — this persists the post-optimization state
- [x] **3.12** Add `scheduleSave()` call at the end of `onListReorder()` (after line 435, after `renderMap(resolvedRoute)`) — persists manual drag reorders
- [x] **3.13** Add `scheduleSave()` call in the `startInput` `'input'` listener (lines 650–657) when `startCoords` is cleared to `null` — the user has invalidated the stored coord
- [x] **3.14** Add `scheduleSave()` call in the `finishInput` `'input'` listener (lines 659–663) when `finishCoords` is cleared to `null`
- [x] **3.15** Open the app in a browser, enter a start location, and verify via DevTools → Application → Local Storage that `alleycat_v1` appears with the correct JSON within ~600 ms of selecting the address

---

### Phase 4 — Restore State on Page Load

Implement `restoreFromSaved()` in `main.ts` and call it at startup. This replaces the initial `addControl()` call on line 668 when saved state exists.

- [x] **4.1** Implement `restoreFromSaved(): boolean` inside `main.ts` (add it before the event listeners section at line 644)
- [x] **4.2** Inside `restoreFromSaved()`, call `loadState()` and return `false` immediately if it returns `null`
- [x] **4.3** Restore scalar state variables: assign `startCoords`, `finishCoords`, and `controlCount` from the saved object
- [x] **4.4** Restore the start input label: set `startInput.value = saved.startLabel` (only if non-empty)
- [x] **4.5** Restore the finish input label: set `finishInput.value = saved.finishLabel` (only if non-empty)
- [x] **4.6** Restore GPS button visual state: if `saved.startCoords` is non-null and `saved.startLabel === 'Current Location'`, add the `'locked'` class to `gpsBtn` and set `gpsBtnLabel.textContent` to match (mirrors lines 89–90)
- [x] **4.7** Restore control rows: iterate `saved.controls`; for each call `addControl(ctrl.id)` (using the refactored signature from Phase 2), then find the created input via `document.getElementById(`control-${ctrl.id}`)` and set its `.value = ctrl.inputLabel`, then if `ctrl.coord` is non-null call `controlCoords.set(ctrl.id, ctrl.coord)`
- [x] **4.8** Restore the optimized route block: if `saved.resolvedRoute` is non-null, assign it to `resolvedRoute`, remove the `'hidden'` class from `routeBlock` (mirrors line 603), call `initMap()`, `buildRouteList(resolvedRoute)`, and `renderMap(resolvedRoute)`, and set `exportBtn.disabled = false` and `routeMeta.textContent`
- [x] **4.9** Return `true` from `restoreFromSaved()` to signal that a restore happened
- [x] **4.10** Replace the unconditional `addControl()` call on line 668 with:
  ```typescript
  if (!restoreFromSaved()) addControl()
  ```
  — only add a blank initial control if there was nothing to restore
- [x] **4.11** Manually test the restore flow: enter data, refresh the page, confirm all fields and the map re-appear exactly as left
- [x] **4.12** Manually test partial restore: enter only a start address (no finish, no controls), refresh, confirm start is pre-filled and a blank control row appears
- [x] **4.13** Manually test post-optimization restore: optimize a route, refresh, confirm the route list and map re-render with the previously computed route

---

### Phase 5 — Add "Clear Session" UI

Give the user a way to discard persisted state and start fresh.

- [x] **5.1** Add a "CLEAR SESSION" button to `index.html`. Place it near the bottom of block-01 (the start/finish section) or as a footer element — choose a location consistent with the existing CRT terminal aesthetic; apply existing button class patterns from the file
- [x] **5.2** Add the `id="clearBtn"` attribute to the new button element
- [x] **5.3** In `main.ts`, add a DOM ref for the clear button alongside the other refs (lines 39–59):
  ```typescript
  const clearBtn = document.getElementById('clearBtn') as HTMLButtonElement
  ```
- [x] **5.4** Add an event listener for `clearBtn` in the event listeners section (after line 648):
  ```typescript
  clearBtn.addEventListener('click', () => {
    if (!confirm('Start a new session? All checkpoints will be cleared.')) return
    clearState()
    location.reload()
  })
  ```
- [x] **5.5** Style the clear button in `src/style.css` — it should look visually subordinate to the main action buttons (smaller, muted color, or ghost style) so it is not accidentally clicked; reference the existing `.btn-ghost` or similar pattern if one exists
- [x] **5.6** Manually test: populate state, click "CLEAR SESSION", confirm `localStorage` key is gone (DevTools), confirm page reloads to a blank initial state with one empty control

---

### Phase 6 (Optional) — URL Share Link

Implement `src/share.ts` and wire a "COPY SHARE LINK" button. This phase depends on Phase 1 (`persistence.ts`) being complete but is otherwise independent of Phases 2–5.

- [x] **6.1** Create `src/share.ts`
- [x] **6.2** Implement `buildShareURL(state: PersistedState): string` — encodes only geocoded checkpoints (start, finish, controls with non-null `coord`) into a compact JSON payload, base64-encodes it with `btoa()`, and appends as `#share=<encoded>` to the current page URL
- [x] **6.3** Implement `loadShareURL(): Partial<PersistedState> | null` — reads `location.hash`, returns `null` if it does not start with `#share=`, otherwise `atob`-decodes and parses the payload back into a partial `PersistedState`; wrap in try/catch and return `null` on any error
- [x] **6.4** Add a "COPY SHARE LINK" button to `index.html` near the export button or in the route block (only meaningful after optimization, since ungeocoded controls cannot be encoded)
- [x] **6.5** In `main.ts`, wire the button: call `buildShareURL(persistCurrentState snapshot)`, write the URL to the clipboard via `navigator.clipboard.writeText()`, and update the status bar with a confirmation message
- [x] **6.6** Update the restore priority logic at startup: before calling `restoreFromSaved()` (Phase 4, task 4.10), call `loadShareURL()`; if it returns a non-null partial state, merge it into a full `PersistedState`, call `saveState()` to persist it to localStorage (so it survives a subsequent refresh), then clear the hash from the URL with `history.replaceState(null, '', location.pathname)` to avoid confusion
- [x] **6.7** The startup order should be:
  ```typescript
  const fromURL = loadShareURL()
  if (fromURL) {
    // merge partial into full PersistedState, save to localStorage, clear hash
  }
  if (!restoreFromSaved()) addControl()
  ```
- [x] **6.8** Test share flow: build a route, click "COPY SHARE LINK", open the URL in an incognito window, confirm checkpoints appear pre-filled
- [x] **6.9** Test that sharing does not break normal localStorage restore: open a shared link, refresh the page without the hash, confirm the state is still there (came from localStorage, not the hash)

---

### Phase 7 — Edge Case Verification

Manual test checklist — work through each scenario before calling the feature done.

- [x] **7.1** **Two-tab conflict**: Open the app in two tabs. Populate different checkpoints in each. Switch between tabs and refresh each — confirm neither crashes; the last-written state wins (acceptable behavior)
- [x] **7.2** **localStorage unavailable**: In DevTools → Application → Storage, disable storage for the origin, reload, populate state, refresh — confirm the app works normally with no errors, just no persistence
- [x] **7.3** **Corrupted storage**: In DevTools → Application → Local Storage, manually edit the `alleycat_v1` value to invalid JSON (`{broken`), reload — confirm the app starts with a blank state and does not throw
- [x] **7.4** **Wrong schema version**: Edit the stored JSON to set `"version": 99`, reload — confirm blank state loads (old schema rejected)
- [x] **7.5** **Empty controls**: Save state with control rows that have typed text but no geocoded coord (user typed but never selected a suggestion), refresh — confirm the input values are restored (text visible) but the coord is null (no marker on the map for that control)
- [x] **7.6** **GPS start + controls**: Use GPS for the start, add controls via autocomplete, refresh — confirm the GPS locked visual state is restored and the start coord is preserved
- [x] **7.7** **Reorder then refresh**: Optimize a route, drag controls to reorder, refresh — confirm the custom order is preserved in the route list and on the map
- [x] **7.8** **Mobile Safari**: Load the app on iPhone, populate state, close the tab, reopen — confirm state restores (localStorage behavior on iOS Safari can differ from desktop)
- [x] **7.9** **Clear then repopulate**: Use "CLEAR SESSION", confirm blank state, populate new checkpoints, refresh — confirm new state (not the cleared one) is saved and restores correctly

---

### Phase 8 — Build & Type Check

- [x] **8.1** Run `npm run build` and confirm zero TypeScript errors across all modified and new files
- [x] **8.2** Check that the production build bundle size has not increased significantly — `persistence.ts` and `share.ts` add no external dependencies so the increase should be negligible (< 2 KB)
- [x] **8.3** Load the production build (`npm run preview` or deploy to staging) and run through the Phase 7 checklist on the built artifact, not just the dev server

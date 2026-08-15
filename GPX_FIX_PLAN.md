# GPX Export Fix — Detailed Implementation Plan

## What we're fixing and why

The GPX export lives in two functions in `src/main.ts`:

- `buildRoutedGPX` (line 489) — assembles the XML string
- `exportGPX` (line 527) — triggers the download or share sheet

`buildRoutedGPX` currently produces valid GPX 1.1, but it has four concrete problems that prevent Wahoo ELEMNT from displaying checkpoints correctly. Each problem is independent and fixable in isolation. This doc covers all four in order of impact.

---

## Problem 1 — Start and finish appear as waypoints on the cue sheet

### What the code does

```typescript
// line 499-506 — current
const wpts = waypoints                     // <── ALL RoutePoints, including start/finish
  .map(
    p =>
      `  <wpt lat="${p.coord.lat.toFixed(6)}" lon="${p.coord.lon.toFixed(6)}">\n` +
      `    <name>${escapeXml(p.label)}</name>\n` +
      `  </wpt>`
  )
  .join('\n')
```

`waypoints` is `resolvedRoute` (passed in from `runExport` at line 662), which always has the shape:

```
[ start, control, control, ..., finish ]
```

So the current output looks like:

```xml
<wpt lat="39.952583" lon="-75.163526">
  <name>1500 Market St, Philadelphia</name>   <!-- start — WRONG -->
</wpt>
<wpt lat="39.955212" lon="-75.160433">
  <name>E Market St, Philadelphia</name>       <!-- control 1 — correct -->
</wpt>
<wpt lat="39.948710" lon="-75.158900">
  <name>Broad St, Philadelphia</name>          <!-- finish — WRONG -->
</wpt>
```

### Why it's wrong

**Wahoo infers start and finish from the track geometry itself** — from the first and last `<trkpt>` in the `<trkseg>`. When you also include start and finish as `<wpt>` elements, Wahoo renders them as Custom Waypoints on the cue sheet, so the rider sees duplicate entries:

```
Cue sheet:
  ↑ START        ← from track geometry (correct)
  ● 1500 Market  ← spurious wpt for start (confusing)
  ● E Market St  ← control (correct)
  ● Broad St     ← spurious wpt for finish (confusing)
  ↓ FINISH       ← from track geometry (correct)
```

On Gen 3 devices, the map layer also shows blue pins at start and finish in addition to the start/finish icons Wahoo already renders.

### The fix

Filter `waypoints` to only emit controls:

```typescript
const wpts = waypoints
  .filter(p => p.role === 'control')     // <── only controls
  .map(/* ... */)
  .join('\n')
```

**Why `.role === 'control'` is the right predicate:** `PointRole` is `'start' | 'control' | 'finish'` (defined in `src/persistence.ts:3`). The filter is exhaustive — if a third role is ever added (e.g. `'photo'`), it won't accidentally be included. Filtering by `!== 'start' && !== 'finish'` would be the complement but is more fragile.

---

## Problem 2 — No `<sym>` tag means a generic grey dot on the map

### What the code does

Current `<wpt>` output:

```xml
<wpt lat="39.955212" lon="-75.160433">
  <name>E Market St, Philadelphia</name>
</wpt>
```

### Why it's wrong

Without a `<sym>` element, Wahoo renders waypoints as a featureless grey dot — indistinguishable from background map clutter. The GPX 1.1 spec defines `<sym>` as a freeform symbol name string. Wahoo (and Garmin before it) adopted a shared vocabulary of symbol names. The relevant entries for checkpoints are:

| `<sym>` value | Rendered icon |
|---|---|
| `Flag, Blue` | Blue flag on a pole |
| `Flag, Red` | Red flag on a pole |
| `Flag, Green` | Green flag on a pole |
| `Pin, Blue` | Teardrop pin, blue |
| `Waypoint` | Generic white diamond |

`Flag, Blue` is the best choice for alleycat checkpoints: it's unambiguous on the map, visually distinct from the track line, and recognized by all Wahoo firmware versions tested against GPX imports.

### The fix

Add `<sym>Flag, Blue</sym>` inside every control `<wpt>`:

```xml
<wpt lat="39.955212" lon="-75.160433">
  <name>E Market St, Philadelphia</name>
  <sym>Flag, Blue</sym>
</wpt>
```

**Why the element order matters:** GPX 1.1 schema (`wptType`) defines a specific child element order: `ele`, `time`, `magvar`, `geoidheight`, `name`, `cmt`, `desc`, `src`, `link`, `sym`, `type`, `fix`, ...

`<sym>` must come after `<name>` and `<desc>` in the element sequence. Some validators (and potentially some Wahoo firmware parsers) use schema-ordered parsing. The safe order is:

```xml
<wpt lat="..." lon="...">
  <name>...</name>
  <desc>...</desc>   <!-- if included -->
  <sym>...</sym>
  <type>...</type>   <!-- if included -->
</wpt>
```

**Why not `<sym>Waypoint`?** The generic "Waypoint" symbol renders as a white diamond that blends into the map on light basemaps. `Flag, Blue` is easier to distinguish at a glance while riding.

---

## Problem 3 — No `<type>` tag means no categorization metadata

### What the code does

No `<type>` element is emitted.

### Why it matters

The GPX 1.1 `<type>` element is freeform — it doesn't affect rendering directly, but it's used by route management apps (RideWithGPS, Komoot, Garmin Connect) when they process the file before sending it to the device. Setting `<type>Checkpoint</type>` ensures:

1. If a user imports the GPX into RideWithGPS first and then syncs to Wahoo, the app preserves the waypoints as POIs rather than routing cues
2. If Wahoo ever adds category-based waypoint filtering, checkpoints will be identifiable
3. The file is self-documenting for future tooling

This is a one-liner addition with no downside.

```xml
<wpt lat="..." lon="...">
  <name>E Market St, Philadelphia</name>
  <sym>Flag, Blue</sym>
  <type>Checkpoint</type>
</wpt>
```

---

## Problem 4 — Checkpoint names don't include their sequence number

### What the code does

The `label` on each `RoutePoint` is set during `runOptimize` at line 622:

```typescript
resolvedRoute = [
  { coord: resolvedStart, role: 'start', label: shortLabel(resolvedStart.label), ... },
  ...ordered.map(c => ({
    coord: c,
    role: 'control',
    label: shortLabel(c.label),    // <── just the geocoded address, no index
    ...
  })),
  { coord: resolvedFinish, role: 'finish', label: shortLabel(resolvedFinish.label), ... },
]
```

`shortLabel` takes the geocoded display name and truncates it to the first 3 comma-separated parts:

```
"1234 E Market St, Philadelphia, PA 19107, USA" → "1234 E Market St, Philadelphia, PA 19107"
```

So on the Wahoo cue sheet, the rider sees:

```
● 1234 E Market St, Philadelphia, PA 19107
● 5678 Broad St, Philadelphia, PA 19148
● 900 S 9th St, Philadelphia, PA 19147
```

### Why it's wrong

During a race, the rider can't quickly identify which checkpoint they're approaching. Alleycat checkpoints are usually referenced by number ("CP3 is the tricky one at 9th and Washington"), so the cue sheet should read:

```
● CP1 — 1234 E Market St, Philadelphia
● CP2 — 5678 Broad St, Philadelphia
● CP3 — 900 S 9th St, Philadelphia
```

### The fix

When building the `<wpt>` name, compute the control index (its position among controls only) and prepend it. This is done in the `buildRoutedGPX` function when generating the `wpts` string — not at route-build time — because the label in `RoutePoint` is used elsewhere in the UI (route list, map markers) and we don't want the "CP1 —" prefix showing up in those contexts.

```typescript
const controls = waypoints.filter(p => p.role === 'control')

const wpts = controls
  .map((p, i) => {
    const name = `CP${i + 1} — ${escapeXml(p.label)}`
    return (
      `  <wpt lat="${p.coord.lat.toFixed(6)}" lon="${p.coord.lon.toFixed(6)}">\n` +
      `    <name>${name}</name>\n` +
      `    <sym>Flag, Blue</sym>\n` +
      `    <type>Checkpoint</type>\n` +
      `  </wpt>`
    )
  })
  .join('\n')
```

**Why not modify the `label` field on `RoutePoint` directly?** The label is displayed in the route list (`buildRouteList`, line 402) and in the map marker (`markerIcon`, line 366). Prefixing "CP1 —" there would duplicate information already shown by the `route-item-index` span and the map marker text. The GPX export is the only context where sequence numbering in the name field is useful.

**Why `CP` not `Control`?** Alleycat riders use "CP" universally. "Control 01" reads bureaucratically and wastes character space on the Wahoo's narrow cue-sheet display.

---

## Problem 5 — Minor: branding and filename

Two small cosmetic issues:

### `creator` attribute says "Checkpoint"

```typescript
// line 510 — current
`<gpx version="1.1" creator="Checkpoint"\n` +
```

The app is called **Alleycat**, not Checkpoint. The `creator` attribute identifies the software that generated the file. It appears in GPX viewers, device logs, and anywhere someone inspects the raw file. Should be `"Alleycat"`.

### Filename says "checkpoint-"

```typescript
// line 528 — current
const filename = `checkpoint-${Date.now()}.gpx`
```

Should be `alleycat-${Date.now()}.gpx`.

---

## The Complete Fix

### `buildRoutedGPX` — full replacement (lines 489–525)

Here is the complete updated function with all four fixes applied:

```typescript
function buildRoutedGPX(
  trackPoints: [number, number][],
  waypoints: RoutePoint[]
): string {
  const trkpts = trackPoints
    .map(([lat, lon]) =>
      `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`
    )
    .join('\n')

  // Controls only — start and finish are inferred from track geometry by Wahoo
  const controls = waypoints.filter(p => p.role === 'control')

  const wpts = controls
    .map((p, i) => {
      const name = `CP${i + 1} \u2014 ${escapeXml(p.label)}`
      return (
        `  <wpt lat="${p.coord.lat.toFixed(6)}" lon="${p.coord.lon.toFixed(6)}">\n` +
        `    <name>${name}</name>\n` +
        `    <sym>Flag, Blue</sym>\n` +
        `    <type>Checkpoint</type>\n` +
        `  </wpt>`
      )
    })
    .join('\n')

  // GPX 1.1 schema order: metadata → wpt* → rte* → trk*
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Alleycat"\n` +
    `     xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata>\n` +
    `    <name>Alleycat Route</name>\n` +
    `    <time>${new Date().toISOString()}</time>\n` +
    `  </metadata>\n` +
    (wpts ? wpts + '\n' : '') +
    `  <trk>\n` +
    `    <name>Alleycat Route</name>\n` +
    `    <trkseg>\n` +
    trkpts + '\n' +
    `    </trkseg>\n` +
    `  </trk>\n` +
    `</gpx>`
  )
}
```

**One subtle change in the return:** `wpts + '\n'` becomes `(wpts ? wpts + '\n' : '')`.

The current code always emits `wpts + '\n'`. If there are no controls — which shouldn't happen in normal use but is possible if a user somehow reaches export with only start/finish — the current code emits a bare `'\n'` between `</metadata>` and `<trk>`. That's harmless XML whitespace, but the conditional makes intent explicit and avoids an extra blank line in the output.

### `exportGPX` — filename only (line 528)

```typescript
async function exportGPX(gpxString: string): Promise<void> {
  const filename = `alleycat-${Date.now()}.gpx`   // <── was "checkpoint-"
  // ... rest unchanged
```

---

## What the output looks like after the fix

For a 3-checkpoint route from Love Park → Reading Terminal → City Hall → finish at Penn:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Alleycat"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Alleycat Route</name>
    <time>2026-04-19T14:23:01.000Z</time>
  </metadata>
  <wpt lat="39.952583" lon="-75.163526">
    <name>CP1 — 1500 Market St, Philadelphia, PA</name>
    <sym>Flag, Blue</sym>
    <type>Checkpoint</type>
  </wpt>
  <wpt lat="39.951565" lon="-75.159468">
    <name>CP2 — 51 N 12th St, Philadelphia, PA</name>
    <sym>Flag, Blue</sym>
    <type>Checkpoint</type>
  </wpt>
  <wpt lat="39.952228" lon="-75.163786">
    <name>CP3 — 1400 JFK Blvd, Philadelphia, PA</name>
    <sym>Flag, Blue</sym>
    <type>Checkpoint</type>
  </wpt>
  <trk>
    <name>Alleycat Route</name>
    <trkseg>
      <trkpt lat="39.954320" lon="-75.165430"></trkpt>
      <!-- ... hundreds of routed track points ... -->
      <trkpt lat="39.952100" lon="-75.193600"></trkpt>
    </trkseg>
  </trk>
</gpx>
```

On a Wahoo ELEMNT Gen 3 with "Custom Waypoints" layer enabled, this renders:
- Blue flag icon at each CP location on the map
- "CP1 — 1500 Market St..." entries in the cue sheet with distances to each
- No spurious start/finish pins cluttering the map

---

## Edge cases to be aware of

### Empty controls array

If `resolvedRoute` has no controls (only start + finish), `controls` is `[]`, `wpts` is `''`, and the conditional `(wpts ? wpts + '\n' : '')` emits nothing. The GPX is still valid — just a track with no waypoints. This shouldn't happen in normal use since `runOptimize` requires at least one control before resolving.

### Controls with apostrophes or ampersands in their names

`escapeXml` already handles `&`, `<`, `>`, and `"`. It does not handle `'` (apostrophe). In XML, `'` is only special inside attribute values delimited by single quotes — it's safe in element text content. So `<name>O'Brien's Tavern</name>` is valid. No change needed here.

### Very long labels

`shortLabel` truncates to 3 comma-separated segments. For typical geocoded addresses this gives ~40 chars. Adding `"CP1 — "` (6 chars) brings it to ~46. Wahoo's cue sheet truncates display labels at roughly 28–32 characters on screen but stores the full string — so the rider taps the cue entry to see the full name. No action needed, but if labels routinely exceed 30 chars, a hard truncate like `label.slice(0, 30)` in the GPX name could be added later.

### Unicode em dash in CP label

The template uses `\u2014` (—). This is the Unicode em dash, encoded directly in the UTF-8 output declared in the XML header (`encoding="UTF-8"`). It's safe — Wahoo's XML parser handles UTF-8. Using HTML entity `&mdash;` would be wrong here (XML entity rules differ from HTML).

### `Date.now()` in filename causes test flakiness

This is pre-existing — not introduced by this change. If unit tests ever cover the filename, they'd need to mock `Date.now`. Out of scope for this fix.

---

## Files changed

| File | Lines | What changes |
|---|---|---|
| `src/main.ts` | 489–525 | `buildRoutedGPX` — all four fixes |
| `src/main.ts` | 528 | `exportGPX` — filename prefix |

Two functions, no new files, no new dependencies.

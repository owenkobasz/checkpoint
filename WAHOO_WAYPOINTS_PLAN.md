# Wahoo ELEMNT Route Export with Visible Waypoints — Planning Doc

## Overview

The app currently exports a GPX file with `<wpt>` elements for each checkpoint and a `<trk>` with routed track points. The core structure is correct, but Wahoo ELEMNT has specific requirements and quirks that determine whether those waypoints actually render on the device map. This doc covers findings, gaps in the current implementation, and three implementation paths with tradeoffs.

---

## How Wahoo ELEMNT Handles Waypoints

### Device generations matter

| Device | Map icon | Cue sheet | Dedicated waypoints page |
|---|---|---|---|
| Gen 3 (ACE, BOLT 3, ROAM 3 — 2024+) | ✅ Yes | ✅ Yes | ✅ Yes |
| Gen 2 (BOLT v2, ROAM v2) | ❌ No | ✅ Yes | ❌ No |
| Gen 1 (BOLT v1, ROAM v1) | ❌ No | ✅ Yes | ❌ No |

**Gen 3 is the target.** For Gen 2/1, the best we can do is get names into the cue sheet — they won't appear as map pins regardless of format.

### What triggers waypoint display on Gen 3

1. The file must contain `<wpt>` elements (GPX) OR Course Point messages (FIT/TCX)
2. On the device, the user must toggle the **"Custom Waypoints"** map layer ON (Map → Layers → Custom Waypoints)
3. Waypoints must have a `<name>` — unnamed wpts may be silently dropped
4. Optionally: a `<sym>` tag maps to one of ~50 Wahoo-specific icons

### What the current export does right

`buildRoutedGPX` in `src/main.ts:489` already:
- Places every `RoutePoint` as a `<wpt>` element with `lat/lon` and `<name>`
- Includes the routed track geometry in `<trk><trkseg>`

### What it's missing

1. **No `<sym>` tag** — Wahoo will render a generic dot; checkpoints should show a distinct icon
2. **No `<type>` tag** — helps route apps (RideWithGPS, Komoot) categorize wpts before they reach Wahoo
3. **Start and finish included as wpts** — clutters the cue sheet; Wahoo infers start/end from track geometry
4. **No `<desc>` tag** — useful for checkpoint instructions (e.g., "PHOTO REQUIRED")
5. **No elevation** — not required but improves cue sheet info on Gen 3
6. **`creator` attribute says "Checkpoint"** — should say "Alleycat" to match the app name

---

## File Format Analysis

### Option A — GPX (current path, enhanced)

**How it works:** Standard XML. Wahoo imports via the companion app (iOS/Android) using "Import Route" → share GPX file. On Gen 3 devices, `<wpt>` elements become Custom Waypoints on the map.

**GPX waypoint spec (GPX 1.1):**
```xml
<wpt lat="39.952583" lon="-75.163526">
  <name>CONTROL 01 — LOVE PARK</name>
  <desc>Photo checkpoint — sign required</desc>
  <sym>Flag, Blue</sym>
  <type>Checkpoint</type>
</wpt>
```

Three element types exist in GPX:
- `<wpt>` — standalone point, shows as waypoint/POI on Wahoo ✅
- `<rtept>` — part of a `<rte>` route; Wahoo treats these as turn points, NOT custom waypoints ⚠️
- `<trkpt>` — recorded track history; Wahoo ignores these as waypoints ❌

**Wahoo-recognized `<sym>` values (partial list):**
```
Flag, Blue     → blue flag icon
Flag, Red      → red flag icon
Pin, Blue      → blue pin
Residence      → house icon
Food           → fork/knife
Bar            → drink icon
Bike Trail     → cycling icon
```
Using `Flag, Blue` for controls and `Flag, Red` for start/finish is the clearest visual distinction.

**Pros:**
- Already 90% implemented
- Human-readable/debuggable XML
- Works with every Wahoo import flow (file share, email, AirDrop)
- No new dependencies

**Cons:**
- Weakest feature support on older Wahoo generations (cue sheet only, no map icons)
- No guaranteed turn-by-turn cues beyond the track line
- `<sym>` support is device-firmware-dependent — undocumented by Wahoo officially

**Verdict:** Lowest effort, covers Gen 3. Recommended as the primary path.

---

### Option B — FIT (binary, richest feature set)

**How it works:** Binary format originally from Garmin, now the de-facto standard for cycling computers. Course files (`.fit`) support explicit Course Point messages with distance-along-route, name, and instruction type. This is how Komoot and RideWithGPS deliver turn-by-turn cues.

**FIT Course file structure:**
```
File Header (14 bytes)
  ├── Definition Message: file_id
  ├── Data Message: file_id (type=course, manufacturer=development)
  ├── Definition Message: course
  ├── Data Message: course (name, capabilities)
  ├── Definition Message: lap
  ├── Data Message: lap (start/end position, total distance)
  ├── Definition Message: record  ← track geometry
  │   └── Data Messages: record × N (lat, lon, distance, altitude, timestamp)
  └── Definition Message: course_point  ← waypoints
      └── Data Messages: course_point × M (name, lat, lon, distance, type)
CRC (2 bytes)
```

**Course Point types relevant to alleycat:**
```
type 0  = generic
type 6  = left
type 7  = right
type 8  = straight
type 9  = first aid
type 23 = waypoint  ← best choice for checkpoints
type 24 = food/water
```

**Generating FIT requires a binary encoder.** No zero-dependency browser-native path exists. Options:

```typescript
// Option B1: fit-encoder npm package (browser-compatible)
import { FitEncoder } from 'fit-encoder'

// Option B2: Write a minimal FIT serializer from scratch
// FIT is just: [header][definition msg][data msg...][CRC]
// A minimal course file encoder is ~200 lines of TS

function writeFitCourse(
  name: string,
  trackPoints: { lat: number; lon: number; distMeters: number; altMeters?: number }[],
  coursePoints: { name: string; lat: number; lon: number; distMeters: number; type: number }[]
): Uint8Array {
  // Semi-circles = degrees * (2^31 / 180)
  const toSemicircles = (deg: number) => Math.round(deg * (2 ** 31 / 180))

  // ... message encoding logic (see implementation sketch below)
}
```

**Minimal FIT encoder sketch (the hard part):**
```typescript
class FitWriter {
  private buf: number[] = []

  writeUInt8(v: number)  { this.buf.push(v & 0xff) }
  writeUInt16LE(v: number) { this.buf.push(v & 0xff, (v >> 8) & 0xff) }
  writeUInt32LE(v: number) {
    this.buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff)
  }
  writeInt32LE(v: number) { this.writeUInt32LE(v >>> 0) }

  // FIT Definition Message
  writeDefinition(localMsgType: number, fields: FitFieldDef[]) {
    const recordSize = fields.reduce((s, f) => s + f.size, 0)
    this.writeUInt8(0x40 | localMsgType)  // definition header
    this.writeUInt8(0)                     // reserved
    this.writeUInt8(0)                     // arch: little-endian
    this.writeUInt16LE(fields[0].globalMsgNum)
    this.writeUInt8(fields.length)
    for (const f of fields) {
      this.writeUInt8(f.fieldNum)
      this.writeUInt8(f.size)
      this.writeUInt8(f.baseType)
    }
  }

  toUint8Array() {
    const data = new Uint8Array(this.buf)
    const header = buildHeader(data.length + 2)  // +2 for CRC
    const crc = crc16(data)
    return concat(header, data, [crc & 0xff, (crc >> 8) & 0xff])
  }
}
```

**Pros:**
- Best Wahoo support — Gen 1/2/3 all read course points
- Turn-by-turn cue sheet even on BOLT v1
- Course point `distance` field lets Wahoo show "Checkpoint in 2.3km"
- Compact binary (much smaller than GPX for long routes)

**Cons:**
- Significant implementation complexity (~300–400 lines of new code)
- Requires computing cumulative distance along the routed track before writing
- Binary format is hard to debug without tooling (use `fitdump` or FIT File Viewer)
- npm packages for FIT encoding are sparse and poorly maintained; likely need to hand-roll

**Verdict:** Best compatibility but ~2–3x the implementation effort of GPX improvements. Worthwhile if supporting Gen 1/2 devices is a priority.

---

### Option C — TCX (XML, middle ground)

**How it works:** Garmin's Training Center XML format. Uses `<CoursePoint>` elements which map cleanly to Wahoo cue-sheet entries. Supported by Wahoo for route import.

**TCX structure:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Courses>
    <Course>
      <Name>Alleycat Route</Name>
      <Lap>
        <TotalTimeSeconds>0</TotalTimeSeconds>
        <DistanceMeters>12450</DistanceMeters>
        <Intensity>Active</Intensity>
      </Lap>
      <Track>
        <Trackpoint>
          <Position>
            <LatitudeDegrees>39.952583</LatitudeDegrees>
            <LongitudeDegrees>-75.163526</LongitudeDegrees>
          </Position>
          <DistanceMeters>0</DistanceMeters>
        </Trackpoint>
        <!-- ... more trackpoints ... -->
      </Track>
      <CoursePoint>
        <Name>CONTROL 01 — LOVE PARK</Name>
        <Time>2025-01-01T00:00:00Z</Time>
        <Position>
          <LatitudeDegrees>39.952583</LatitudeDegrees>
          <LongitudeDegrees>-75.163526</LongitudeDegrees>
        </Position>
        <PointType>Generic</PointType>
        <Notes>Photo checkpoint</Notes>
      </CoursePoint>
    </Course>
  </Courses>
</TrainingCenterDatabase>
```

**TCX `PointType` values:**
```
Generic, Summit, Valley, Water, Food, Danger, Left, Right, Straight, FirstAid, 4thCategory, 3rdCategory, 2ndCategory, 1stCategory, HorsCategory, Sprint
```

`Generic` is the right choice for checkpoints.

**Wahoo behavior:** TCX CoursePoints appear in the cue sheet on all device generations. On Gen 3, they may also appear as map markers (less documented than GPX wpts).

**Pros:**
- XML so easy to generate and debug
- `CoursePoint` has explicit `Notes` field — better than GPX `<desc>` for checkpoint instructions
- Cue-sheet support on Gen 1/2 (unlike GPX `<wpt>`)

**Cons:**
- TCX requires `DistanceMeters` on each `<Trackpoint>` — must compute cumulative distance
- Wahoo's map-icon rendering for TCX is less reliable/documented than GPX `<wpt>`
- Format is more verbose than FIT, less standardized than GPX

**Verdict:** Good middle ground if cue-sheet support on older devices matters. Requires computing track distances (same problem as FIT but without the binary complexity).

---

## Recommendation

### Short term: Improve the GPX export (Option A)

The GPX path is already 90% there. Four targeted changes to `buildRoutedGPX` in `src/main.ts:489`:

1. **Filter start/finish from `<wpt>` list** — they clutter the cue sheet; track geometry already conveys them
2. **Add `<sym>Flag, Blue</sym>`** to each control wpt
3. **Add `<type>Checkpoint</type>`** to each control wpt
4. **Optionally add `<desc>`** from the control label for richer cue-sheet text

**Updated `buildRoutedGPX`:**
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

  // Only emit controls as <wpt> — not start/finish (inferred from track)
  const wpts = waypoints
    .filter(p => p.role === 'control')
    .map(p =>
      `  <wpt lat="${p.coord.lat.toFixed(6)}" lon="${p.coord.lon.toFixed(6)}">\n` +
      `    <name>${escapeXml(p.label)}</name>\n` +
      `    <desc>${escapeXml(p.label)}</desc>\n` +
      `    <sym>Flag, Blue</sym>\n` +
      `    <type>Checkpoint</type>\n` +
      `  </wpt>`
    )
    .join('\n')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Alleycat"\n` +
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
```

This is a ~10-line diff to the existing function. No new dependencies. Ships in 30 minutes.

### Long term: Add FIT export as a second format (Option B)

Once the GPX path is validated against real Wahoo hardware, add a FIT export as an alternative download. The FIT path enables:
- Cue-sheet waypoints on Gen 1/2 devices (not just Gen 3)
- Distance-to-next-checkpoint shown natively on the device

The FIT encoder should live in `src/fit-export.ts` and be ~300 lines. Key building blocks needed:

1. **`computeCumulativeDistances(trackPoints)`** — haversine sum along routed track
2. **`snapWaypointToTrack(wpt, trackPoints)`** — find the nearest track point to each checkpoint, return its cumulative distance (needed for the `distance` field in Course Point messages)
3. **`FitWriter`** — minimal binary encoder (header, definition messages, data messages, CRC16)
4. **`buildFitCourse(name, track, coursePoints)`** — assembles the complete FIT file

---

## Wahoo Import Flow (User-Facing)

The user receives the `.gpx` file (via share sheet on mobile or download on desktop). Then:

1. Open **Wahoo app** on phone
2. Tap **Routes** → **+** → **Import Route** → select the `.gpx`
3. Route syncs to ELEMNT over WiFi
4. On the **ELEMNT**, navigate to the route → tap the map layers icon → enable **Custom Waypoints**

This is a manual 4-step flow. There is no Wahoo API for programmatic route push — Wahoo does not expose a public API for route upload. Cloud sync (Komoot, RideWithGPS) bypasses this but requires account integration, which is out of scope.

---

## Known Wahoo Limitations

| Issue | Impact | Workaround |
|---|---|---|
| `<wpt>` map icons only on Gen 3 | Gen 1/2 users won't see pins | FIT CoursePoints work on all gens |
| Max ~200km for embedded cues on Gen 2 | Long alleycats may lose cues | Route is still navigable as a track |
| No public Wahoo route-push API | Can't send routes directly from app | User must import via Wahoo app |
| `<sym>` values not officially documented | Icons may vary by firmware | Use `Flag, Blue` as safest option |
| Strava integration strips cues on older firmware | N/A — we don't use Strava | — |

---

## Files to Touch

| File | Change |
|---|---|
| `src/main.ts:489` | Update `buildRoutedGPX` — filter controls only, add `<sym>` and `<type>` |
| `src/main.ts:527` | Update `exportGPX` — change filename prefix and MIME type comment |
| `src/fit-export.ts` | New file (future) — FIT encoder |
| `index.html` | Future: add "Export FIT" button alongside "Export GPX" |

# Manifest Photo Scan Plan — Checkpoint

## Context

At an alleycat start line, racers are handed a paper manifest listing checkpoints ("controls") in no particular order. Today the app requires typing each control into a text input (`addControl()` in `src/main.ts`), one at a time, with autocomplete against Mapbox/Google. For a 12–15 control manifest that's 2–4 minutes of typing under race pressure, on a phone, often with bad light and worse handwriting on the manifest.

The feature: **photograph the manifest and have the app extract the checkpoints automatically** — while the racer keeps entering controls by hand in parallel, because:

1. **Time is the whole game.** The scan takes 5–15 seconds of network + inference time. The racer should be typing controls they can read during that window, not staring at a spinner.
2. **Extraction will sometimes be wrong.** Manifests are photocopied, stylized, handwritten, crumpled. Extracted entries must be visibly marked as unverified so the racer can review them, and manual entry must never be blocked or clobbered by scan results arriving late.

### What exists today (relevant code)

| Area | Where | Notes |
|---|---|---|
| Control rows | `src/main.ts:253-318` (`addControl`, `removeControl`, `renumberControls`) | DOM-driven; each row has `data-id` from a monotonic `controlCount`; input + autocomplete + remove button. `addControl()` calls `input.focus()` unconditionally. |
| Geocoding | `src/geocoder.ts`, `src/providers/*` | `GeocoderProvider` interface with `geocode()` + `suggest()`. Mapbox default, Google behind unlock code, Nominatim fallback. Controls without a selected suggestion are geocoded lazily inside `runOptimize()` (`src/main.ts:604-616`). |
| Persistence | `src/persistence.ts` | `PersistedControl { id, inputLabel, coord }` in localStorage, schema version 1, debounced 600 ms saves via `scheduleSave()`. |
| Status bar | `setStatus()` in `src/main.ts:89-92` | Single-line terminal-style status; the natural place for scan progress. |
| Deployment | README | Vite static build on Vercel; **no backend today**. All secrets are `VITE_`-prefixed, i.e. baked into the client bundle. |
| Unlock pattern | `src/unlock.ts` | SHA-256 hash gate for the Google provider — a precedent for lightweight access gating if we want to gate scanning. |

The one architecturally significant fact: **the app is fully static, and vision extraction needs an LLM API key that must not ship in the client bundle.** That forces a small server component (or one of the alternatives in the tradeoffs section).

---

## Part 1 — Feature Understanding & Expected Behavior

### What a manifest looks like

Real alleycat manifests are hostile input: photocopied lists, hand-numbered, mixed fonts, sometimes a table with columns (checkpoint / task / points), sometimes prose ("Go to the mural at 2nd & Poplar, take a selfie"). Checkpoints are usually **intersections** ("Broad & Girard"), sometimes addresses, sometimes named places ("Tattooed Mom", "the Rocky steps"). The city is often *not* printed — everyone at the race knows where they are. Both of these facts drive the design:

- Plain OCR is not enough. Turning "2. mural @ 2nd/Poplar — selfie w/ bike" into a geocodable string ("2nd & Poplar, Philadelphia") plus a note ("selfie with bike") is a language task, not a text-recognition task. This is why the plan uses a vision LLM rather than an OCR library (see Alternatives).
- Extracted names need **city context appended** before geocoding, or Mapbox will happily resolve "Broad & Girard" to another state. The scan response includes a `city` field, and geocoding of scanned entries gets a proximity bias from the racer's GPS fix.

### Expected behavior, end to end

1. **Trigger.** A `▣ SCAN MANIFEST` button sits in the `[03] CONTROLS` block next to `+ ADD CONTROL`. Tapping it opens the phone camera (via `<input type="file" accept="image/*" capture="environment">`). Desktop users get a file picker — useful when the organizer posts a manifest photo in a group chat.
2. **Non-blocking upload.** The photo is downscaled/compressed client-side (~2048 px long edge, JPEG q0.8, typically 200–500 KB), then POSTed to `/api/scan-manifest`. The status bar shows `SCANNING MANIFEST — KEEP ENTERING CONTROLS`. **Nothing is disabled.** The racer keeps adding/editing/removing controls; GPS acquisition, start/finish entry all work normally. Only a second *scan* is disabled while one is in flight (one at a time keeps the merge logic simple).
3. **Results arrive as normal control rows.** Each extracted checkpoint is appended to the controls list as a regular control row, pre-filled with the extracted text (with the city appended for geocoding fidelity), visually flagged as scanned-unverified (amber index number + `SCAN?` chip). They behave identically to typed rows: editable, autocomplete-enabled, removable, persisted, geocoded at optimize time.
4. **Dedupe against manual entries.** Before appending, each extracted checkpoint is fuzzy-compared against every existing row's text. If the racer already typed "broad and girard" and the scan extracted "Broad & Girard", the scan result is dropped (the racer's row wins — it may already have a selected coordinate). Dedupe also runs between scan results themselves, so re-scanning a page (or scanning page 2 of a manifest that repeats the header) doesn't duplicate.
5. **Review.** Tapping into a scanned row's input, or selecting an autocomplete suggestion for it, clears the unverified flag. The racer can also just hit Optimize — scanned rows geocode exactly like typed rows do today, and errors surface per-row through the existing `[ERR] NOT FOUND: "…"` status path.
6. **Notes.** If the manifest includes a task at a checkpoint ("locked gate — side entrance"), the extraction captures it and it's shown as a small subtitle line under the row input. Notes are informational only — not sent to the geocoder, not exported to GPX (v1; a `<desc>` in the GPX waypoint is a cheap follow-up).
7. **Multiple photos.** The scan button can be used repeatedly (multi-page manifests, retake of a blurry shot). Each scan appends-with-dedupe.
8. **Failure is quiet and non-destructive.** Offline / API error / timeout → `[ERR] SCAN FAILED — CONTINUE MANUAL ENTRY` in the status bar, scan button re-enabled, nothing else changes. A scan can *add* rows but never modifies or removes an existing row.

### Explicitly out of scope (v1)

- Extracting start/finish from the manifest (usually where the racer already is / the bar — GPS + one typed entry covers it; a scan result is ambiguous about which line is the finish).
- Background geocoding of scanned rows before Optimize (the lazy geocode in `runOptimize()` already handles it; see Alternatives for why eager geocoding was considered and deferred).
- Offline scanning (needs signal; manual entry remains the offline path, which is why it must never be blocked).

---

## Part 2 — Journeys

### Racer journey (happy path)

> 7:02 pm, start line, manifest just handed out. Opens checkpoint.bike (already loaded, session restored from localStorage). Taps ACQUIRE GPS — locked. Taps ▣ SCAN MANIFEST → camera → snaps the sheet. Status: `SCANNING MANIFEST — KEEP ENTERING CONTROLS`. While it processes, she types the two controls she can read at a glance ("front & master", "2nd & poplar") into manually-added rows. Nine seconds later, twelve amber rows appear below her two typed ones — the scan also found "2nd & Poplar" but it was deduped against her typed row. Status: `[OK] 11 SCANNED — 2 LOW CONFIDENCE, VERIFY AMBER ROWS`. She eyeballs the list against the paper: one row reads "Krorner & Salmon" (handwriting) — she taps it, fixes to "Kramer", picks the autocomplete suggestion, flag clears. Taps ▶ OPTIMIZE ROUTE. Route renders. Export GPX → share sheet → Wahoo app. Rolling in under 90 seconds.

### Racer journey (degraded)

- **Blurry photo:** extraction returns 6 of 14 checkpoints, several `confidence: "low"`. Status reports the count; she rescans (dedupe absorbs the overlap) or types the rest. Partial results are still a win.
- **No signal:** POST fails after the client timeout (45 s) or immediately (offline). `[ERR] SCAN FAILED — CONTINUE MANUAL ENTRY`. She's been typing the whole time anyway — worst case is status quo ante.
- **Geocode miss at optimize:** existing behavior — `[ERR] NOT FOUND: "…"` names the failing text; she edits that row. Nothing new to build.

### Operator/admin journey (Owen)

There is no in-app admin role; "admin" here is the person who deploys and pays for the API.

1. **Setup (one-time):** create an Anthropic API key at console.anthropic.com → add `ANTHROPIC_API_KEY` in Vercel → Settings → Environment Variables, marked Sensitive (**no `VITE_` prefix** — this one must stay server-side; the existing `VITE_*` vars are intentionally public, this one intentionally is not). `npm i @anthropic-ai/sdk`, add `api/scan-manifest.ts`, plus a two-line `vercel.json` raising the function timeout (see 3.1), redeploy. Vercel auto-detects the `api/` directory as serverless functions alongside the static Vite build. Remember Vercel doesn't rebuild on env-var changes — trigger a redeploy after adding the key (same gotcha the README already documents for the other vars).
2. **Cost control:** set a monthly spend limit on the Anthropic console (e.g. $10 — see cost table below; that's roughly 150–300 scans/month on Opus, ~1,000–2,000 on Haiku). This is the real backstop against abuse — everything in step 3 is a deterrent, this is the hard cap.
3. **Abuse hardening (cheap, layered):** the function rejects oversized payloads (Vercel itself hard-caps request bodies at 4.5 MB) and rejects browser requests whose `Origin` isn't checkpoint.bike / localhost / a preview deploy — note the origin check only stops other *websites* from hotlinking the endpoint; a curl script sends no Origin and passes, which is what the spend cap is for. If the project is on a plan with Vercel WAF rate limiting, add a rule capping `/api/scan-manifest` at e.g. 10 requests/minute/IP (dashboard → Firewall → Rules; no code) — on Hobby, rate-limit rules aren't available, and building a durable per-IP limiter would need external state (Upstash etc.), which is overkill for v1 given the spend cap. Optionally, gate scanning behind the existing ENHANCED MODE access code (`src/unlock.ts` pattern) — deferred by default because friction at the start line defeats the feature's purpose.
4. **Monitoring:** Anthropic console usage page + `vercel logs`. The function logs one line per scan (image bytes, checkpoint count, latency, model) — no image contents.
5. **Local dev:** `vercel dev` runs the Vite dev server and the function together on one origin (add `ANTHROPIC_API_KEY` to `.env.local`, which is already gitignored). Plain `npm run dev` still works for everything except scanning; the client treats a 404 from `/api/scan-manifest` as "scan unavailable" and says so, so the feature degrades cleanly in dev.

---

## Part 3 — Technical Design

### Architecture

```
┌─ browser (Vite static app) ──────────────────────────────┐
│ scan button → camera → canvas downscale (≤2048px JPEG)   │
│      │  base64, POST                                     │
│      ▼                                                   │
│  /api/scan-manifest  ── Vercel serverless fn ────────────┼──▶ Anthropic API
│      │   holds ANTHROPIC_API_KEY (server-side env)       │    claude-opus-5, vision +
│      ▼   returns {city, checkpoints[]}                   │    structured JSON output
│  merge: dedupe → addControl(prefill, scanned) → persist  │
└──────────────────────────────────────────────────────────┘
```

One new serverless function, one new client module (`src/scan.ts`), surgical changes to `main.ts`/`index.html`/`style.css`/`persistence.ts`. The static app stays static for everything else; the deploy story changes only in that Vercel now also builds `api/`.

### 3.1 New file: `api/scan-manifest.ts` (Vercel function)

Uses the official SDK with structured outputs so the response is schema-guaranteed JSON — no parsing heuristics, and the model retries schema violations server-side. Model is `claude-opus-5` (current Opus; strongest at reading degraded/handwritten photos — exactly this workload) at `effort: "low"`, which is the latency/cost lever appropriate for a bounded extraction task. Server-side refusal fallback is enabled by default (`fallbacks: "default"`) so a rare classifier false-positive on a photo retries on a fallback model inside the same request instead of failing the scan.

```typescript
// api/scan-manifest.ts
import Anthropic from '@anthropic-ai/sdk'

// Vercel rejects serverless request bodies over 4.5 MB at the platform level —
// enforce a lower app-level cap so oversize uploads get a clear 400, not a 413.
// This measures the base64 string (~1.33× the binary size → ~3 MB of image).
const MAX_IMAGE_CHARS = 4 * 1024 * 1024

const ALLOWED_ORIGINS = new Set([
  'https://checkpoint.bike',
  'https://www.checkpoint.bike',
  'http://localhost:5173',   // vite dev
  'http://localhost:3000',   // vercel dev
])

// Deterrent only: blocks other sites' browsers from hotlinking the endpoint.
// curl/scripts omit Origin and pass — the WAF rule and spend cap cover those.
function originAllowed(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || origin.endsWith('.vercel.app') // preview deploys
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['city', 'checkpoints'],
  properties: {
    city: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'City or neighborhood the manifest is for, if printed or clearly inferable. Null otherwise.',
    },
    checkpoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'note', 'confidence'],
        properties: {
          name: {
            type: 'string',
            description:
              'The checkpoint location, phrased for a geocoder: an intersection ("Broad & Girard"), street address, or named place. Strip list numbering, point values, and task text.',
          },
          note: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Task or instructions at this checkpoint, if any. Null otherwise.',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'low'],
            description:
              'low if the text is hard to read, ambiguous, or you had to guess at characters.',
          },
        },
      },
    },
  },
} as const

const PROMPT = `This is a photo of an alleycat bike race manifest: a list of
checkpoints ("controls") racers must visit. Extract every checkpoint location.

- Locations are usually intersections, addresses, or named places/businesses.
- Ignore headers, rules, sponsor logos, point values, and the start/finish
  lines if labeled as such — extract checkpoints only.
- Keep task instructions (e.g. "take a selfie", "get manifest signed") in the
  note field, not in the name.
- Do not invent checkpoints. If a line is illegible, either omit it or return
  your best reading with confidence "low".`

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin && !originAllowed(origin)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { image?: string; mediaType?: string; hint?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const { image, mediaType, hint } = body
  if (!image || mediaType !== 'image/jpeg' || image.length > MAX_IMAGE_CHARS) {
    return Response.json({ error: 'bad image payload' }, { status: 400 })
  }
  // hint is racer-typed text going into the prompt — cap it so it stays a hint
  const safeHint = typeof hint === 'string' ? hint.slice(0, 120) : null

  const client = new Anthropic()  // reads ANTHROPIC_API_KEY

  const response = await client.beta.messages.create({
    model: 'claude-opus-5',
    // thinking is on by default on claude-opus-5 and shares this cap with the
    // JSON output — 8192 leaves room for both on a dense manifest
    max_tokens: 8192,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: image },
          },
          {
            type: 'text',
            text: safeHint ? `${PROMPT}\n\nContext: the race is near "${safeHint}".` : PROMPT,
          },
        ],
      },
    ],
  })

  if (response.stop_reason === 'refusal') {
    return Response.json({ error: 'scan declined' }, { status: 502 })
  }
  if (response.stop_reason === 'max_tokens') {
    // output truncated mid-JSON — fail loudly rather than let the client
    // choke on an unparseable body
    return Response.json({ error: 'scan output truncated' }, { status: 502 })
  }

  const text = response.content.find(b => b.type === 'text')?.text ?? ''
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
```

Notes:

- The structured-output `text` block is guaranteed to match `SCHEMA` (except on the refusal/truncation paths, which return 502 before reaching it), so the function passes it through verbatim; the client still parses defensively.
- `hint` is the racer's start location text (or "lat, lon" from GPS), used only as prompt context — it materially improves the `city` inference on manifests that don't name the city. It's length-capped server-side; it's the racer's own input hinting their own request, so prompt injection here is self-inflicted and low-stakes.
- **Function timeout goes in `vercel.json`, not the function file** — for plain `api/` functions (non-Next.js) the reliable mechanism is:
  ```json
  { "functions": { "api/scan-manifest.ts": { "maxDuration": 60 } } }
  ```
  Vision + low effort typically completes in 4–10 s; 60 s is headroom for a slow API day. Check the current plan's duration cap when implementing — limits differ between Hobby/Pro and Fluid/legacy compute.
- **Handler signature:** the Web-standard `export async function POST(request: Request)` is supported by Vercel's Node runtime, but requires the file to be treated as ESM. If the build doesn't pick it up (this `package.json` has no `"type": "module"`), fall back to the classic Node signature (`(req: VercelRequest, res: VercelResponse)` from `@vercel/node`) — same logic, different plumbing. Decide at implementation time; not worth pre-committing.
- If `ANTHROPIC_API_KEY` is unset in the deployment, the `new Anthropic()` constructor throws → 500 → client shows `[ERR] SCAN FAILED (500)`. Acceptable; the deploy checklist covers it.
- Non-streaming is fine: `max_tokens` 8192 is well under the ~16k streaming threshold, and actual output is a few hundred tokens.

### 3.2 New file: `src/scan.ts` (client module)

```typescript
// src/scan.ts
export interface ScannedCheckpoint {
  name: string
  note: string | null
  confidence: 'high' | 'low'
}

export interface ScanResult {
  city: string | null
  checkpoints: ScannedCheckpoint[]
}

const MAX_EDGE = 2048
const JPEG_QUALITY = 0.8
const SCAN_TIMEOUT_MS = 45_000

async function compressImage(file: File): Promise<string> {
  // 'from-image' applies the EXIF rotation tag — phone photos are routinely
  // stored sideways, and the model must see the manifest upright
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))

  const canvas = document.createElement('canvas')
  canvas.width  = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const blob = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
  )
  if (!blob) throw new Error('IMAGE ENCODE FAILED')

  const dataURL = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('IMAGE READ FAILED'))
    reader.readAsDataURL(blob)
  })
  return dataURL.slice(dataURL.indexOf(',') + 1)  // strip data:...;base64, prefix
}

export async function scanManifest(file: File, hint: string | null): Promise<ScanResult> {
  const image = await compressImage(file)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS)

  try {
    const res = await fetch('/api/scan-manifest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, mediaType: 'image/jpeg', hint }),
      signal: controller.signal,
    })
    if (res.status === 404) throw new Error('SCAN UNAVAILABLE IN THIS BUILD')
    if (!res.ok) throw new Error(`SCAN FAILED (${res.status})`)
    const data = await res.json() as ScanResult
    if (!Array.isArray(data.checkpoints)) throw new Error('SCAN RETURNED BAD DATA')
    return data
  } finally {
    clearTimeout(timer)
  }
}

// ── Dedupe ──────────────────────────────────────────────────────
// Connective tokens carry no location signal but appear in nearly every
// intersection entry — left in, they inflate overlap ratios.
const STOPWORDS = new Set(['and', 'the', 'at', 'of', 'on', 'near'])

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(st|street|ave|avenue|rd|road|blvd|boulevard)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(s: string, alsoDrop?: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const t of normalize(s).split(' ')) {
    if (t && !STOPWORDS.has(t) && !alsoDrop?.has(t)) out.add(t)
  }
  return out
}

// Tokens of the scan's detected city — stripped from BOTH sides before
// comparing, so the appended ", Philadelphia" suffix never counts as overlap.
export function cityTokenSet(city: string | null): Set<string> {
  return city ? tokens(city) : new Set()
}

export function isDuplicate(a: string, b: string, cityTokens?: Set<string>): boolean {
  const ta = tokens(a, cityTokens)
  const tb = tokens(b, cityTokens)
  if (ta.size === 0 || tb.size === 0) return false
  // A 1-token set carries too little signal for a ratio — require exact
  // set equality ("Girard" ≠ "Front & Girard", but "Girard" = "Girard Ave")
  if (ta.size <= 1 || tb.size <= 1) {
    return ta.size === tb.size && [...ta].every(t => tb.has(t))
  }
  let overlap = 0
  ta.forEach(t => { if (tb.has(t)) overlap++ })
  return overlap / Math.min(ta.size, tb.size) >= 0.75
}

// Append the detected city for geocoding — unless the name already names it.
export function labelWithCity(name: string, city: string | null): string {
  if (!city) return name
  return normalize(name).includes(normalize(city)) ? name : `${name}, ${city}`
}
```

Dedupe rationale, and why the naive version is wrong: token-overlap against the *smaller* set makes "Broad & Girard" match "broad and girard" and "Broad & Girard, Philadelphia". But without the stopword and city-token stripping, the appended city suffix poisons the ratio — "Broad & Girard, Philadelphia" vs "Broad & Master, Philadelphia" shares `{broad, and, philadelphia}` = 3 of 4 tokens = 0.75, which would silently merge **two distinct checkpoints on the same street** (a common manifest pattern, and exactly the false positive this design must never produce, since within-scan dedupe compares each new city-suffixed label against previously appended ones). With `and` dropped as a stopword and the city tokens removed from both sides, the same pair compares `{broad, girard}` vs `{broad, master}` = 0.5 → correctly kept. The 1-token equality rule closes the other hole: `{girard}` ⊂ `{front, girard}` would score 1.0 by ratio, swallowing a real checkpoint on the strength of a single shared street name. Known accepted limitation: "2nd" vs "Second" don't match (false negative → duplicate row, cheap to delete — the failure direction this design prefers). The tradeoff stance is unchanged: a false negative costs one duplicate row; a false positive silently swallows a checkpoint, so every rule errs toward keeping.

Compatibility note: `createImageBitmap` with the `imageOrientation` option needs Safari 15+ / modern Chrome — fine for the target audience (racers' phones). On anything older the call throws, lands in `runScan`'s catch, and manual entry continues; an `<img> + decode()` fallback path is possible but not worth building until someone actually hits it. If a browser hands over a HEIC file the same failure path applies (iOS transcodes camera captures to JPEG for web uploads, so in practice this is rare).

### 3.3 Changes to `src/main.ts`

**`addControl()` gains options.** This is *not* fully backwards-compatible and both existing call sites need attention: the add-button handler calls `addControl()` with no args (fine as-is), but `applyState()` at `src/main.ts:720` calls `addControl(ctrl.id)` with a bare number and **must** become `addControl({ existingId: ctrl.id, focus: false })`. The `focus: false` there also fixes an existing quirk — restore currently calls `input.focus()` once per restored row, popping the keyboard on mobile page load.

```typescript
interface AddControlOptions {
  existingId?: number
  prefill?:   string
  note?:      string | null
  scanned?:   boolean    // amber styling + SCAN? chip until verified
  focus?:     boolean    // default true; scan results pass false
}

function addControl(opts: AddControlOptions = {}): void {
  const id = opts.existingId ?? ++controlCount
  // ... existing row construction ...
  if (opts.prefill) input.value = opts.prefill
  if (opts.scanned) {
    row.classList.add('control-row--scanned')
    controlMeta.set(id, { source: 'scanned', note: opts.note ?? null })
  }
  if (opts.note) { /* append a .control-note div under .input-row */ }

  input.addEventListener('input', () => {
    controlCoords.delete(id)
    clearScannedFlag(id)        // touching a scanned row = racer has reviewed it
    scheduleSave()
  })
  attachAutocomplete(input, coord => {
    controlCoords.set(id, coord)
    clearScannedFlag(id)        // selecting a suggestion also verifies
    scheduleSave()
  })

  if (opts.focus !== false) input.focus()
  renumberControls()
}
```

Supporting pieces, so nothing is left implied:

- `controlMeta: Map<number, { source: 'manual' | 'scanned'; note: string | null; verified: boolean }>` lives next to `controlCoords`. Rows without an entry are implicitly `manual`.
- `clearScannedFlag(id)` — removes `control-row--scanned` from the row, sets `verified: true` in `controlMeta`, no-ops for manual rows. Called from the `input` listener and the autocomplete `onSelect` (both shown above); programmatic prefill doesn't fire `input` events, so scan results stay flagged until the racer actually touches them.
- `removeControl(id)` gains one line: `controlMeta.delete(id)` (it already deletes from `controlCoords`).

The key concurrency property comes free from the existing design: scan results append rows via the same `addControl` path with fresh `++controlCount` ids, so they can never collide with rows the racer is creating simultaneously — DOM appends don't disturb an input that currently has focus, and `focus: false` prevents the one thing that would (focus theft mid-keystroke).

**Scan orchestration:**

```typescript
let scanInFlight = false

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

    const existing = (): string[] =>
      Array.from(controlsList.querySelectorAll<HTMLInputElement>('.control-row input'))
        .map(i => i.value.trim())
        .filter(v => v.length > 0)

    const cityTok = cityTokenSet(result.city)

    let added = 0, low = 0, skipped = 0
    for (const cp of result.checkpoints) {
      const label = labelWithCity(cp.name, result.city)
      // re-read existing rows on every iteration: the racer may have typed
      // a new control while this loop's earlier rows were being added, and
      // earlier scanned rows must dedupe against later ones in this batch.
      // City tokens are stripped inside isDuplicate, so comparing against
      // cp.name and against the suffixed label are equivalent.
      if (existing().some(v => isDuplicate(v, cp.name, cityTok))) {
        skipped++
        continue
      }
      addControl({ prefill: label, note: cp.note, scanned: true, focus: false })
      added++
      if (cp.confidence === 'low') low++
    }

    scheduleSave()
    const reoptimize = resolvedRoute !== null && added > 0
      ? ' — RE-OPTIMIZE TO INCLUDE' : ''
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
    scanFileInput.value = ''   // allow re-selecting the same file
  }
}

scanBtn.addEventListener('click', () => scanFileInput.click())
scanFileInput.addEventListener('change', () => {
  const file = scanFileInput.files?.[0]
  if (file) void runScan(file)
})
```

**Scan finishing after Optimize:** if the racer optimized while the scan was in flight, results still land as control rows (never injected into the built route — `resolvedRoute` and the map are untouched by a scan) and the status message appends `RE-OPTIMIZE TO INCLUDE`. Re-running Optimize is the racer's explicit choice, consistent with how manually adding a row after optimizing already works today.

**Status-bar contention:** `setStatus` is last-write-wins everywhere in the app already; a scan completing can overwrite (or be overwritten by) an unrelated status line. Accepted — the amber rows themselves are the durable signal, the status line is a toast.

### 3.4 `index.html` + `src/style.css`

In the `[03] CONTROLS` block body, after the add button:

```html
<button class="add-btn" id="addBtn" type="button">+ ADD CONTROL</button>
<button class="scan-btn" id="scanBtn" type="button">▣ SCAN MANIFEST</button>
<input type="file" id="scanFileInput" accept="image/*" capture="environment" hidden />
```

CSS: `.scan-btn` styled like `.add-btn` (dashed border, full width) but with the amber accent; `.control-row--scanned .control-index { color: var(--amber); }` plus a `SCAN?` chip (`::after` on the index span, or a small element like the existing `.route-item-role` chips) and a `.control-note` line in dim small caps. All consistent with the existing terminal aesthetic — no modal, no new layout primitives.

### 3.5 `src/persistence.ts`

Additive, no version bump needed — old saved states simply lack the new optional fields and `undefined` falls through everywhere:

```typescript
export interface PersistedControl {
  id:         number
  inputLabel: string
  coord:      Coord | null
  source?:    'manual' | 'scanned'   // new
  note?:      string | null          // new
  verified?:  boolean                // new — scanned rows the racer has touched
}
```

`persistCurrentState()` and the share-button snapshot in `main.ts` read these from the `controlMeta` map defined in 3.3; `applyState()` restores the amber flag for `source === 'scanned' && !verified` rows (passing `scanned`/`note` through the new `addControl` options) and repopulates `controlMeta`. `share.ts` is left untouched — the share payload only carries geocoded controls, and by the time someone shares a route, scanned/manual provenance no longer matters.

### 3.6 Geocoding improvements (small, high value)

**(a) Cache optimize-time geocode results.** `runOptimize()` currently geocodes any control without a cached coord but never writes the result back into `controlCoords` (`src/main.ts:604-616` — `resolvedControls.push(await getGeocoder().geocode(value))`). Today that's tolerable because most rows get coords from autocomplete selection. Scanned rows arrive with **no** coord, so without this fix a 12-row scan re-geocodes 12 times on *every* optimize — on the Nominatim fallback that's ~13 s of rate-limit delays per re-optimize, and the geocoded coords never reach persistence or the share payload (which filters `coord !== null`, so an optimized-but-unshared scanned route would share as empty). One-line fix inside the resolve loop: `controlCoords.set(id, resolved)` after each successful geocode, followed by `scheduleSave()` — repeat optimizes become instant and scanned rows become shareable after the first optimize.

**(b) Proximity biasing.** Add it to `MapboxGeocoder` — one query param, and it helps *typed* entries too:

```typescript
// providers/types.ts
export interface GeocoderProvider {
  geocode(query: string, near?: Coord): Promise<Coord>
  suggest(query: string, signal: AbortSignal, near?: Coord): Promise<Coord[]>
}

// providers/mapbox.ts — append when near is provided:
//   &proximity=${near.lon},${near.lat}
```

`runOptimize()` passes `startCoords ?? finishCoords ?? undefined`; `attachAutocomplete` passes `startCoords`. Google and Nominatim can ignore the parameter (Google's Geocoding API has an equivalent `bounds` bias if wanted later). This plus the `", City"` suffix on scanned entries is the difference between "Broad & Girard" resolving in Philadelphia vs. anywhere.

### 3.7 Build/dev/docs housekeeping

- `npm i @anthropic-ai/sdk` (server-side only — Vite won't bundle anything under `api/`, so client bundle size is unchanged). `tsconfig.json` `include` currently covers `src`; either add `api` or (simpler) let Vercel typecheck the function on deploy and add `"api"` to `include` with `"types": ["node"]` scoped via a small `api/tsconfig.json`.
- `.env` template gains a commented `# ANTHROPIC_API_KEY=sk-ant-...  (server-side only — never VITE_-prefixed)`.
- README: new env var, `vercel dev` note, and the "Fully static — no server required" line amended to "static app + one serverless function for manifest scanning (optional — the app works without it)".

---

## Part 4 — Alternatives & Tradeoffs

### A. Where does the vision model run?

| Option | How | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A1. Vercel serverless fn + Claude vision** (chosen) | `api/scan-manifest.ts`, key in server env | Key stays secret; same-origin (no CORS); zero client bundle growth; Vercel already hosts the app; WAF rate limiting available on paid plans | App is no longer "purely static"; needs `vercel dev` locally; ~$0.03–0.06/scan | **Recommended.** Smallest change that keeps the key safe. |
| A2. Direct browser → Anthropic API | SDK supports CORS via the `anthropic-dangerous-direct-browser-access` header; key in `VITE_` var, optionally gated behind the ENHANCED MODE unlock code | Truly zero backend; works with `npm run dev` unchanged | **The API key ships in the JS bundle.** The unlock code only gates the UI, not the key — anyone can extract it from the bundle and spend against it. A spend cap limits damage but a stolen key still kills the feature for everyone | Rejected. The header is named "dangerous" for a reason; fine for internal tools, not a public site. |
| A3. Client-side OCR (Tesseract.js) + heuristic parsing | WASM OCR in browser, then regex/line heuristics to find checkpoints | Free forever; works offline; no key, no backend | ~2–4 MB WASM added to a currently tiny bundle; OCR accuracy on photographed/handwritten/stylized manifests is poor; and OCR only yields raw text — turning "2. mural @ 2nd/Poplar — selfie" into a geocodable name + note is the hard part and needs an LLM or brittle heuristics anyway | Rejected as primary. Could return later as an *offline fallback* tier. |
| A4. Cloud OCR (Google Vision API text detection) + parsing | Server fn calls Vision OCR, parses lines | Cheaper per call (~$0.0015) | Still needs a server (same key problem), and still leaves the parsing problem unsolved — you'd end up feeding the OCR text to an LLM anyway, at which point sending the image straight to a vision LLM is simpler and more accurate (layout/columns/strikethroughs survive) | Rejected. Worst of both. |

### B. Which model?

Sample code uses **`claude-opus-5`** ($5/$25 per MTok) at `effort: "low"`: strongest available read on degraded photos, and per-scan cost is still small. If scan volume grows or latency matters more than the last few percent of accuracy, **`claude-haiku-4-5`** ($1/$5 per MTok) is the switch — roughly 5× cheaper and faster, likely fine on cleanly printed manifests, weaker on handwriting. The model name is one string in one server file; easiest path is to ship Opus, collect a handful of real manifest photos, and A/B by hand before a race. Cost reality check per scan — image tokens scale ≈ px²/750, so a 2048×1536 photo is ≈4.2k tokens, plus a few hundred prompt tokens and ≈0.5–1.5k output+thinking tokens (dropping `MAX_EDGE` to 1568 px would roughly halve the image tokens if cost ever matters more than fidelity on small print):

| Model | Per scan | 100 scans/mo |
|---|---|---|
| claude-opus-5 | ~$0.03–0.06 | ~$3–6 |
| claude-haiku-4-5 | ~$0.005–0.012 | ~$0.50–1.20 |

### C. Where do scan results land in the UI?

| Option | Pros | Cons |
|---|---|---|
| **C1. Append directly as flagged control rows** (chosen) | Zero extra interaction on the happy path — results are immediately usable; review is *optional* and inline; reuses 100% of existing row machinery (edit, autocomplete, remove, persist, optimize) | Racer must visually diff against paper to catch misses; a very wrong extraction sits in the list until noticed (mitigated by amber flag + geocode failure naming the row at optimize) |
| C2. Review modal: show extracted list with checkboxes, racer confirms → import | Explicit review step catches errors before they enter the list; natural place to show confidence | Adds a mandatory tap-through under time pressure — the racer must stop manual entry, review, confirm; a modal also fights the concurrent-entry requirement (what happens to rows typed while it's open is answerable but awkward) |
| C3. Separate "scanned" staging section above the list, promote per-row | Middle ground | Two lists to reason about, more UI, and the racer ends up promoting everything anyway |

C1 wins on the feature's own stated priority (time), with the amber-flag + status-line-count providing the review affordance C2 would have made mandatory.

### D. Geocode scanned rows eagerly or lazily?

Eager (fire `geocode()` for each scanned row as it lands, in the background) would let the UI flag "didn't resolve" before Optimize and drop pins sooner. Deferred because: it duplicates the resolution logic that `runOptimize()` already owns; Nominatim's 1 req/s policy makes a 12-row background burst a real problem on the fallback provider (the `needsRateLimit()` dance exists for exactly this); and the lazy path's failure UX (named error at optimize) is acceptable. Revisit if field use shows racers hitting geocode errors late. The `proximity` bias (3.6b) delivers most of the accuracy win at none of the cost, and the coord caching (3.6a) removes the worst consequence of laziness (repeat geocoding on re-optimize).

### E. Request shape: base64 JSON vs multipart/FormData

Base64 in JSON adds ~33% to a 300 KB upload (~100 KB — irrelevant on LTE) and keeps the function body trivial and the Anthropic call zero-conversion (the API wants base64 anyway). Multipart saves the 33% but needs multipart parsing in the function. Base64 chosen.

---

## Part 5 — Implementation Plan & Task Checklist

Phases are ordered by dependency: each phase is independently testable before the next begins, and Phases 4–6 can proceed in any order once Phase 3 lands. Section references point back into Part 3.

> **Status: implemented on branch `manifest-scan` (off `dev`).** Unchecked boxes are operator actions (API key, Vercel dashboard, phone-in-hand testing) that code cannot complete. Deviations from the plan as written are noted inline — the plan was drafted against `main`, and `dev`'s route-quality merge had already landed part of it.

### Phase 0 — Prerequisites & environment ✅ (code side)

- [x] `npm i @anthropic-ai/sdk` (server-side only; client bundle verified clean — no `anthropic` string in `dist/assets`). Also added `@vercel/node` (dev) for the function's request/response types
- [ ] **OPERATOR:** Create an Anthropic API key at console.anthropic.com; set a monthly spend limit (~$10) on the workspace
- [ ] **OPERATOR:** Add `ANTHROPIC_API_KEY` to `.env.local` for `vercel dev` — a commented placeholder line is in place, fill in the real key
- [ ] **OPERATOR:** Add `ANTHROPIC_API_KEY` to Vercel → Settings → Environment Variables, marked Sensitive, no `VITE_` prefix, all environments
- [ ] **OPERATOR:** Run `vercel link` if the local repo isn't linked; confirm `vercel dev` serves the Vite app on one origin
- [x] ~~Add `vitest`~~ — already present on `dev` (route-quality merge added it with `matrix.test.ts` / `optimize.test.ts`); nothing to do

### Phase 1 — Server function (§3.1) ✅ (code side)

- [x] Create `vercel.json` with `{ "functions": { "api/scan-manifest.ts": { "maxDuration": 60 } } }`
- [x] Create `api/scan-manifest.ts`:
  - [x] `SCHEMA` constant (structured-outputs JSON schema: `city`, `checkpoints[].{name, note, confidence}`, `additionalProperties: false` throughout, `anyOf` for nullables)
  - [x] `PROMPT` constant (extract checkpoints only; tasks → `note`; no invention; illegible → omit or `confidence: "low"`)
  - [x] Request validation: method guard, body field checks, `mediaType === 'image/jpeg'`, `MAX_IMAGE_CHARS` (4 M chars) cap, 120-char `hint` cap
  - [x] Origin check (`originAllowed`: allowlist + `.vercel.app` preview suffix; absent Origin passes)
  - [x] Anthropic call: `claude-opus-5`, `max_tokens: 8192`, `output_config: { effort: 'low', format: json_schema }`, `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'` (all typed in SDK 0.117.1 — no casts needed)
  - [x] Error paths: `stop_reason === 'refusal'` → 502, `stop_reason === 'max_tokens'` → 502, thrown API/key errors → 502, pass-through of the schema-validated text block on success
  - [x] One structured log line per request (image chars, checkpoint count, latency ms, model) and per failure — never image data
- [x] Handler signature settled: went with the classic Node signature (`(req: VercelRequest, res: VercelResponse)` from `@vercel/node`) rather than the Web-standard one — this `package.json` has no `"type": "module"`, so the Node signature avoids the ESM-detection gamble entirely
- [x] TypeScript config for `api/`: scoped `api/tsconfig.json` with `"types": ["node"]`; `npm run typecheck` now runs `tsc --noEmit && tsc -p api --noEmit`
- [x] Post-implementation addition: `processScan()` extracted as a framework-neutral core (origin + parsed body → `{status, body}`), with the Vercel handler reduced to a thin adapter — enables the dev middleware below without duplicating logic
- [x] Post-implementation addition: `vite.config.ts` now serves `/api/scan-manifest` under plain `npm run dev` via a `configureServer` middleware calling `processScan()`, loading `ANTHROPIC_API_KEY` from `.env.local` through `loadEnv` (never exposed to the client — no `VITE_` prefix). Added after field testing showed the first scan attempt happened under `npm run dev`, where the endpoint 404'd; `vercel dev`/`vercel link` is no longer required for local development
- [x] Verified end-to-end with the real API key against a synthetic printed-manifest photo, both by invoking the handler directly and via `npm run dev` + HTTP POST: 4/4 checkpoints extracted, city detected ("Philadelphia"), note captured ("selfie"), ~6 s latency, structured log line emitted, HTTP 200
- [ ] **OPERATOR:** Remaining photo-variety checks with real photos: handwritten manifest, sideways (EXIF-rotated) photo, and a non-manifest photo (expect an empty/near-empty `checkpoints` array, not hallucinated entries)

### Phase 2 — Client scan module (§3.2) ✅

- [x] Create `src/scan.ts`:
  - [x] `ScannedCheckpoint` / `ScanResult` interfaces
  - [x] `compressImage()`: `createImageBitmap(file, { imageOrientation: 'from-image' })`, downscale to `MAX_EDGE` 2048, JPEG q0.8, base64 without data-URL prefix
  - [x] `scanManifest()`: POST with 45 s `AbortController` timeout; 404 → "SCAN UNAVAILABLE IN THIS BUILD"; non-OK → status-coded error; response shape guard (`Array.isArray(checkpoints)`)
  - [x] Dedupe internals: `STOPWORDS`, `normalize()` (lowercase, `&`→`and`, punctuation strip, street-suffix strip), `tokens()`
  - [x] Exports: `cityTokenSet()`, `isDuplicate(a, b, cityTokens?)` (0.75 overlap vs smaller set; 1-token sets require exact equality), `labelWithCity()`
- [x] Unit tests (`src/scan.test.ts`, 15 tests, all passing) — every minimum case covered:
  - [x] "broad and girard" = "Broad & Girard" (dup)
  - [x] "Broad & Girard" = "Broad & Girard, Philadelphia" with city tokens stripped (dup)
  - [x] **"Broad & Girard, Philadelphia" ≠ "Broad & Master, Philadelphia"** (same-street regression test — bug in this plan's first draft)
  - [x] "2nd & Poplar" ≠ "4th & Poplar" (not dup)
  - [x] "Girard" ≠ "Front & Girard" (1-token equality rule) and "Girard" = "Girard Ave" (suffix strip)
  - [x] Stopword-only / empty strings never match anything
  - [x] `labelWithCity` appends only when the city isn't already in the name
  - [x] Known accepted false negative documented in a test: "2nd" ≠ "Second" (plus named-place and multi-word-city cases)

### Phase 3 — UI wiring (§3.3, §3.4) ✅

- [x] `index.html`: `▣ SCAN MANIFEST` button + hidden `<input type="file" accept="image/*" capture="environment">` in the `[03] CONTROLS` block
- [x] `style.css`: `.scan-btn` (add-btn style, amber accent), `.control-row--scanned` amber index/border + `SCAN?` chip (`.input-row::after`), `.control-note` subtitle line
- [x] `main.ts` — `addControl()` refactor to `AddControlOptions` (`existingId`, `prefill`, `note`, `scanned`, `verified`, `focus` — `verified` added so restore can recreate an already-reviewed scanned row without re-flagging it):
  - [x] Update the `applyState()` call site to the options form with `focus: false` (also kills the restore-time keyboard pop)
  - [x] Confirm the add-button call site (`addControl()`) still compiles unchanged
  - [x] Note rendering: `.control-note` div under `.input-row` when `note` is set
- [x] `main.ts` — scanned-row state:
  - [x] `controlMeta` map (`source`/`note`/`verified`)
  - [x] `clearScannedFlag(id)` wired into the row's `input` listener and autocomplete `onSelect`
  - [x] `removeControl()` also deletes from `controlMeta`
- [x] `main.ts` — `runScan()` orchestration:
  - [x] `scanInFlight` guard; button disabled + label swap during flight; everything else stays enabled
  - [x] `hint` from start input text, else GPS coords, else null
  - [x] Merge loop: re-read existing row values per iteration (`existingControlValues()`); `isDuplicate` with `cityTokenSet`; `labelWithCity` prefill; counts for added/skipped/low
  - [x] Status messages: success with counts, dupes-skipped, low-confidence warning, `RE-OPTIMIZE TO INCLUDE` when `resolvedRoute !== null`, empty-result warning, error path `[ERR] … — CONTINUE MANUAL ENTRY`. Note: `dev`'s `markRouteStale()` also fires for each appended row, disabling export and marking the route block stale — the two mechanisms compose correctly (stale styling from `markRouteStale`, final status line from `runScan`)
  - [x] `finally`: reset flag/button, clear `scanFileInput.value`
  - [x] `scheduleSave()` after merge
- [x] Wire `scanBtn` click → file input click; file input `change` → `runScan`

### Phase 4 — Persistence (§3.5) ✅

- [x] `persistence.ts`: add optional `source` / `note` / `verified` to `PersistedControl` (no version bump)
- [x] `main.ts`: `persistCurrentState()` and the share-button snapshot both read `controlMeta` via a new shared `collectControls()` helper (the two previously duplicated the same collection loop — consolidated rather than duplicated a third time)
- [x] `applyState()`: restores notes and the amber flag for `source === 'scanned' && !verified`; repopulates `controlMeta` through `addControl`'s `scanned`/`verified`/`note` options
- [x] `share.ts` verified unchanged (payload shape untouched); old localStorage payloads restore — the new fields are optional and absent-safe

### Phase 5 — Geocoding improvements (§3.6) ✅

- [x] 3.6a: ~~write geocode results back into `controlCoords`~~ — **already implemented on `dev`** (the route-quality merge added `controlCoords.set(id, coord)` in `runOptimize`'s resolve loop, plus start/finish caching); verified present, nothing to do
- [x] 3.6b: extend `GeocoderProvider` (`geocode(query, near?)`, `suggest(query, signal, near?)`)
- [x] `providers/mapbox.ts`: append `&proximity=${near.lon},${near.lat}` in both methods when provided
- [x] `providers/google.ts` / `providers/nominatim.ts`: **no change needed** — TypeScript's structural typing lets their shorter signatures satisfy the widened interface, and the plan's `_near` placeholder params would have tripped `noUnusedParameters` anyway
- [x] Call sites: `runOptimize()` passes `finishCoords` for start / `resolvedStart` for finish and controls; `attachAutocomplete` and its geocode-on-select path pass `startCoords`

### Phase 6 — Docs & housekeeping (§3.7) ✅

- [x] README: scan feature in "What it does" and the tech-stack list, `ANTHROPIC_API_KEY` in local-dev env block and Vercel deploy steps (with Sensitive marking, spend-limit note, and per-scan cost), `vercel dev` local-dev note, "Fully static" build claim amended
- [x] `.env` template: commented `# ANTHROPIC_API_KEY=` line with the "server-side only, never VITE_-prefixed" warning (matching placeholder also appended to `.env.local`). Note: both files are gitignored on `dev`, so these edits are local-machine only — the README carries the canonical documentation
- [x] `package.json` + `index.html` header bumped to v0.2.0

### Phase 7 — Verification & release (build gates ✅; device/deploy testing pending)

Build gates:

- [x] `npm run typecheck` clean (root `src/` and `api/` projects)
- [x] `npm test` clean (34 tests across scan/matrix/optimize suites)
- [x] `npm run build` clean; `dist/assets` contains no Anthropic SDK code (grep-verified — the SDK lives only in the serverless function)

Manual test matrix — **OPERATOR: all items pending** (needs a real API key, `vercel dev`, and a phone; run on `vercel dev`, then repeat the starred items on a Vercel preview deploy from a phone):

- [ ] ★ Printed manifest photo → correct rows, city appended, notes shown
- [ ] ★ Handwritten manifest → partial results acceptable, `low` confidence flagged
- [ ] Photo of a phone screen showing a manifest → works
- [ ] ★ Portrait photo taken with the phone sideways → EXIF orientation applied, extraction unaffected
- [ ] ★ Scan while actively typing in another row → no focus theft, no id collision, the row being typed dedupes against the incoming batch
- [ ] Scan completing *after* Optimize was pressed → route/map untouched, status appends `RE-OPTIMIZE TO INCLUDE`
- [ ] Double-scan of the same page → 100% dupes skipped
- [ ] Manifest with two checkpoints on the same street → **two rows** (dedupe regression case)
- [ ] ★ Airplane mode → clean `[ERR] SCAN FAILED — CONTINUE MANUAL ENTRY`, manual entry unaffected
- [x] ~~`npm run dev` (no function) → 404~~ → superseded: `npm run dev` now serves the endpoint via dev middleware (verified with a live scan); without `ANTHROPIC_API_KEY` in `.env.local` the scan fails cleanly (502) and manual entry is unaffected
- [ ] Preview deploy with `ANTHROPIC_API_KEY` deliberately unset → 500 → clean client error
- [ ] Reload mid-review → amber flags and notes survive restore, no keyboard pop on load
- [ ] Optimize twice in a row → second run issues zero geocode requests (3.6a)
- [ ] Share link after optimizing a scanned route → recipient gets all controls with coords
- [ ] Non-manifest photo (e.g. a selfie) → empty-result warning, no hallucinated rows

Release — **OPERATOR: all items pending**:

- [ ] Verify function logs in `vercel logs` show the structured line and no image data
- [ ] Confirm Anthropic console shows expected per-scan cost; spend limit is active
- [ ] If on a paid Vercel plan: add the WAF rate-limit rule for `/api/scan-manifest` (§Part 2, step 3)
- [ ] Merge `manifest-scan` → `dev` → `main`, production deploy, one live smoke-test scan from a phone on cellular

## Open Questions

1. **Gate scanning behind the ENHANCED MODE code?** Default no (friction), but it's a 5-line client change reusing `isUnlocked()` if public abuse ever shows up in the Anthropic usage dashboard. The spend cap is the real control (plus the WAF rule where the plan allows it).
2. **Notes → GPX?** Wahoo shows waypoint names; a `<desc>` per `<wpt>` with the task text would put "selfie w/ bike" on the device. Cheap follow-up once notes exist in state.
3. **Start/finish extraction:** manifests often *do* label the finish (the bar). A `finish: string | null` field in the schema is nearly free on the server side; the open question is UX (auto-fill the finish input only if it's empty?). Deferred to keep v1 merge logic simple.

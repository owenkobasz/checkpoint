# Checkpoint

A web tool for alleycat bike racers. Enter your manifest checkpoints, get an optimized route order, preview it on a map, then export a GPX file to load onto a Wahoo ELEMNT.

**[checkpoint.bike](https://checkpoint.bike)**

---

## What it does

1. Set your **start** — tap GPS or type an address
2. Set your **finish** — usually the bar
3. Enter **controls** from the manifest — intersections like "Broad & Girard" work fine
4. Hit **Optimize** — finds the shortest start-to-finish order (provably optimal up
   to 14 controls, near-optimal beyond), using real cycling distances from the
   Mapbox Matrix API when online and straight-line distances offline (labeled
   `(AIR)`)
5. **Drag to reorder** if you want to override — the total distance updates live,
   with the optimizer's baseline shown as `(OPT x.x)` so you can see what an
   override costs
6. **Export GPX** — load onto your Wahoo via USB, companion app, or wahooapp.com;
   if the routing server is unreachable, a waypoint-only GPX is exported and the
   Wahoo routes between points on-device

The Wahoo handles on-device routing between waypoints. Checkpoint just gets the points in the right order.

---

## Tech stack

- **Vite + TypeScript** — build tooling
- **Leaflet + OpenStreetMap** — map preview, no API key required
- **Google Maps JS API** — default address autocomplete and geocoding (referer-restricted browser key)
- **Mapbox Geocoding API** — fallback provider, toggleable in the header
- **SortableJS** — drag-and-drop reordering

---

## Local development

```bash
git clone <repo>
cd checkpoint
npm install
```

Copy the env template:

```bash
cp .env .env.local
```

Edit `.env.local` with your keys:

```
VITE_GOOGLE_MAPS_KEY=AIzaSy...
VITE_MAPBOX_TOKEN=pk.eyJ1...
```

The provider is auto-selected: Google whenever `VITE_GOOGLE_MAPS_KEY` is set, Mapbox otherwise. Set `VITE_GEOCODER_PROVIDER` only to force a specific one. The header button toggles between the two at runtime.

The Mapbox token is also used for the Matrix API (street-distance route optimization). Set `VITE_STREET_MATRIX=off` to disable those calls and optimize on straight-line distances only — useful as a quota kill switch.

Then start the dev server:

```bash
npm run dev
```

### Mapbox setup

Sign up at [mapbox.com](https://mapbox.com) → Account → Tokens → create a public token. Add URL restrictions:
- `http://localhost:5173` for local dev
- Your production domain for live

### Google Maps setup

Go to [console.cloud.google.com](https://console.cloud.google.com) and enable these three APIs:

- Maps JavaScript API
- Places API
- Geocoding API

Create an API key. All Google calls go through the Maps **JS** API (geocoding included), so the key can and should be locked down. Under **Application restrictions** choose **Websites** and add:

- `http://localhost:5173/*` for local dev
- `https://your-production-domain/*` for live

Under **API restrictions** limit it to the three APIs above. Since the key ships in the browser bundle, also set a daily quota cap on each API as a billing backstop.

---

## Build

```bash
npm run build
```

Output goes to `dist/`. Fully static — no server required.

---

## Deployment

### Vercel

1. Push to GitHub
2. Import the repo at vercel.com → New Project
3. Vercel auto-detects Vite — build command `npm run build`, output dir `dist`
4. Add the environment variables in Settings → Environment Variables:
   - `VITE_GOOGLE_MAPS_KEY` = your Google key (makes Google the default provider)
   - `VITE_MAPBOX_TOKEN` = your full Mapbox token (fallback provider)
   - Do **not** set `VITE_GEOCODER_PROVIDER` unless you want to force a provider
5. Settings → Domains → add your custom domain
6. After adding or changing env vars, trigger a redeploy — Vercel doesn't rebuild automatically

> **Note:** Mapbox tokens are long (`pk.eyJ1...`). Make sure the full token is pasted — Vercel's input can silently truncate on paste.

---

## GPX output

Exports a GPX 1.1 `<rte>` file with ordered `<rtept>` waypoints. Load onto Wahoo via:

- **USB** — drag into the `Routes/` folder on the device
- **Wahoo companion app** — share the `.gpx` file from your phone's Files app
- **Wahoo cloud** — upload at [my.wahooapp.com](https://my.wahooapp.com), syncs over WiFi

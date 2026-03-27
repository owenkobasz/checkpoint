# Checkpoint

A web tool for alleycat bike racers. Enter your manifest checkpoints, get an optimized route order, preview it on a map, then export a GPX file to load onto a Wahoo ELEMNT.

**[checkpoint.bike](https://checkpoint.bike)**

---

## What it does

1. Set your **start** — tap GPS or type an address
2. Set your **finish** — usually the bar
3. Enter **controls** from the manifest — intersections like "Broad & Girard" work fine
4. Hit **Optimize** — nearest-neighbor algorithm orders them efficiently
5. **Drag to reorder** if you want to override
6. **Export GPX** — load onto your Wahoo via USB, companion app, or wahooapp.com

The Wahoo handles on-device routing between waypoints. Checkpoint just gets the points in the right order.

---

## Tech stack

- **Vite + TypeScript** — build tooling
- **Leaflet + OpenStreetMap** — map preview, no API key required
- **Mapbox Geocoding API** — default address autocomplete and geocoding
- **Google Maps JS API** — enhanced geocoding, unlocked via access code
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
VITE_GEOCODER_PROVIDER=mapbox
VITE_MAPBOX_TOKEN=pk.eyJ1...
VITE_GOOGLE_MAPS_KEY=AIzaSy...
VITE_UNLOCK_HASH=sha256_hex_of_your_access_code
```

Then start the dev server:

```bash
npm run dev
```

### Generating the unlock hash

The Google geocoder is gated behind an access code. The hash of that code is stored in `VITE_UNLOCK_HASH` — never the code itself. To generate it, run this in any browser console on an HTTPS page:

```javascript
crypto.subtle
  .digest('SHA-256', new TextEncoder().encode('your-access-code'))
  .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join(''))
  .then(console.log)
```

Paste the printed hex string into `VITE_UNLOCK_HASH`.

### Mapbox setup

Sign up at [mapbox.com](https://mapbox.com) → Account → Tokens → create a public token. Add URL restrictions:
- `http://localhost:5173` for local dev
- Your production domain for live

### Google Maps setup

Go to [console.cloud.google.com](https://console.cloud.google.com) and enable these three APIs:

- Maps JavaScript API
- Places API
- Geocoding API

Create an API key. Under **Application restrictions** set it to **None** (the Geocoding REST API does not support HTTP referrer restrictions — restrict by API instead). Under **API restrictions** limit it to the three APIs above.

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
4. Add all four environment variables in Settings → Environment Variables:
   - `VITE_GEOCODER_PROVIDER` = `mapbox`
   - `VITE_MAPBOX_TOKEN` = your full Mapbox token
   - `VITE_GOOGLE_MAPS_KEY` = your Google key
   - `VITE_UNLOCK_HASH` = your hash
5. Settings → Domains → add your custom domain
6. After adding or changing env vars, trigger a redeploy — Vercel doesn't rebuild automatically

> **Note:** Mapbox tokens are long (`pk.eyJ1...`). Make sure the full token is pasted — Vercel's input can silently truncate on paste.

---

## GPX output

Exports a GPX 1.1 `<rte>` file with ordered `<rtept>` waypoints. Load onto Wahoo via:

- **USB** — drag into the `Routes/` folder on the device
- **Wahoo companion app** — share the `.gpx` file from your phone's Files app
- **Wahoo cloud** — upload at [my.wahooapp.com](https://my.wahooapp.com), syncs over WiFi

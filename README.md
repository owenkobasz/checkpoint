# Checkpoint

A web tool for alleycat bike racers. Enter your manifest checkpoints, get an optimized route order, preview it on a map, then export a GPX file to load onto a Wahoo ELEMNT.

**[Live demo →]()**

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
- **Google Maps JS API** — address autocomplete (Places) and geocoding; falls back to Nominatim if no key is configured
- **SortableJS** — drag-and-drop reordering

---

## Local development

```bash
git clone <repo>
cd checkpoint
npm install
```

Copy the env template and add your Google Maps key:

```bash
cp .env .env.local
```

Edit `.env.local`:

```
VITE_GEOCODER_PROVIDER=google
VITE_GOOGLE_MAPS_KEY=your_key_here
```

Then start the dev server:

```bash
npm run dev
```

To use without a Google key, leave `VITE_GEOCODER_PROVIDER=nominatim`. Nominatim is free but rate-limited to 1 request/second and has no autocomplete for the Places-style suggestions.

### Google Maps setup

Go to [console.cloud.google.com](https://console.cloud.google.com) and enable these three APIs on your project:

- Maps JavaScript API
- Geocoding API
- Places API

Restrict your key to HTTP referrers. For local dev add `http://localhost:*/*`.

---

## Build

```bash
npm run build
```

Output goes to `dist/`. It's a fully static site — no server required.

---

## Deployment

### Vercel / Netlify

1. Push to GitHub
2. Import the repo in Vercel or Netlify
3. Set environment variables in the dashboard:
   - `VITE_GEOCODER_PROVIDER` = `google`
   - `VITE_GOOGLE_MAPS_KEY` = your key
4. Add your production domain to the Google key's HTTP referrer allowlist

Build command: `npm run build`
Output directory: `dist`

---

## GPX output

Exports a GPX 1.1 `<rte>` file with ordered `<rtept>` waypoints. Load onto Wahoo via:

- **USB** — drag into the `Routes/` folder on the device
- **Wahoo companion app** — share the `.gpx` file from your phone's Files app
- **Wahoo cloud** — upload at [my.wahooapp.com](https://my.wahooapp.com), syncs over WiFi

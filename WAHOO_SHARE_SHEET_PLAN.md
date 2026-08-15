# Wahoo ELEMNT Missing from iOS Share Sheet — Planning Doc

## 1. The problem, in depth

### What the user experiences

On an iPhone, tapping **↓ EXPORT GPX** builds the GPX and calls `navigator.share()` with the
file. The iOS share sheet opens — so sharing itself works — but the Wahoo app ("ELEMNT",
Wahoo's companion app for ELEMNT head units) is **not listed** as a target. AirDrop, Messages,
Mail, "Save to Files", etc. appear; the one app the export exists for does not.

The comparison that makes this feel like a bug: exporting a GPX from the **Ride with GPS iOS
app** opens what looks like the same share sheet, and there ELEMNT *is* listed. So the app is
installed, it can receive GPX files, and iOS knows it — the share target exists. Something
about *our* share invocation prevents iOS from offering it.

### Expected behavior

The racer finishes planning, taps EXPORT GPX, picks ELEMNT in the share sheet, the route lands
in the Wahoo app's course list, and syncs to the head unit over BT/WiFi. Zero detours through
the Files app, no emailing the file to yourself. That is the flow this app exists to serve
(README: "export a GPX file to load onto a Wahoo ELEMNT").

Realistic restatement (spoiler from the root-cause analysis below): on current iOS, a **web
page** cannot fully reproduce what a **native app** puts in the share sheet. The achievable
expected behavior is therefore two-part:

1. **Best case** — ELEMNT appears directly in the share sheet. We should make every change
   that could allow this (correct type metadata) and verify on-device.
2. **Guaranteed case** — if iOS still refuses to list ELEMNT for web-originated shares, the
   app must provide a short, reliable, *explained* path that always works
   (save file → share from Files/Downloads → ELEMNT appears), instead of today's dead end
   where the user stares at a share sheet missing the only target they want.

### Current code (the whole export surface)

`src/main.ts:632-650`:

```typescript
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
```

Called from `runExport()` (`src/main.ts:835-864`), which first awaits `fetchRoute()` (a network
round-trip to OSRM/Mapbox) and then `exportGPX(gpx)`. Any rejection from `navigator.share()`
propagates up and is shown as `[ERR] ...` in the status bar.

Relevant history: the File was originally created with `type: 'application/gpx+xml'`
(commit `4aea616`), then commit `1315443` "fixed share" changed **only** the MIME type to
`application/octet-stream`. Whatever that fixed at the time, the analysis below shows the MIME
type is ignored by iOS entirely — so it neither caused nor can fix the ELEMNT problem, and
`octet-stream` actively hurts nothing-on-iOS-but-correctness-everywhere-else.

---

## 2. Root cause analysis

### 2.1 How iOS decides which apps appear in a share sheet

The share sheet (`UIActivityViewController`) filters targets by the **Uniform Type Identifier
(UTI)** of the items being shared, not by MIME type. Apps get into the sheet two ways:

1. **Share extension** — the app ships an extension whose `NSExtensionActivationRule`
   matches the shared items' UTIs.
2. **Document handler ("Open in / Copy to app")** — the app declares
   `CFBundleDocumentTypes` / `LSItemContentTypes` for the file's UTI. iOS surfaces these
   apps when the shared item is a **concrete file URL**.

The Wahoo companion app is (as far as can be observed from its behavior — verify in the test
plan) in category 2: it registers as a *document handler* for GPX/FIT/TCX files. That's why it
appears when you share a `.gpx` **from the Files app** or from a native app that shares a real
file URL — and it's the load-bearing detail for this bug.

Wrinkle #1: **GPX has no system-declared UTI on iOS.** Apple's own guidance is that each app
declares `com.topografix.gpx` itself (extension `gpx`, conforming to `public.data` /
`public.xml`). Different vendors have historically declared it slightly differently, which is a
long-standing source of "only one GPX app shows up" bugs on iOS
([Apple forums thread 118932](https://developer.apple.com/forums/thread/118932)). The file's
UTI is resolved from its **filename extension** through whichever declaration LaunchServices
picked as the winner among installed apps.

Wrinkle #2: since iOS 16, Apple changed how "Open in App" targets surface next to share
extensions, dropping them in several configurations
([Apple forums thread 735383](https://developer.apple.com/forums/thread/735383)). Document-
handler-only apps became *more* sensitive to exactly what kind of item is placed in the sheet.

### 2.2 What Safari actually does with `navigator.share({ files })`

This is where the web path diverges from the native path. From WebKit's share sheet
implementation ([`WKShareSheet.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Cocoa/WKShareSheet.mm)):

1. Each JS `File` is written to a temp directory (`WKFileShare/<uuid>/<name>`), with the
   filename sanitized but **the name and extension preserved**. Our `checkpoint-<ts>.gpx`
   survives intact.

2. The UTI is derived **from the file on disk, never from the JS MIME type**:

   ```objc
   static NSString *typeIdentifierForFileURL(NSURL *url)
   {
       NSString *typeIdentifier = nil;
       [url getPromisedItemResourceValue:&typeIdentifier forKey:NSURLTypeIdentifierKey error:nil];
       if (typeIdentifier)
           return typeIdentifier;
       if (RetainPtr pathExtension = [url pathExtension]) {
           if (RetainPtr type = [UTType typeWithFilenameExtension:pathExtension.get()])
               return type.get().identifier;
       }
       return UTTypeData.identifier;
   }
   ```

   So `application/octet-stream` vs `application/gpx+xml` makes **zero difference on iOS**.
   The `.gpx` extension is what's consulted. (Commit `1315443` was chasing the wrong knob.)

3. **The critical part.** For web-originated shares, WebKit does *not* hand the share sheet a
   file URL. It wraps each file in a `WKShareSheetFileItemProvider` whose placeholder item is
   an **empty `NSData`**:

   ```objc
   bool usePlaceholderFiles = data.originator == WebCore::ShareDataOriginator::Web;
   ...
   if (!(self = [super initWithPlaceholderItem:[NSData data]]))
   ```

   `UIActivityViewController` builds its target list from the *placeholder* items. A generic
   `NSData` blob is not a document, so iOS does not enumerate **document-handler apps** for
   it — the "Copy to ELEMNT"-class targets never make it into the sheet. (The provider does
   answer `dataTypeIdentifierForActivityType:` with the GPX UTI, which is enough for *share
   extensions* that filter on type, but not enough to resurrect the document-handler row on
   current iOS.) Native apps like RWGPS pass a real `NSURL` to `UIActivityViewController`
   (the `usePlaceholderFiles == false` branch in the same WebKit code shows the contrast), so
   the document-handler apps appear.

**Root cause, stated plainly:** the Wahoo app is a document handler, not a share extension.
iOS only offers document handlers for concrete file items. Safari deliberately shares
web-provided files as placeholder-wrapped data items, so ELEMNT is filtered out — regardless
of our filename, MIME type, or GPX content. RWGPS shows ELEMNT because it is a native app
sharing a real file URL through a code path web content cannot reach.

### 2.3 Secondary defects in the current export path (found while reading)

These don't cause the ELEMNT symptom but sit directly on the fix path and should be handled in
the same change:

- **B1 — Wrong MIME type.** `application/octet-stream` is meaningless on iOS (ignored) and
  wrong everywhere else (desktop downloads get a generic type; anything keying off
  `File.type` sees a lie). Correct value: `application/gpx+xml`. Reverting is safe: WebKit's
  `Navigator.cpp` share validation has no file-type checks at all, so `canShare`/`share` don't
  care.

- **B2 — Android Chrome share is guaranteed to fail, and there is no fallback.** Chromium
  enforces an extension safelist for Web Share files
  ([`share_service_impl.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/webshare/share_service_impl.cc),
  `IsDangerousFilename`): images, audio, video, pdf, txt, csv… — **`.gpx` is not on it**. The
  check runs in `share()` (browser side), *not* in `canShare()`. So on Android:
  `canShare()` → true, `share()` → rejects `NotAllowedError`, `runExport` catches it and shows
  `[ERR] ...`, and **no file is ever produced**. Android riders currently cannot export at
  all. The share failure must fall back to the download path.

- **B3 — Cancelling the share sheet shows an error.** Dismissing the sheet rejects with
  `AbortError`; `runExport` renders it as `[ERR] ABORT...`. Cancel is a normal user action and
  should be silent.

- **B4 — Share is called after an `await` of a network fetch.** `navigator.share()` requires
  transient user activation. `runExport` burns the tap's activation on `fetchRoute()` (an
  OSRM/Mapbox round trip) before sharing. On a slow network Safari can reject with
  `NotAllowedError` even though the user did tap. The B2 fallback also covers this, but it's
  worth knowing the failure exists; a future improvement is pre-fetching the track when the
  route is resolved so export shares synchronously.

---

## 3. The fix

Three phases. Phase 1 is unconditional (bug fixes). Phase 2 is the pragmatic answer to the
ELEMNT symptom. Phase 3 is the optional "real" integration, documented for a future decision.

### Phase 1 — Make `exportGPX` honest and resilient

**Move the export logic out of `main.ts` into a new module, `src/export.ts`.** This is not
cosmetic: `main.ts` runs top-level DOM lookups and event wiring at import time, so nothing in
it can be imported by a vitest suite (the repo's tests run in the default **node**
environment — no jsdom is installed, and the existing suites all test pure modules like
`scan.ts`/`optimize.ts`). Extracting mirrors the established module pattern and is what makes
the test section below possible at all.

`src/export.ts` (new) — replaces `src/main.ts:632-650`:

```typescript
export const GPX_MIME = 'application/gpx+xml'

export type ExportOutcome = 'shared' | 'downloaded' | 'cancelled'

export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function exportGPX(
  gpxString: string,
  download: (file: File) => void = downloadFile
): Promise<ExportOutcome> {
  const filename = `alleycat-${Date.now()}.gpx`
  const file = new File([gpxString], filename, { type: GPX_MIME })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Alleycat Route' })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
      // NotAllowedError (Chrome's .gpx safelist rejection, expired user
      // activation) and anything else: the file still exists locally, so
      // fall through to a plain download rather than surfacing an error.
    }
  }

  download(file)
  return 'downloaded'
}
```

The `download` parameter is the test seam: suites inject a spy and never touch
`document`/`URL.createObjectURL` (neither exists in the node test environment). `main.ts`
calls `exportGPX(gpx)` and gets the real download fallback via the default. `isIOS` and
`downloadFile` are browser-only and stay untested — they contain no branching worth covering.

And in `runExport()` (`src/main.ts:852-856`), branch the status message on the outcome:

```typescript
const outcome = await exportGPX(gpx)
if (outcome === 'cancelled') {
  setStatus('EXPORT CANCELLED', 'ok')          // or restore the previous status
} else if (outcome === 'downloaded' && isIOS()) {
  setStatus('[OK] SAVED — FILES ▸ DOWNLOADS ▸ SHARE ▸ ELEMNT', 'ok')
} else {
  setStatus(
    trackless ? '[OK] EXPORTED WITHOUT TRACK — WAHOO WILL ROUTE' : '[OK] GPX EXPORTED',
    'ok'
  )
}
```

What each change fixes:

| Change | Fixes |
|---|---|
| `application/gpx+xml` | B1. Also restores pre-`1315443` correctness; safe per WebKit source (no type validation). |
| `try/catch` around `share()` with download fallback | B2 (Android riders get a file again), B4 (activation expiry degrades gracefully). |
| `AbortError` → `'cancelled'` | B3. |
| Filename `alleycat-` | Cosmetic; matches GPX_FIX_PLAN.md Problem 5. |
| Outcome enum instead of `void` | Lets `runExport` give truthful, platform-appropriate status lines. |
| Extraction into `src/export.ts` with injectable `download` | Makes the branching testable at all — `main.ts` has import-time DOM side effects and cannot be loaded in the node-environment vitest suite. |

**Do not expect Phase 1 alone to put ELEMNT in the iOS share sheet.** Per §2.2, no property of
the `File` object can do that. Phase 1 must still be verified on-device (test plan §5) because
it's cheap and the WebKit placeholder behavior could change across iOS versions — but the plan
assumes it won't.

### Phase 2 — A guaranteed, explained path to the Wahoo app on iOS

Since iOS won't list ELEMNT for a web share, give the racer the two-tap detour and *tell them
about it*, instead of letting them discover the missing icon themselves.

Mechanism that always works today (verify per §5 first):

1. In the share sheet, choose **Save to Files** (or skip share entirely and download —
   Safari puts it in **Downloads**).
2. Open the file's context in Files/Downloads and share **from there** — now the item is a
   real file URL owned by Files, so document handlers appear, ELEMNT included. Tapping the
   file in Safari's download manager and hitting the share icon does the same thing.

Implementation — small and UI-only:

- Reuse the `isIOS()` helper from `src/export.ts` (Phase 1) — its second clause catches
  iPadOS masquerading as macOS.
- On iOS, render a one-line hint under the export bar (persistent, not a toast, so it's
  visible *while* the share sheet is up and after it closes):

  > `WAHOO: pick "Save to Files", then share the file from Files → ELEMNT`

- Keep `navigator.share` as the primary action on iOS. It's still the fastest route into
  Files, and AirDrop/Messages targets remain useful for race organizers distributing the
  route. (Alternative considered: skip the share sheet on iOS and always download to
  Downloads — one fewer tap to a shareable file, but it removes AirDrop et al. and Safari's
  download UI is easy to miss. Rejected as the default; revisit if user feedback says the
  share sheet detour confuses people.)

Files touched: `index.html` (hint element), `src/style.css` (hint styling), `src/main.ts`
(hint wiring, status copy). No new dependencies.

### Phase 3 (optional, later) — direct-to-Wahoo via the Wahoo Cloud API

The RWGPS-parity experience isn't really the share sheet — it's account-linked sync. Wahoo has
a public [Cloud API](https://developers.wahooligan.com/cloud) (OAuth2; `cloud-api.wahooligan.com`)
with a **routes** endpoint: a "CONNECT WAHOO" button could push the route straight into the
rider's Wahoo account, no file handling at all.

Sketch: Vercel functions (`api/` already exists and holds secrets for the scan feature) for
OAuth redirect/callback/token refresh; token in an httpOnly cookie or localStorage; export
button gains a "SEND TO WAHOO" variant that `POST`s the route (`external_id` +
`provider_updated_at` to dedupe, per Wahoo's docs).

Tradeoffs — why this is not the fix for this bug:

- Requires a Wahoo developer account and app approval; unknown lead time.
- OAuth state/token plumbing is the first piece of real per-user backend state in an app that
  currently has none.
- Wahoo's docs note API-imported routes sync to the newer **Wahoo app** and devices but *not*
  to the legacy ELEMNT companion app — behavior needs empirical verification against the
  user's actual app/head-unit combo before investing.
- Phase 1+2 already restore a working path this week; Phase 3 is a feature, not a bugfix.

---

## 4. Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| **Just restore `application/gpx+xml` and hope** | MIME is provably ignored by WebKit's share path (§2.2, `typeIdentifierForFileURL`). Do it for correctness (Phase 1), but it cannot fix the symptom. |
| **Different filename/extension tricks** (e.g. `.xml`, double extension) | UTI would resolve to `public.xml`/other; ELEMNT registers for GPX types. Also breaks every non-iOS consumer. Strictly worse. |
| **Share a URL instead of a file** (`navigator.share({ url })`) | The Wahoo app declares no URL-scheme/universal-link importer a web page could target; URL shares surface browsers and messengers, not GPX handlers. |
| **Server-side handoff**: `POST` the GPX to a Vercel function, get a short-lived link, navigate to it with `Content-Type: application/gpx+xml` + `Content-Disposition: attachment` | Ends in the same place as Phase 2 (Safari download manager → share from there), but adds a backend endpoint, storage/TTL for route data that currently never leaves the device, and a privacy surface. Worth it only if Phase 2's Files detour proves too confusing; keep in back pocket. |
| **Make the app a PWA with a file handler** | `file_handlers`/launch-queue is about *receiving* files, and iOS support is absent anyway. Doesn't touch the share-sheet target list. |
| **FIT/TCX export instead of GPX** | Changes the payload, not the delivery. Same placeholder-item problem. (TCX `<CoursePoint>` ideas live separately in WAHOO_WAYPOINTS_PLAN.md.) |

---

## 5. Test plan (on-device, iPhone + Wahoo app installed)

Ordered so each result narrows the diagnosis:

1. **Baseline sanity** — AirDrop the current export to a Mac; confirm the `.gpx` opens and is
   valid GPX 1.1.
2. **Document-handler check** — save the current export via "Save to Files", then in the
   Files app long-press → Share. **Expect ELEMNT in that sheet.** If it appears: confirms
   ELEMNT is a document handler and the UTI/extension chain is fine → root cause §2.2 stands,
   Phase 2 flow works, ship it. If it does *not* appear: the Wahoo app on this phone doesn't
   claim GPX at all (UTI-fragmentation wrinkle, §2.1) — then no share-sheet fix can work and
   Phase 3 / the Wahoo app's own "Import Route" button become the story.
3. **Phase 1 regression** — after switching to `application/gpx+xml`: share sheet still opens
   on iOS; desktop Safari/Chrome still download; status messages correct for share, cancel,
   download.
4. **Phase 1 on Android Chrome** — export must now produce a downloaded file (share is
   expected to be refused by Chrome's safelist; the fallback is the fix).
5. **Long-shot check** — with Phase 1 applied, look once more for ELEMNT directly in the iOS
   share sheet, so the plan's assumption (§2.2) is confirmed against the *current* iOS
   release rather than WebKit main.
6. **End-to-end** — Phase 2 flow through Files into ELEMNT; confirm the course lands in the
   Wahoo app and syncs to the head unit; waypoints render (per WAHOO_WAYPOINTS_PLAN.md).

Automated: `exportGPX`'s branching (share success / AbortError / other rejection / no
canShare) is testable in the repo's existing node-environment vitest setup — no jsdom needed.
`File` and `DOMException` are native globals in Node ≥ 20 (repo runs Node 22), `navigator` is
stubbed with `vi.stubGlobal`, and the download path is observed through the injected `download`
spy. Add the suite alongside the change per house style.

---

## 6. Files changed

| File | Change |
|---|---|
| `src/export.ts` (new) | `GPX_MIME`, `ExportOutcome`, `isIOS`, `downloadFile`, `exportGPX` (MIME fix, outcome enum, fallback-on-rejection, `alleycat-` filename, injectable download seam). |
| `src/main.ts` | Delete the old `exportGPX` block (`632-650`); import from `./export`; branch `runExport` status handling on the outcome; wire the iOS hint. |
| `index.html` | One hint element under the export bar (hidden by default, toggled from JS). |
| `src/style.css` | Styling for the hint (small, persistent, matches status-bar aesthetic). |
| `src/export.test.ts` (new) | Outcome-branch tests: stubbed `navigator`, injected download spy, node environment. |

No new dependencies. Phase 3, if ever pursued, is a separate plan.

---

## 7. Todo list

### Phase 0 — Validate the diagnosis on-device (no code) — ⏳ needs the iPhone; only remaining work besides Verification

> Implementation note: Phases 1–2 were built ahead of this check (they are correct
> regardless — B1/B2/B3 are plain bugs). If the §5.2 Files-app test shows ELEMNT missing
> even there, revisit Phase 2's hint copy before merging.

- [ ] Export a GPX with the current build on the iPhone, choose **Save to Files**, then in the Files app long-press the file → Share. Record whether ELEMNT appears in that second sheet (test plan §5.2).
  - [ ] If ELEMNT appears: diagnosis confirmed (document handler + placeholder-item filtering). Proceed with Phases 1–2 as written.
  - [ ] If ELEMNT does **not** appear: stop — the Wahoo app on this phone isn't claiming GPX at all. Re-scope around the Wahoo app's in-app "Import Route" flow and/or Phase 3, and update §2/§3 of this doc before writing code.
- [ ] AirDrop one export to a Mac and sanity-check the file is valid GPX 1.1 (test plan §5.1).
- [ ] Note the iOS version tested, in this doc, for future reference.

### Phase 1 — `exportGPX` rework ✅ (branch `wahoo-share-fix`)

- [x] Create `src/export.ts` and move the export logic there (`main.ts` cannot be imported by tests — it runs DOM lookups at module load). Exports: `GPX_MIME`, `ExportOutcome`, `isIOS`, `downloadFile`, `exportGPX`.
- [x] `GPX_MIME = 'application/gpx+xml'`, used when constructing the `File` (revert of commit `1315443`).
- [x] Rename the export filename prefix `checkpoint-` → `alleycat-`.
- [x] `downloadFile(file: File)` helper: the existing anchor-click block, using `file.name`.
- [x] `exportGPX(gpxString, download = downloadFile): Promise<ExportOutcome>` — the `download` parameter is the test seam; production callers rely on the default.
- [x] Wrap `navigator.share()` in `try/catch`:
  - [x] `AbortError` → return `'cancelled'` (no error status).
  - [x] Any other rejection (Chrome `.gpx` safelist, expired user activation) → fall through to `download(file)` and return `'downloaded'`.
- [x] `isIOS()` helper (UA test incl. the iPadOS-as-macOS clause; touches `document`, browser-only, not under test).
- [x] In `src/main.ts`: delete the old `exportGPX`/fallback block, import from `./export`, and branch `runExport()` status messages on the outcome:
  - [x] `'cancelled'` → neutral "EXPORT CANCELLED", not `[ERR]`.
  - [x] `'downloaded'` + `isIOS()` → `[OK] SAVED — FILES ▸ DOWNLOADS ▸ SHARE ▸ ELEMNT`.
  - [x] `'shared'` / `'downloaded'` elsewhere → keep existing `[OK] GPX EXPORTED` / trackless variant.
- [x] Run `npm run typecheck` clean (no `any`/`unknown` escapes).

### Phase 1 — tests (`src/export.test.ts`, new) ✅

- [x] Node environment (repo default — no jsdom dependency; `File` and `DOMException` are Node ≥ 20 globals, repo runs Node 22). Stub the share API with `vi.stubGlobal('navigator', { canShare: ..., share: ... })`; restore with `vi.unstubAllGlobals()` after each test. Pass a `vi.fn()` as the `download` argument — never exercise the real `downloadFile` (needs `document`).
- [x] Case: `canShare` true, `share` resolves → `'shared'`, download spy not called.
- [x] Case: `share` rejects `new DOMException('cancel', 'AbortError')` → `'cancelled'`, download spy not called.
- [x] Case: `share` rejects `new DOMException('denied', 'NotAllowedError')` → `'downloaded'`, download spy called once (plus a non-DOMException rejection case).
- [x] Case: `canShare` missing entirely (bare `navigator` stub) → `'downloaded'`, share never attempted.
- [x] Case: `canShare` returns false → `'downloaded'`.
- [x] Assert the `File` passed to `share` has name matching `/^alleycat-\d+\.gpx$/` and type `application/gpx+xml` (same assertions on the downloaded file).
- [x] `npm run test` green (41 tests, 7 new).

### Phase 2 — iOS guidance UI ✅

- [x] Add the hint element under the export bar in `index.html` (hidden by default; sits inside `#block-route`, so it only appears once a route exists).
- [x] In `src/main.ts`, show the hint only when `isIOS()`; copy: `WAHOO: PICK "SAVE TO FILES", THEN SHARE THE FILE FROM FILES → ELEMNT` (uppercase to match the UI's type treatment).
- [x] Style the hint in `src/style.css` to match the existing status-bar aesthetic (small, persistent, non-toast) so it stays legible while the share sheet is up.
- [x] Hint cannot render on desktop or Android: `.hidden` in markup, removed only behind `isIOS()`. (Visual spot-check on a real device is part of Verification below.)

### Verification (device matrix, after Phases 1–2) — ⏳ needs real devices (code side is done: typecheck, 41 tests, and `npm run build` all pass on `wahoo-share-fix`)

- [ ] iPhone Safari: share sheet opens; cancel is silent; "Save to Files" → Files → Share → ELEMNT → course lands in Wahoo app and syncs to the head unit (test plan §5.6).
- [ ] iPhone Safari: one more look for ELEMNT directly in the share sheet post-MIME-fix, to confirm §2.2 against the current iOS release (test plan §5.5).
- [ ] Android Chrome: export now yields a downloaded `.gpx` instead of `[ERR]` (test plan §5.4).
- [ ] Desktop Safari + Chrome: plain download still works, correct filename/MIME (test plan §5.3).
- [ ] Update README's export blurb if the iOS flow description changes.

### Phase 3 (optional, separate effort — decide after Phases 1–2 ship)

- [ ] Decide go/no-go with real usage feedback: is the Files detour acceptable?
- [ ] Register a Wahoo developer account; confirm API access/approval lead time.
- [ ] Empirically verify a Cloud-API-imported route reaches this user's app/head-unit combo (docs say it syncs to the newer Wahoo app + devices, not the legacy ELEMNT companion app).
- [ ] If viable, write a separate plan doc: OAuth endpoints in `api/`, token storage, "SEND TO WAHOO" button, `external_id`/`provider_updated_at` dedupe.

---

## Sources

- WebKit share sheet implementation (temp files, filename sanitization, `typeIdentifierForFileURL`, `WKShareSheetFileItemProvider` placeholder): [WKShareSheet.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Cocoa/WKShareSheet.mm)
- WebKit `Navigator::share/canShare` — no file-type restrictions: [Navigator.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/Navigator.cpp)
- Chromium Web Share extension safelist (no `.gpx`): [share_service_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/webshare/share_service_impl.cc)
- GPX UTI fragmentation on iOS: [Apple Developer Forums thread 118932](https://developer.apple.com/forums/thread/118932)
- iOS 16+ "Open in App" no longer shown alongside share extensions: [Apple Developer Forums thread 735383](https://developer.apple.com/forums/thread/735383)
- Web Share spec leaves file-type blocking to implementations: [W3C Web Share](https://w3c.github.io/web-share/), [MDN navigator.canShare](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/canShare)
- Wahoo Cloud API (OAuth2, routes endpoint, ELEMNT-app sync caveat): [developers.wahooligan.com/cloud](https://developers.wahooligan.com/cloud), [API reference](https://cloud-api.wahooligan.com/)
- Community-documented GPX→Wahoo workflows (Files-app detour): [Cycling UK guide](https://www.cyclinguk.org/group/page/gpx-file-smart-phone-garminwahoo), [RWGPS Send to Device](https://support.ridewithgps.com/hc/en-us/articles/13004717775515-Send-to-Device-on-Mobile)

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
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('IMAGE ENCODE FAILED')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
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
  return dataURL.slice(dataURL.indexOf(',') + 1)
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
// comparing, so an appended ", Philadelphia" suffix never counts as overlap.
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

export function labelWithCity(name: string, city: string | null): string {
  if (!city) return name
  return normalize(name).includes(normalize(city)) ? name : `${name}, ${city}`
}

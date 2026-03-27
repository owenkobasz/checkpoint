import { switchProvider, getProviderName } from './geocoder'

const HASH = import.meta.env.VITE_UNLOCK_HASH?.toLowerCase() ?? ''

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  )
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function tryUnlock(password: string): Promise<boolean> {
  if (!HASH) return false
  const hash = await sha256hex(password)
  if (hash !== HASH) return false
  switchProvider('google')
  return true
}

export function isUnlocked(): boolean {
  return getProviderName() === 'google'
}

export function lock(): void {
  switchProvider('mapbox')
}

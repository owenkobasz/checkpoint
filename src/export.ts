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
      // Anything else (Chrome's .gpx safelist rejection, expired user
      // activation): the file still exists locally, so fall through to a
      // plain download rather than surfacing an error.
    }
  }

  download(file)
  return 'downloaded'
}

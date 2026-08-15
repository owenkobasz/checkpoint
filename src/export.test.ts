import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportGPX, GPX_MIME } from './export'

const GPX = '<?xml version="1.0"?><gpx></gpx>'

function stubNavigator(nav: Partial<Navigator>): void {
  vi.stubGlobal('navigator', nav)
}

function shareStub(result: Promise<void>) {
  const share = vi.fn<(data: ShareData) => Promise<void>>().mockReturnValue(result)
  stubNavigator({ canShare: () => true, share })
  return share
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('exportGPX', () => {
  it('returns "shared" when share resolves, without downloading', async () => {
    const share = shareStub(Promise.resolve())
    const download = vi.fn<(file: File) => void>()

    await expect(exportGPX(GPX, download)).resolves.toBe('shared')
    expect(share).toHaveBeenCalledOnce()
    expect(download).not.toHaveBeenCalled()
  })

  it('shares a .gpx File with the correct name and MIME type', async () => {
    const share = shareStub(Promise.resolve())

    await exportGPX(GPX, vi.fn<(file: File) => void>())

    const file = share.mock.calls[0]?.[0]?.files?.[0]
    expect(file).toBeDefined()
    expect(file?.name).toMatch(/^alleycat-\d+\.gpx$/)
    expect(file?.type).toBe(GPX_MIME)
  })

  it('returns "cancelled" on AbortError, without downloading', async () => {
    shareStub(Promise.reject(new DOMException('user cancelled', 'AbortError')))
    const download = vi.fn<(file: File) => void>()

    await expect(exportGPX(GPX, download)).resolves.toBe('cancelled')
    expect(download).not.toHaveBeenCalled()
  })

  it('falls back to download when share rejects with NotAllowedError', async () => {
    shareStub(Promise.reject(new DOMException('denied', 'NotAllowedError')))
    const download = vi.fn<(file: File) => void>()

    await expect(exportGPX(GPX, download)).resolves.toBe('downloaded')
    expect(download).toHaveBeenCalledOnce()
    const file = download.mock.calls[0]?.[0]
    expect(file?.name).toMatch(/^alleycat-\d+\.gpx$/)
    expect(file?.type).toBe(GPX_MIME)
  })

  it('falls back to download on non-DOMException share failures', async () => {
    shareStub(Promise.reject(new TypeError('bad share data')))
    const download = vi.fn<(file: File) => void>()

    await expect(exportGPX(GPX, download)).resolves.toBe('downloaded')
    expect(download).toHaveBeenCalledOnce()
  })

  it('downloads when canShare is not implemented', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>()
    stubNavigator({ share })
    const download = vi.fn<(file: File) => void>()

    await expect(exportGPX(GPX, download)).resolves.toBe('downloaded')
    expect(share).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledOnce()
  })

  it('downloads when canShare returns false', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>()
    stubNavigator({ canShare: () => false, share })
    const download = vi.fn<(file: File) => void>()

    await expect(exportGPX(GPX, download)).resolves.toBe('downloaded')
    expect(share).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledOnce()
  })
})

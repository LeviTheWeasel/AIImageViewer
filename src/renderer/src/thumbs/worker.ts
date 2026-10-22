// Decodes an image and re-encodes it as a small WebP, off the UI thread.
export interface ThumbRequest {
  id: number
  url: string
  max: number
}
export type ThumbResponse = { id: number; ok: true; data: ArrayBuffer } | { id: number; ok: false; error: string }

self.onmessage = async (e: MessageEvent<ThumbRequest>) => {
  const { id, url, max } = e.data
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const full = await createImageBitmap(await res.blob())
    const scale = Math.min(1, max / Math.max(full.width, full.height))
    const w = Math.max(1, Math.round(full.width * scale))
    const h = Math.max(1, Math.round(full.height * scale))
    const small = scale < 1 ? await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }) : full
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d')!.drawImage(small, 0, 0)
    full.close()
    if (small !== full) small.close()
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
    const data = await blob.arrayBuffer()
    const msg: ThumbResponse = { id, ok: true, data }
    ;(self as unknown as Worker).postMessage(msg, [data])
  } catch (err) {
    const msg: ThumbResponse = { id, ok: false, error: String(err) }
    ;(self as unknown as Worker).postMessage(msg)
  }
}

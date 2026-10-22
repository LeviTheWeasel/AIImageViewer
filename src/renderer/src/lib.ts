import { useEffect, useState } from 'react'
import type { FileEntry, ImageMeta } from '@shared/types'

export const fileUrl = (path: string) => `aiv://file/${encodeURIComponent(path)}`

const cache = new Map<string, Promise<ImageMeta>>()
const key = (f: FileEntry) => `${f.path}|${f.mtime}`

export function loadMeta(f: FileEntry): Promise<ImageMeta> {
  let p = cache.get(key(f))
  if (!p) {
    p = window.api.meta(f.path).catch((e) => ({
      path: f.path, format: 'other', hasPrompt: false, hasWorkflow: false, chunks: {}, error: String(e)
    }) as ImageMeta)
    cache.set(key(f), p)
  }
  return p
}

export function clearMetaCache() {
  cache.clear()
}

export function useMeta(f: FileEntry | undefined): ImageMeta | undefined {
  const [meta, setMeta] = useState<ImageMeta>()
  useEffect(() => {
    setMeta(undefined)
    if (!f) return
    let alive = true
    loadMeta(f).then((m) => alive && setMeta(m))
    return () => {
      alive = false
    }
  }, [f?.path, f?.mtime])
  return meta
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

export function loadPref<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function savePref(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    // storage unavailable — prefs just won't persist
  }
}

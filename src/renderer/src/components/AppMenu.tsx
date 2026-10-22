import { useEffect, useRef, useState } from 'react'
import type { ThumbStats } from '@shared/types'
import { formatBytes } from '../lib'

/** "⋯" menu in the toolbar for maintenance actions. */
export default function AppMenu() {
  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<ThumbStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setResult(null)
    setStats(null)
    window.api.thumbStats().then(setStats)
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const clear = async (mode: 'all' | 'unused') => {
    setBusy(true)
    try {
      const r = await window.api.clearThumbs(mode)
      setResult(r.count ? `Removed ${r.count.toLocaleString()} thumbnails (${formatBytes(r.bytes)}).` : 'Nothing to remove.')
      setStats(await window.api.thumbStats())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="menu" ref={ref}>
      <button className={open ? 'on' : undefined} onClick={() => setOpen((v) => !v)} title="More">⋯</button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-title">Thumbnail cache</div>
          <div className="menu-info">
            {stats
              ? `${stats.count.toLocaleString()} thumbnails · ${formatBytes(stats.bytes)}`
              : 'Counting…'}
          </div>
          <button
            role="menuitem"
            disabled={busy || !stats?.unusedCount}
            onClick={() => clear('unused')}
            title="Thumbnails of files that changed, were deleted, or belong to folders no longer open"
          >
            Remove unused thumbnails
            {stats ? <span className="muted"> {stats.unusedCount.toLocaleString()} · {formatBytes(stats.unusedBytes)}</span> : null}
          </button>
          <button role="menuitem" disabled={busy || !stats?.count} onClick={() => clear('all')}>
            Clear all thumbnails
          </button>
          {result && <div className="menu-result">{result}</div>}
          <div className="menu-note">Thumbnails are rebuilt automatically as you browse.</div>
        </div>
      )}
    </div>
  )
}

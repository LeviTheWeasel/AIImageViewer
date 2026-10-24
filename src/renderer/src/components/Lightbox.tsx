import { useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { fileUrl } from '../lib'
import Details from './Details'

interface Props {
  file: FileEntry
  index: number
  total: number
  onClose: () => void
  onNav: (delta: number) => void
  fav: boolean
  onToggleFav: () => void
  onTrash: () => void
  onMove: () => void
}

export default function Lightbox({ file, index, total, onClose, onNav, fav, onToggleFav, onTrash, onMove }: Props) {
  // Fit to window by default; click toggles 1:1 pixels.
  const [actual, setActual] = useState(false)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    panelRef.current?.scrollTo(0, 0)
  }, [file.path])

  // Clicks on the blurred backdrop close; clicks on the image, buttons or panel don't.
  const closeOnBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="lightbox">
      <div
        className={`lb-stage${actual ? ' actual' : ''}`}
        onClick={closeOnBackdrop}
        onWheel={(e) => !actual && onNav(e.deltaY > 0 ? 1 : -1)}
      >
        <img
          key={file.path}
          src={fileUrl(file.path)}
          alt=""
          draggable={false}
          onClick={() => setActual((v) => !v)}
          title={actual ? 'Click to fit' : 'Click for 100%'}
        />
        <button className="lb-nav prev" disabled={index === 0} onClick={() => onNav(-1)}>‹</button>
        <button className="lb-nav next" disabled={index === total - 1} onClick={() => onNav(1)}>›</button>
        <div className="lb-caption">
          {index + 1}/{total} · Esc to close
        </div>
      </div>
      <aside className="lb-panel" ref={panelRef}>
        <button className="lb-close" onClick={onClose} title="Close (Esc)">✕</button>
        <Details file={file} showPreview={false} fav={fav} onToggleFav={onToggleFav} onTrash={onTrash} onMove={onMove} />
      </aside>
    </div>
  )
}

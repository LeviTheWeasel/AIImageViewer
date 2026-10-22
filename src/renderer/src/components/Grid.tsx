import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { FileEntry } from '@shared/types'
import { fileUrl, useMeta } from '../lib'
import { makeThumb, thumbUrl } from '../thumbs'

const GAP = 8

export interface SelectMods {
  /** Ctrl/Cmd: add or remove one image. */
  toggle: boolean
  /** Shift: select the range from the last clicked image. */
  shift: boolean
}

interface Props {
  files: FileEntry[]
  size: number
  selected: number
  picked: Set<string>
  favs: Set<string>
  onSelect: (i: number, mods: SelectMods) => void
  onOpen: (i: number) => void
  onFav: (path: string) => void
  onCols: (n: number) => void
}

export default function Grid({ files, size, selected, picked, favs, onSelect, onOpen, onFav, onCols }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const inner = Math.max(0, width - GAP * 2)
  const cols = Math.max(1, Math.floor((inner + GAP) / (size + GAP)))
  const cell = cols > 0 ? Math.floor((inner - GAP * (cols - 1)) / cols) : size
  const rows = Math.ceil(files.length / cols)

  useEffect(() => onCols(cols), [cols, onCols])

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => cell + GAP,
    overscan: 4
  })

  useEffect(() => {
    virt.measure()
  }, [cell, virt])

  useEffect(() => {
    if (files.length) virt.scrollToIndex(Math.floor(selected / cols), { align: 'auto' })
  }, [selected, cols, files.length, virt])

  return (
    <div className="grid-scroll" ref={scrollRef}>
      <div style={{ height: virt.getTotalSize() + GAP * 2, position: 'relative' }}>
        {virt.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="grid-row"
            style={{ transform: `translateY(${row.start + GAP}px)`, height: cell, gap: GAP, paddingInline: GAP }}
          >
            {Array.from({ length: cols }, (_, c) => {
              const i = row.index * cols + c
              const f = files[i]
              return f ? (
                <Cell
                  key={f.path}
                  file={f}
                  size={cell}
                  index={i}
                  active={i === selected}
                  picked={picked.has(f.path)}
                  fav={favs.has(f.path)}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onFav={onFav}
                />
              ) : null
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

interface CellProps {
  file: FileEntry
  size: number
  index: number
  active: boolean
  picked: boolean
  fav: boolean
  onSelect: Props['onSelect']
  onOpen: Props['onOpen']
  onFav: Props['onFav']
}

const Cell = memo(function Cell({ file, size, index, active, picked, fav, onSelect, onOpen, onFav }: CellProps) {
  const meta = useMeta(file)
  return (
    <div
      className={`cell${active ? ' active' : ''}${picked ? ' picked' : ''}`}
      style={{ width: size, height: size }}
      onClick={(e) => onSelect(index, { toggle: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      onDoubleClick={() => onOpen(index)}
      title={file.rel}
      draggable
      onDragStart={(e) => {
        e.preventDefault()
        window.api.startDrag(file.path)
      }}
    >
      <Thumb file={file} />
      <button
        className={`cell-fav${fav ? ' on' : ''}`}
        title={fav ? 'Remove from favorites (F)' : 'Add to favorites (F)'}
        onClick={(e) => {
          e.stopPropagation()
          onFav(file.path)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {fav ? '★' : '☆'}
      </button>
      {meta && (
        <div className="cell-badges">
          {meta.hasWorkflow ? <span className="badge wf" title="Has ComfyUI workflow">WF</span>
            : meta.hasPrompt ? <span className="badge api" title="API prompt only, no UI workflow">API</span>
            : meta.a1111 ? <span className="badge params" title="Generation parameters as text (A1111 format)">TXT</span>
            : null}
        </div>
      )}
    </div>
  )
})

/** Cached thumbnail; on a cache miss it is generated in a worker, falling back to the original on failure. */
function Thumb({ file }: { file: FileEntry }) {
  const [src, setSrc] = useState(() => thumbUrl(file))
  const jobRef = useRef<{ cancel: () => void } | null>(null)
  const objectUrl = useRef<string | null>(null)

  useEffect(() => {
    setSrc(thumbUrl(file))
    return () => {
      jobRef.current?.cancel()
      jobRef.current = null
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = null
    }
  }, [file.path, file.mtime, file.size])

  const onError = () => {
    if (src !== thumbUrl(file) || jobRef.current) {
      // The generated thumbnail or the original failed too — nothing more to try.
      if (src !== fileUrl(file.path)) setSrc(fileUrl(file.path))
      return
    }
    const job = makeThumb(file)
    jobRef.current = job
    job.promise.then(
      (url) => {
        objectUrl.current = url
        setSrc(url)
      },
      (e) => {
        console.warn('Thumbnail failed for', file.path, e)
        setSrc(fileUrl(file.path))
      }
    )
  }

  return <img src={src} decoding="async" draggable={false} alt="" onError={onError} />
}

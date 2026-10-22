import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import Grid, { type SelectMods } from './components/Grid'
import Details from './components/Details'
import Lightbox from './components/Lightbox'
import AppMenu from './components/AppMenu'
import FolderTree, { ALL, buildTrees, dirOfFile, isUnder } from './components/FolderTree'
import { clearMetaCache, loadPref, savePref } from './lib'
import { HighlightContext, highlightTerms, matches, parseQuery, prepare, type Prepared } from './search'

type Sort = 'newest' | 'oldest' | 'name'

export default function App() {
  /** Opened top-level folders. Migrates the single `folder` pref from earlier versions. */
  const [roots, setRoots] = useState<string[]>(() => {
    const legacy = loadPref<string | null>('folder', null)
    return loadPref('roots', legacy ? [legacy] : [])
  })
  const [missing, setMissing] = useState<string[]>([])
  const [recursive, setRecursive] = useState(() => loadPref('recursive', true))
  const [sort, setSort] = useState<Sort>(() => loadPref('sort', 'newest'))
  const [thumb, setThumb] = useState(() => loadPref('thumb', 180))
  const [onlyFav, setOnlyFav] = useState(() => loadPref('onlyFav', false))
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const searchRef = useRef<HTMLInputElement>(null)
  /** Search index: path → prepared haystacks; filled in the background after each scan. */
  const indexRef = useRef(new Map<string, Prepared>())
  const runRef = useRef(0)
  const [indexVersion, setIndexVersion] = useState(0)
  const [indexed, setIndexed] = useState({ done: 0, total: 0 })
  /** Absolute folder picked in the tree, or ALL for every opened folder. */
  const [subdir, setSubdir] = useState<string>(() => loadPref('selDir', ALL))
  const [files, setFiles] = useState<FileEntry[]>([])
  const [favs, setFavs] = useState<Set<string>>(new Set())
  /** Focused image (shown in details / lightbox), by path so it survives filtering. */
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  /** Multi-selection; empty means "just the focused image". */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const anchorRef = useRef(0)
  const lastIndexRef = useRef(0)
  const [cols, setCols] = useState(1)
  const [lightbox, setLightbox] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => savePref('roots', roots), [roots])
  useEffect(() => savePref('recursive', recursive), [recursive])
  useEffect(() => savePref('sort', sort), [sort])
  useEffect(() => savePref('thumb', thumb), [thumb])
  useEffect(() => savePref('onlyFav', onlyFav), [onlyFav])
  useEffect(() => savePref('selDir', subdir), [subdir])
  // A new folder in the tree starts from its first image.
  useEffect(() => {
    setCurrentPath(null)
    setPicked(new Set())
    lastIndexRef.current = 0
  }, [subdir])

  const addFolder = (raw: string) => {
    const p = raw.length > 1 ? raw.replace(/[\\/]+$/, '') : raw
    setRoots((prev) => {
      if (prev.some((r) => isUnder(p, r))) return prev // already covered: just jump to it
      // A new parent folder absorbs roots nested inside it.
      return [...prev.filter((r) => !isUnder(r, p)), p]
    })
    setSubdir(p)
  }

  const removeFolder = (p: string) => {
    setRoots((prev) => prev.filter((r) => r !== p))
    setSubdir((sel) => (isUnder(sel, p) ? ALL : sel))
  }

  useEffect(() => {
    window.api.favorites().then((list) => setFavs(new Set(list)))
  }, [])

  const rescan = useCallback(async () => {
    if (!roots.length) {
      setFiles([])
      setMissing([])
      return
    }
    setLoading(true)
    setError(null)
    clearMetaCache()
    try {
      // Always scan whole trees; "Subfolders" only decides what the selected folder shows.
      const r = await window.api.scan(roots)
      setFiles(r.files)
      setMissing(r.missing)
    } catch (e) {
      setFiles([])
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }, [roots])

  useEffect(() => {
    rescan()
    setCurrentPath(null)
    setPicked(new Set())
  }, [rescan])


  // Fall back to "all" if the remembered folder is gone.
  useEffect(() => {
    if (loading || subdir === ALL) return
    const known = roots.includes(subdir) || files.some((f) => isUnder(dirOfFile(f), subdir))
    if (!known) setSubdir(ALL)
  }, [files, roots, subdir, loading])

  // Build the search index for every scanned file.
  useEffect(() => {
    return window.api.onIndexProgress((p) => {
      if (p.run < runRef.current) return // a newer scan already started
      if (p.run > runRef.current) {
        runRef.current = p.run
        indexRef.current = new Map()
      }
      for (const d of p.docs) indexRef.current.set(d.path, prepare(d))
      setIndexed({ done: p.done, total: p.total })
      setIndexVersion((v) => v + 1)
    })
  }, [])
  useEffect(() => {
    if (files.length) window.api.index(files.map((f) => f.path))
    else setIndexed({ done: 0, total: 0 })
  }, [files])

  const terms = useMemo(() => parseQuery(deferredQuery), [deferredQuery])
  const highlight = useMemo(() => highlightTerms(terms), [terms])
  const indexing = indexed.done < indexed.total

  /** Search + favorites filter, independent of the selected folder. */
  const passes = useMemo(() => {
    const idx = indexRef.current
    return (f: FileEntry) => {
      if (onlyFav && !favs.has(f.path)) return false
      if (!terms.length) return true
      const p = idx.get(f.path)
      return !!p && matches(p, terms)
    }
    // indexVersion: the index map is mutated in place as batches arrive
  }, [onlyFav, favs, terms, indexVersion])

  const trees = useMemo(() => buildTrees(files, roots, missing, passes), [files, roots, missing, passes])

  const visible = useMemo(() => {
    const inFolder = (f: FileEntry) => {
      const d = dirOfFile(f)
      if (subdir === ALL) return recursive || d === f.root
      return recursive ? isUnder(d, subdir) : d === subdir
    }
    const a = files.filter((f) => inFolder(f) && passes(f))
    if (sort === 'name') a.sort((x, y) => x.rel.localeCompare(y.rel, undefined, { numeric: true }))
    else a.sort((x, y) => (sort === 'newest' ? y.mtime - x.mtime : x.mtime - y.mtime))
    return a
  }, [files, sort, subdir, recursive, passes])

  // If the focused image left the list (e.g. un-favorited while filtering), stay at the same position.
  const found = currentPath ? visible.findIndex((f) => f.path === currentPath) : -1
  const selected = found >= 0 ? found : Math.min(lastIndexRef.current, visible.length - 1)
  if (selected >= 0) lastIndexRef.current = selected
  const current = visible[selected]

  const focus = useCallback(
    (i: number) => {
      const f = visible[Math.min(visible.length - 1, Math.max(0, i))]
      if (f) setCurrentPath(f.path)
    },
    [visible]
  )

  const selectedPaths = useMemo(
    () => (picked.size ? [...picked] : current ? [current.path] : []),
    [picked, current]
  )

  const onSelect = useCallback(
    (i: number, mods: SelectMods) => {
      const f = visible[i]
      if (!f) return
      if (mods.shift) {
        const [a, b] = [anchorRef.current, i].sort((x, y) => x - y)
        setPicked(new Set(visible.slice(a, b + 1).map((x) => x.path)))
      } else if (mods.toggle) {
        setPicked((prev) => {
          const next = new Set(prev.size ? prev : current ? [current.path] : [])
          next.has(f.path) ? next.delete(f.path) : next.add(f.path)
          return next
        })
        anchorRef.current = i
      } else {
        setPicked(new Set())
        anchorRef.current = i
      }
      setCurrentPath(f.path)
    },
    [visible, current]
  )

  /** Favorite all given paths, or un-favorite them if they all already are. */
  const toggleFav = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return
      const on = !paths.every((p) => favs.has(p))
      setFavs(new Set(await window.api.setFavorite(paths, on)))
    },
    [favs]
  )

  const detailsRef = useRef<HTMLElement>(null)
  useEffect(() => {
    detailsRef.current?.scrollTo(0, 0)
  }, [current?.path])

  const pick = async () => {
    const p = await window.api.pickFolder()
    if (p) addFolder(p)
  }

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
        e.preventDefault()
        setLightbox(false)
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return
      const n = visible.length
      if (!n) return
      const step = lightbox
        ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }
        : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }
      const d = step[e.key as keyof typeof step]
      if (d) {
        e.preventDefault()
        setPicked(new Set())
        focus(selected + d)
        anchorRef.current = Math.min(n - 1, Math.max(0, selected + d))
      } else if (e.key === 'Home') focus(0)
      else if (e.key === 'End') focus(n - 1)
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setLightbox((v) => !v)
      } else if (e.key === 'Escape') {
        if (lightbox) setLightbox(false)
        else setPicked(new Set())
      } else if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        toggleFav(lightbox && current ? [current.path] : selectedPaths)
      } else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey) && !lightbox) {
        e.preventDefault()
        setPicked(new Set(visible.map((f) => f.path)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, selected, cols, lightbox, focus, toggleFav, selectedPaths, current])

  // Drop a folder onto the window to add it
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (!f) return
    const p = window.api.pathForFile(f)
    if (p) addFolder(f.type === '' && !/\.\w+$/.test(f.name) ? p : p.replace(/[\\/][^\\/]*$/, ''))
  }

  const favCount = useMemo(() => files.filter((f) => favs.has(f.path)).length, [files, favs])
  const multi = picked.size > 1
  const allPickedFav = multi && [...picked].every((p) => favs.has(p))

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="toolbar">
        <button className="primary" onClick={pick} title="Add a folder to the viewer (or drop one onto the window)">
          Add folder…
        </button>
        <div className="folder" title={subdir || roots.join('\n')}>
          {subdir ? '‎' + subdir : roots.length > 1 ? `All folders (${roots.length})` : roots[0] ? '‎' + roots[0] : 'No folder opened'}
        </div>
        <div className={`search${query ? ' has-query' : ''}`}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                e.currentTarget.blur()
              } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.currentTarget.blur()
              }
            }}
            placeholder="Search prompts…"
            title={'Words must all match (prompt, LoRA, model, file name).\n"two words" — phrase · -word — exclude\nneg: lora: model: seed: file: — search one field\nCtrl+F to focus, Esc to clear'}
            spellCheck={false}
          />
          {indexing && (
            <span className="search-progress" title="Reading prompts from all images for search">
              indexing {Math.floor((indexed.done / indexed.total) * 100)}%
            </span>
          )}
          {query && <button className="search-clear" onClick={() => setQuery('')} title="Clear (Esc)">×</button>}
        </div>
        <label className="check" title="Also show images from subfolders of the selected folder">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          Subfolders
        </label>
        <button
          className={`fav-filter${onlyFav ? ' on' : ''}`}
          onClick={() => setOnlyFav((v) => !v)}
          title="Show only favorites"
        >
          {onlyFav ? '★' : '☆'} Favorites <span className="muted">{favCount}</span>
        </button>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">By name</option>
        </select>
        <input
          type="range" min={100} max={360} step={20} value={thumb}
          onChange={(e) => setThumb(Number(e.target.value))} title="Thumbnail size"
        />
        <button onClick={rescan} disabled={!roots.length || loading} title="Rescan folders">↻</button>
        <span className="count">{loading ? 'Scanning…' : `${visible.length} images`}</span>
        <AppMenu />
      </header>

      {multi && (
        <div className="selection-bar">
          <span>{picked.size} selected</span>
          <button onClick={() => toggleFav([...picked])}>
            {allPickedFav ? '★ Remove from favorites' : '☆ Add to favorites'} <span className="muted">F</span>
          </button>
          <button onClick={() => setPicked(new Set())}>Clear selection <span className="muted">Esc</span></button>
        </div>
      )}

      <HighlightContext.Provider value={highlight}>
      <main className="body">
        {roots.length > 0 && (
          <aside className="tree-pane">
            <FolderTree
              trees={trees}
              selected={subdir}
              includeSub={recursive}
              onSelect={setSubdir}
              onRemoveRoot={removeFolder}
            />
          </aside>
        )}
        <section className="grid-pane">
          {error ? (
            <div className="empty">{error}</div>
          ) : !roots.length ? (
            <div className="empty">
              <p>Add a folder with ComfyUI outputs — or drop one onto the window.</p>
              <p className="muted">You can add several, e.g. Downloads and Documents.</p>
              <button className="primary" onClick={pick}>Add folder…</button>
            </div>
          ) : visible.length === 0 && !loading ? (
            <div className="empty">
              {terms.length ? (
                <>
                  <p>Nothing matches “{deferredQuery.trim()}”{onlyFav ? ' among favorites' : ''}.</p>
                  {indexing && <p className="muted">Still indexing ({indexed.done}/{indexed.total}) — more results may appear.</p>}
                </>
              ) : onlyFav ? (
                <>
                  <p>No favorites in this folder yet.</p>
                  <p className="muted">Select images and press F, or click the ☆ on a thumbnail.</p>
                </>
              ) : files.length ? 'No images directly in this folder — turn on “Subfolders” or pick a subfolder.' : 'No images in this folder.'}
            </div>
          ) : (
            <Grid
              key={subdir}
              files={visible}
              size={thumb}
              selected={selected}
              picked={picked}
              favs={favs}
              onSelect={onSelect}
              onOpen={(i) => { focus(i); setPicked(new Set()); setLightbox(true) }}
              onFav={(path) => toggleFav(picked.has(path) ? [...picked] : [path])}
              onCols={setCols}
            />
          )}
        </section>
        <aside className="details-pane" ref={detailsRef}>
          {current ? (
            <Details
              file={current}
              onOpen={() => setLightbox(true)}
              fav={favs.has(current.path)}
              onToggleFav={() => toggleFav([current.path])}
            />
          ) : <div className="empty small">Nothing selected</div>}
        </aside>
      </main>

      {lightbox && current && (
        <Lightbox
          file={current}
          index={selected}
          total={visible.length}
          fav={favs.has(current.path)}
          onToggleFav={() => toggleFav([current.path])}
          onClose={() => setLightbox(false)}
          onNav={(d) => focus(selected + d)}
        />
      )}
      </HighlightContext.Provider>
    </div>
  )
}

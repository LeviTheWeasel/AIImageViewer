import { app, type WebContents } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { FileEntry, ImageMeta, IndexProgress, SearchDoc } from '@shared/types'
import { readMeta } from './meta'

/** Bump when the parser changes what ends up in a SearchDoc, to rebuild every cached entry. */
const INDEX_VERSION = 1
const CONCURRENCY = 8
const BATCH = 200

const cacheFile = () => join(app.getPath('userData'), 'search-index.json')
let cache: Map<string, SearchDoc> | null = null
let dirty = false
let run = 0

async function loadCache(): Promise<Map<string, SearchDoc>> {
  if (cache) return cache
  try {
    const data = JSON.parse(await readFile(cacheFile(), 'utf8'))
    cache = new Map(data.version === INDEX_VERSION ? (data.docs as SearchDoc[]).map((d) => [d.path, d]) : [])
  } catch {
    cache = new Map()
  }
  return cache
}

let saving = Promise.resolve()
function saveCache() {
  if (!dirty || !cache) return
  dirty = false
  const docs = [...cache.values()]
  saving = saving
    .then(async () => {
      const tmp = cacheFile() + '.tmp'
      await writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, docs }))
      await rename(tmp, cacheFile())
    })
    .catch((e) => console.error('Saving search index failed:', e))
}

export function toDoc(f: FileEntry, m: ImageMeta): SearchDoc {
  const pos: string[] = []
  const neg: string[] = []
  const seeds = new Set<number>()
  const c = m.comfy
  if (m.a1111) {
    pos.push(m.a1111.positive)
    neg.push(m.a1111.negative)
    const seed = Number(m.a1111.settings.find(([k]) => k === 'Seed')?.[1])
    if (seed) seeds.add(seed)
  }
  if (c) {
    for (const s of c.stages) {
      pos.push(...s.positive.map((t) => t.text))
      neg.push(...s.negative.map((t) => t.text))
      if (s.seed !== undefined) seeds.add(s.seed)
    }
    if (c.finalPrompt && !c.finalPrompt.used) pos.push(c.finalPrompt.text)
  }
  const uniq = (a: string[]) => [...new Set(a.map((x) => x.trim()).filter(Boolean))]
  return {
    path: f.path,
    mtime: f.mtime,
    size: f.size,
    pos: uniq(pos).join('\n'),
    neg: uniq(neg).join('\n'),
    models: uniq(c?.models.map((x) => x.name) ?? []),
    loras: uniq(c?.loras.map((x) => x.name) ?? []),
    seeds: [...seeds]
  }
}

/**
 * Index the given files: cached docs are sent at once, the rest are read in the background
 * and streamed to the renderer in batches. Starting a new run abandons the previous one.
 */
export async function indexFiles(files: FileEntry[], target: WebContents): Promise<number> {
  const myRun = ++run
  const idx = await loadCache()
  const fresh: SearchDoc[] = []
  const todo: FileEntry[] = []
  for (const f of files) {
    const d = idx.get(f.path)
    if (d && d.mtime === f.mtime && d.size === f.size) fresh.push(d)
    else todo.push(f)
  }

  let done = fresh.length
  const total = files.length
  const send = (docs: SearchDoc[]) => {
    if (myRun !== run || target.isDestroyed()) return
    const msg: IndexProgress = { run: myRun, done, total, docs }
    target.send('index-progress', msg)
  }
  // Defer so the renderer has the run id before the first event arrives.
  setImmediate(async () => {
    for (let i = 0; i < fresh.length; i += 2000) send(fresh.slice(i, i + 2000))
    if (!fresh.length) send([])

    let pending: SearchDoc[] = []
    let next = 0
    const worker = async () => {
      while (next < todo.length && myRun === run) {
        const f = todo[next++]
        const meta = await readMeta(f.path, relative(f.root, f.path).split(sep).join('/'))
        const doc = toDoc(f, meta)
        idx.set(f.path, doc)
        dirty = true
        pending.push(doc)
        done++
        if (pending.length >= BATCH) {
          send(pending)
          pending = []
          if (done % 2000 < BATCH) saveCache()
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    if (myRun === run) send(pending)
    saveCache()
  })
  return myRun
}

import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, shell } from 'electron'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FileEntry, ScanResult, ThumbStats } from '@shared/types'
import { readMeta } from './meta'
import { indexFiles } from './indexer'

const IMAGE_RE = /\.(png|jpe?g|webp)$/i
const SCHEME = 'aiv'

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

/** Only files under the currently opened folders may be served or read. */
let roots: string[] = []
let lastScan: FileEntry[] = []

const isInside = (abs: string, dir: string) => abs === dir || abs.startsWith(dir.endsWith(sep) ? dir : dir + sep)

function rootOf(p: string): { abs: string; root: string } {
  const abs = resolve(p)
  const root = roots.find((r) => isInside(abs, r))
  if (!root) throw new Error('Path outside opened folders')
  return { abs, root }
}
const insideRoot = (p: string) => rootOf(p).abs

async function scan(dir: string, recursive: boolean): Promise<FileEntry[]> {
  const root = dir
  const out: FileEntry[] = []
  const walk = async (d: string) => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (recursive) await walk(p)
      } else if (IMAGE_RE.test(e.name)) {
        try {
          const s = await stat(p)
          out.push({ path: p, root, rel: relative(dir, p).split(sep).join('/'), name: e.name, size: s.size, mtime: s.mtimeMs })
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  }
  await walk(dir)
  return out
}

// Favorites: absolute paths, persisted as JSON in userData (shared by dev and packaged builds).
const favFile = () => join(app.getPath('userData'), 'favorites.json')
let favorites: Set<string> | null = null

async function loadFavorites(): Promise<Set<string>> {
  if (!favorites) {
    try {
      const list = JSON.parse(await readFile(favFile(), 'utf8'))
      favorites = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [])
    } catch {
      favorites = new Set()
    }
  }
  return favorites
}

let favWrite = Promise.resolve()
function saveFavorites(set: Set<string>) {
  // Serialize writes; write-then-rename so a crash never leaves a truncated file.
  favWrite = favWrite.then(async () => {
    const tmp = favFile() + '.tmp'
    await writeFile(tmp, JSON.stringify([...set], null, 1), 'utf8')
    await rename(tmp, favFile())
  }).catch((e) => console.error('Saving favorites failed:', e))
}

// Thumbnails: WebP files made by the renderer, stored in userData/thumbs keyed by path + mtime + size.
const THUMB_VERSION = 1
const thumbDir = () => join(app.getPath('userData'), 'thumbs')
const thumbFile = (path: string, version: string) =>
  join(thumbDir(), createHash('sha1').update(`${THUMB_VERSION}|${path}|${version}`).digest('hex') + '.webp')

/** Thumbnail files on disk with their sizes. */
async function listThumbs(): Promise<{ name: string; bytes: number }[]> {
  let names: string[]
  try {
    names = await readdir(thumbDir())
  } catch {
    return []
  }
  const out: { name: string; bytes: number }[] = []
  for (const name of names) {
    try {
      out.push({ name, bytes: (await stat(join(thumbDir(), name))).size })
    } catch {
      // removed meanwhile
    }
  }
  return out
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(res.body, { status: res.status, headers })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#141416',
    title: 'AIImageViewer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  // Links in metadata etc. open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  // aiv://file/<encoded absolute path>                 — the original image
  // aiv://thumb/<encoded absolute path>?v=<mtime>-<size> — cached thumbnail, 404 if not made yet
  protocol.handle(SCHEME, async (req) => {
    try {
      const url = new URL(req.url)
      const p = insideRoot(decodeURIComponent(url.pathname.slice(1)))
      if (url.host === 'thumb') {
        const t = thumbFile(p, url.searchParams.get('v') ?? '')
        try {
          await stat(t)
        } catch {
          return new Response('No thumbnail yet', { status: 404 })
        }
        return withCors(await net.fetch(pathToFileURL(t).toString()))
      }
      // The thumbnail worker fetch()es originals, which counts as cross-origin for a custom scheme.
      return withCors(await net.fetch(pathToFileURL(p).toString()))
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
  })

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('scan', async (_e, dirs: string[]): Promise<ScanResult> => {
    const ok: string[] = []
    const missing: string[] = []
    for (const d of dirs) {
      const abs = resolve(d)
      try {
        if ((await stat(abs)).isDirectory()) ok.push(abs)
        else missing.push(abs)
      } catch {
        missing.push(abs) // unmounted drive, deleted folder…
      }
    }
    // A root nested inside another one would only duplicate files.
    roots = ok.filter((r) => !ok.some((o) => o !== r && isInside(r, o)))
    const files = (await Promise.all(roots.map((r) => scan(r, true)))).flat()
    lastScan = files
    return { files, missing }
  })

  // Only files from the latest scan can be indexed, so the renderer can't make us read arbitrary paths.
  ipcMain.handle('index', (e, paths: string[]) => {
    const wanted = new Set(paths)
    return indexFiles(lastScan.filter((f) => wanted.has(f.path)), e.sender)
  })

  ipcMain.handle('meta', async (_e, p: string) => {
    const { abs, root } = rootOf(p)
    return readMeta(abs, relative(root, abs).split(sep).join('/'))
  })

  ipcMain.handle('save-text', async (e, suggestedName: string, text: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const r = await dialog.showSaveDialog(win, {
      defaultPath: suggestedName,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return false
    await writeFile(r.filePath, text, 'utf8')
    return true
  })

  ipcMain.handle('thumb-save', async (_e, p: string, version: string, data: ArrayBuffer) => {
    const abs = insideRoot(p)
    if (!(data instanceof ArrayBuffer) || data.byteLength > 8 * 1024 * 1024) return
    await mkdir(thumbDir(), { recursive: true })
    const t = thumbFile(abs, version)
    await writeFile(t + '.tmp', Buffer.from(data))
    await rename(t + '.tmp', t)
  })

  ipcMain.handle('thumb-stats', async (): Promise<ThumbStats> => {
    const all = await listThumbs()
    const used = new Set(lastScan.map((f) => basename(thumbFile(f.path, `${f.mtime}-${f.size}`))))
    const unused = all.filter((t) => !used.has(t.name))
    const sum = (a: { bytes: number }[]) => a.reduce((n, t) => n + t.bytes, 0)
    return { count: all.length, bytes: sum(all), unusedCount: unused.length, unusedBytes: sum(unused) }
  })

  // 'unused': keep only thumbnails of files in the open folders (as of the last scan).
  ipcMain.handle('thumb-clear', async (_e, mode: 'all' | 'unused'): Promise<{ count: number; bytes: number }> => {
    const used =
      mode === 'unused' ? new Set(lastScan.map((f) => basename(thumbFile(f.path, `${f.mtime}-${f.size}`)))) : null
    let count = 0
    let bytes = 0
    for (const t of await listThumbs()) {
      if (used?.has(t.name)) continue
      try {
        await unlink(join(thumbDir(), t.name))
        count++
        bytes += t.bytes
      } catch {
        // already gone
      }
    }
    return { count, bytes }
  })

  ipcMain.handle('fav-list', async () => [...(await loadFavorites())])

  ipcMain.handle('fav-set', async (_e, paths: string[], on: boolean) => {
    const set = await loadFavorites()
    for (const p of paths) if (typeof p === 'string') on ? set.add(p) : set.delete(p)
    saveFavorites(set)
    return [...set]
  })

  ipcMain.handle('reveal', (_e, p: string) => shell.showItemInFolder(insideRoot(p)))

  // Native drag-out so an image can be dropped straight into ComfyUI or a file manager.
  ipcMain.on('start-drag', (e, p: string) => {
    try {
      const abs = insideRoot(p)
      const icon = nativeImage.createFromPath(abs).resize({ width: 96 })
      e.sender.startDrag({ file: abs, icon: icon.isEmpty() ? nativeImage.createEmpty() : icon })
    } catch {
      // ignore drags of files we don't own
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

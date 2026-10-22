import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ImageMeta, IndexProgress, ScanResult, ThumbStats } from '@shared/types'

const api = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  scan: (dirs: string[]): Promise<ScanResult> => ipcRenderer.invoke('scan', dirs),
  /** Start (re)indexing these scanned files; returns the run id used in progress events. */
  index: (paths: string[]): Promise<number> => ipcRenderer.invoke('index', paths),
  onIndexProgress: (cb: (p: IndexProgress) => void) => {
    const h = (_e: unknown, p: IndexProgress) => cb(p)
    ipcRenderer.on('index-progress', h)
    return () => {
      ipcRenderer.removeListener('index-progress', h)
    }
  },
  meta: (path: string): Promise<ImageMeta> => ipcRenderer.invoke('meta', path),
  saveText: (suggestedName: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('save-text', suggestedName, text),
  favorites: (): Promise<string[]> => ipcRenderer.invoke('fav-list'),
  setFavorite: (paths: string[], on: boolean): Promise<string[]> => ipcRenderer.invoke('fav-set', paths, on),
  saveThumb: (path: string, version: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('thumb-save', path, version, data),
  thumbStats: (): Promise<ThumbStats> => ipcRenderer.invoke('thumb-stats'),
  clearThumbs: (mode: 'all' | 'unused'): Promise<{ count: number; bytes: number }> =>
    ipcRenderer.invoke('thumb-clear', mode),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('reveal', path),
  startDrag: (path: string) => ipcRenderer.send('start-drag', path),
  /** Absolute path of a folder dropped onto the window. */
  pathForFile: (f: File) => webUtils.getPathForFile(f)
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)

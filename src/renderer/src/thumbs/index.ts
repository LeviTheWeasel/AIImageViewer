import type { FileEntry } from '@shared/types'
import { fileUrl } from '../lib'
import type { ThumbRequest, ThumbResponse } from './worker'

/** Longest side of a thumbnail; covers the largest grid size. */
const MAX = 400
const WORKERS = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) >> 1))

export const thumbVersion = (f: FileEntry) => `${f.mtime}-${f.size}`
export const thumbUrl = (f: FileEntry) =>
  `aiv://thumb/${encodeURIComponent(f.path)}?v=${encodeURIComponent(thumbVersion(f))}`

interface Job {
  file: FileEntry
  resolve: (data: ArrayBuffer) => void
  reject: (e: Error) => void
  cancelled: boolean
}

// Most recent requests first: those are the cells the user is looking at right now.
const stack: Job[] = []
const idle: Worker[] = []
const running = new Map<number, Job>()
let nextId = 1

function makeWorker(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<ThumbResponse>) => {
    const job = running.get(e.data.id)
    running.delete(e.data.id)
    idle.push(w)
    if (job && !job.cancelled) {
      if (e.data.ok) job.resolve(e.data.data)
      else job.reject(new Error(e.data.error))
    }
    pump()
  }
  return w
}

function pump() {
  while (idle.length && stack.length) {
    const job = stack.pop()!
    if (job.cancelled) continue
    const id = nextId++
    running.set(id, job)
    const msg: ThumbRequest = { id, url: fileUrl(job.file.path), max: MAX }
    idle.pop()!.postMessage(msg)
  }
}

let started = false
function start() {
  if (started) return
  started = true
  for (let i = 0; i < WORKERS; i++) idle.push(makeWorker())
}

/**
 * Generate a thumbnail, store it in the on-disk cache and return an object URL for it.
 * `cancel()` drops the job if it hasn't started (e.g. the cell scrolled out of view).
 */
export function makeThumb(file: FileEntry): { promise: Promise<string>; cancel: () => void } {
  start()
  let job!: Job
  const promise = new Promise<ArrayBuffer>((resolve, reject) => {
    job = { file, resolve, reject, cancelled: false }
  }).then((data) => {
    window.api.saveThumb(file.path, thumbVersion(file), data.slice(0)).catch(() => {})
    return URL.createObjectURL(new Blob([data], { type: 'image/webp' }))
  })
  stack.push(job)
  pump()
  return {
    promise,
    cancel: () => {
      job.cancelled = true
    }
  }
}

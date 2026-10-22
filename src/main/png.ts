import { open } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { exifToChunks } from './exif'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEXT_TYPES = new Set(['tEXt', 'iTXt', 'zTXt'])
/** Refuse absurd chunk lengths so a corrupt file can't make us allocate gigabytes. */
const MAX_TEXT_CHUNK = 64 * 1024 * 1024

export interface PngInfo {
  width: number
  height: number
  text: Record<string, string>
}

function decodeText(type: string, data: Buffer): [string, string] | null {
  const nul = data.indexOf(0)
  if (nul < 0) return null
  const key = data.subarray(0, nul).toString('latin1')
  if (type === 'tEXt') return [key, data.subarray(nul + 1).toString('latin1')]
  if (type === 'zTXt') return [key, inflateSync(data.subarray(nul + 2)).toString('latin1')]
  // iTXt: keyword\0 compFlag compMethod lang\0 translatedKeyword\0 text
  const compressed = data[nul + 1] === 1
  const langEnd = data.indexOf(0, nul + 3)
  const transEnd = data.indexOf(0, langEnd + 1)
  if (langEnd < 0 || transEnd < 0) return null
  const body = data.subarray(transEnd + 1)
  return [key, (compressed ? inflateSync(body) : body).toString('utf8')]
}

/** Reads IHDR and all text chunks, seeking past image data instead of reading it. */
export async function readPng(path: string): Promise<PngInfo> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const head = Buffer.alloc(8)
    await fh.read(head, 0, 8, 0)
    if (!head.equals(SIGNATURE)) throw new Error('Not a PNG file')

    const info: PngInfo = { width: 0, height: 0, text: {} }
    let exif: Record<string, string> = {}
    const hdr = Buffer.alloc(8)
    let pos = 8
    while (pos + 12 <= size) {
      await fh.read(hdr, 0, 8, pos)
      const len = hdr.readUInt32BE(0)
      const type = hdr.toString('latin1', 4, 8)
      const dataPos = pos + 8
      if (type === 'IHDR') {
        const d = Buffer.alloc(8)
        await fh.read(d, 0, 8, dataPos)
        info.width = d.readUInt32BE(0)
        info.height = d.readUInt32BE(4)
      } else if (TEXT_TYPES.has(type) && len <= MAX_TEXT_CHUNK) {
        const d = Buffer.alloc(len)
        await fh.read(d, 0, len, dataPos)
        try {
          const kv = decodeText(type, d)
          if (kv) info.text[kv[0]] = kv[1]
        } catch {
          // A single broken chunk shouldn't hide the rest of the metadata.
        }
      } else if (type === 'eXIf' && len <= MAX_TEXT_CHUNK) {
        // Text chunks win over EXIF copies of the same key.
        const d = Buffer.alloc(len)
        await fh.read(d, 0, len, dataPos)
        exif = exifToChunks(d)
      } else if (type === 'IEND') {
        break
      }
      pos = dataPos + len + 4 // + CRC
    }
    // Text chunks win over EXIF copies of the same key.
    info.text = { ...exif, ...info.text }
    return info
  } finally {
    await fh.close()
  }
}

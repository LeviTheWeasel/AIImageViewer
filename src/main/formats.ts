import { open, type FileHandle } from 'node:fs/promises'
import { exifToChunks } from './exif'
import { readPng } from './png'

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'other'

export interface ImageInfo {
  format: ImageFormat
  width: number
  height: number
  /** Metadata normalized to PNG-style text chunks (prompt, workflow, parameters, …). */
  text: Record<string, string>
}

const MAX_SEGMENT = 64 * 1024 * 1024

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len)
  const { bytesRead } = await fh.read(b, 0, len, pos)
  return b.subarray(0, bytesRead)
}

/** Picks the reader by file signature, not extension (a .png that is really a JPEG still works). */
export async function readImage(path: string): Promise<ImageInfo> {
  const fh = await open(path, 'r')
  let head: Buffer
  try {
    head = await readAt(fh, 0, 16)
  } finally {
    await fh.close()
  }
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const png = await readPng(path)
    return { format: 'png', ...png }
  }
  if (head[0] === 0xff && head[1] === 0xd8) return readJpeg(path)
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return readWebp(path)
  throw new Error('Unsupported image format')
}

/** JPEG: walk the segments up to the image data; EXIF lives in APP1, comments in COM. */
async function readJpeg(path: string): Promise<ImageInfo> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const info: ImageInfo = { format: 'jpeg', width: 0, height: 0, text: {} }
    let pos = 2
    while (pos + 4 <= size) {
      const hdr = await readAt(fh, pos, 4)
      if (hdr[0] !== 0xff) break
      const marker = hdr[1]
      if (marker === 0xff) {
        pos++ // fill byte
        continue
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        pos += 2
        continue
      }
      if (marker === 0xda || marker === 0xd9) break // start of scan / end of image
      const len = hdr.readUInt16BE(2)
      const dataPos = pos + 4
      const dataLen = len - 2
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC): height and width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const d = await readAt(fh, dataPos, 5)
        info.height = d.readUInt16BE(1)
        info.width = d.readUInt16BE(3)
      } else if (marker === 0xe1 && dataLen > 6 && dataLen <= MAX_SEGMENT) {
        const d = await readAt(fh, dataPos, dataLen)
        if (d.toString('latin1', 0, 6) === 'Exif\0\0') Object.assign(info.text, exifToChunks(d))
        else if (d.toString('latin1', 0, 29) === 'http://ns.adobe.com/xap/1.0/\0') info.text.XMP = d.subarray(29).toString('utf8')
      } else if (marker === 0xfe && dataLen > 0) {
        const s = (await readAt(fh, dataPos, dataLen)).toString('utf8').replace(/\0+$/, '').trim()
        if (s) {
          // Some tools store A1111 parameters as a JPEG comment.
          if (!info.text.parameters && /(^|\n)(Negative prompt:|Steps: )/.test(s)) info.text.parameters = s
          else info.text.Comment = s
        }
      }
      pos = dataPos + dataLen
    }
    return info
  } finally {
    await fh.close()
  }
}

/** WebP: RIFF chunks — VP8/VP8L/VP8X for the size, EXIF and XMP for metadata. */
async function readWebp(path: string): Promise<ImageInfo> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const info: ImageInfo = { format: 'webp', width: 0, height: 0, text: {} }
    let pos = 12
    while (pos + 8 <= size) {
      const hdr = await readAt(fh, pos, 8)
      const type = hdr.toString('latin1', 0, 4)
      const len = hdr.readUInt32LE(4)
      const dataPos = pos + 8
      if (type === 'VP8X') {
        const d = await readAt(fh, dataPos, 10)
        info.width = 1 + d.readUIntLE(4, 3)
        info.height = 1 + d.readUIntLE(7, 3)
      } else if (type === 'VP8 ' && !info.width) {
        const d = await readAt(fh, dataPos, 10)
        info.width = d.readUInt16LE(6) & 0x3fff
        info.height = d.readUInt16LE(8) & 0x3fff
      } else if (type === 'VP8L' && !info.width) {
        const d = await readAt(fh, dataPos, 5)
        const bits = d.readUInt32LE(1)
        info.width = (bits & 0x3fff) + 1
        info.height = ((bits >> 14) & 0x3fff) + 1
      } else if (type === 'EXIF' && len <= MAX_SEGMENT) {
        Object.assign(info.text, exifToChunks(await readAt(fh, dataPos, len)))
      } else if (type === 'XMP ' && len <= MAX_SEGMENT) {
        info.text.XMP = (await readAt(fh, dataPos, len)).toString('utf8')
      }
      pos = dataPos + len + (len & 1) // chunks are padded to even sizes
    }
    return info
  } finally {
    await fh.close()
  }
}

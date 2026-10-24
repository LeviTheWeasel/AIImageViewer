/**
 * Removes metadata from PNG, JPEG and WebP files without re-encoding the image:
 * the blocks that carry metadata are cut out, the pixel data is copied byte for byte.
 * Blocks that affect how the image looks (color profile, transparency, gamma) are kept.
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG chunks that are part of the picture itself; everything else (tEXt, iTXt, zTXt, eXIf, tIME, …) is dropped. */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'cICP', 'mDCv', 'cLLi',
  'acTL', 'fcTL', 'fdAT' // animated PNG
])

function stripPng(b: Buffer): Buffer {
  const parts: Buffer[] = [PNG_SIG]
  let pos = 8
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos)
    const type = b.toString('latin1', pos + 4, pos + 8)
    const end = pos + 12 + len
    if (end > b.length) throw new Error('Damaged PNG file')
    if (PNG_KEEP.has(type)) parts.push(b.subarray(pos, end))
    pos = end
    if (type === 'IEND') break
  }
  return Buffer.concat(parts)
}

/**
 * JPEG: drop EXIF/XMP (APP1), Photoshop/IPTC (APP13), comments and other APPn blocks.
 * Kept: JFIF (APP0), ICC profile (APP2), Adobe color transform (APP14) — they change how colors decode.
 */
function stripJpeg(b: Buffer): Buffer {
  const parts: Buffer[] = [b.subarray(0, 2)]
  let pos = 2
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) throw new Error('Damaged JPEG file')
    const marker = b[pos + 1]
    if (marker === 0xff) {
      pos++
      continue
    }
    if (marker === 0xda) {
      parts.push(b.subarray(pos)) // start of scan: the image data and everything after it
      return Buffer.concat(parts)
    }
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(b.subarray(pos, pos + 2))
      pos += 2
      continue
    }
    const end = pos + 2 + b.readUInt16BE(pos + 2)
    if (end > b.length) throw new Error('Damaged JPEG file')
    const isApp = marker >= 0xe0 && marker <= 0xef
    const keep = !isApp && marker !== 0xfe ? true : marker === 0xe0 || marker === 0xe2 || marker === 0xee
    if (keep) parts.push(b.subarray(pos, end))
    pos = end
  }
  throw new Error('Damaged JPEG file')
}

/** WebP: drop the EXIF and XMP chunks and clear their flags in the VP8X header. */
function stripWebp(b: Buffer): Buffer {
  const parts: Buffer[] = []
  let pos = 12
  while (pos + 8 <= b.length) {
    const type = b.toString('latin1', pos, pos + 4)
    const len = b.readUInt32LE(pos + 4)
    const end = pos + 8 + len + (len & 1)
    if (pos + 8 + len > b.length) throw new Error('Damaged WebP file')
    if (type === 'VP8X') {
      const c = Buffer.from(b.subarray(pos, Math.min(end, b.length)))
      c[8] &= ~(0x08 | 0x04) // EXIF and XMP present flags
      parts.push(c)
    } else if (type !== 'EXIF' && type !== 'XMP ') {
      parts.push(b.subarray(pos, Math.min(end, b.length)))
    }
    pos = end
  }
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length + 4, 4)
  head.write('WEBP', 8, 'latin1')
  return Buffer.concat([head, body])
}

export function stripMetadata(b: Buffer): Buffer {
  if (b.subarray(0, 8).equals(PNG_SIG)) return stripPng(b)
  if (b[0] === 0xff && b[1] === 0xd8) return stripJpeg(b)
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return stripWebp(b)
  throw new Error('Unsupported image format')
}

/**
 * Minimal EXIF (TIFF) reader for the tags image generators use to store metadata:
 *  - ComfyUI (SaveAnimatedWEBP and friends): Model 0x0110 = "prompt:{…}", Make 0x010F = "workflow:{…}",
 *    and further extra_pnginfo keys in 0x010E, 0x010D, … as "<key>:<json>"
 *  - A1111/Forge, comfy-image-saver ("Save Image w/Metadata"): UserComment 0x9286 with the parameters text
 *  - Windows XPComment 0x9C9C, ImageDescription 0x010E as fallbacks
 */

const TAG_EXIF_IFD = 0x8769
const TAG_USER_COMMENT = 0x9286
const TAG_XP_COMMENT = 0x9c9c
const TAG_IMAGE_DESCRIPTION = 0x010e
/** Tags ComfyUI fills with "<key>:<json>", counting down from Model. */
const COMFY_TAGS = [0x0110, 0x010f, 0x010e, 0x010d, 0x010c, 0x010b, 0x010a]

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

interface Entry {
  type: number
  data: Buffer
}

function readIfd(tiff: Buffer, offset: number, le: boolean, out: Map<number, Entry>, depth = 0) {
  if (depth > 2 || offset < 8 || offset + 2 > tiff.length) return
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  const n = u16(offset)
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12
    if (e + 12 > tiff.length) break
    const tag = u16(e)
    const type = u16(e + 2)
    const count = u32(e + 4)
    const size = (TYPE_SIZE[type] ?? 1) * count
    const start = size <= 4 ? e + 8 : u32(e + 8)
    if (start + size > tiff.length) continue
    if (tag === TAG_EXIF_IFD) {
      readIfd(tiff, u32(e + 8), le, out, depth + 1)
      continue
    }
    if (!out.has(tag)) out.set(tag, { type, data: tiff.subarray(start, start + size) })
  }
}

/** UTF-16 without a BOM: pick the byte order whose high bytes are mostly zero (true for Latin text). */
function decodeUtf16(b: Buffer, hint: 'be' | 'le'): string {
  const even = b.length & ~1
  let zeroEven = 0
  let zeroOdd = 0
  for (let i = 0; i < Math.min(even, 4000); i += 2) {
    if (b[i] === 0) zeroEven++
    if (b[i + 1] === 0) zeroOdd++
  }
  const be = zeroEven > zeroOdd || (zeroEven === zeroOdd && hint === 'be')
  const data = Buffer.from(b.subarray(0, even))
  if (be) data.swap16()
  return data.toString('utf16le')
}

function decodeUserComment(b: Buffer): string {
  const prefix = b.subarray(0, 8).toString('latin1')
  const body = b.subarray(8)
  // piexif (A1111, comfy-image-saver) writes UTF-16BE; some tools write LE — detect.
  if (prefix === 'UNICODE\0') return decodeUtf16(body, 'be')
  if (prefix.startsWith('ASCII')) return body.toString('utf8')
  // Undefined / missing prefix: assume UTF-8 text.
  return (prefix === '\0\0\0\0\0\0\0\0' ? body : b).toString('utf8')
}

const clean = (s: string) => s.replace(/\0+$/, '').trim()

/** Parse a TIFF/EXIF blob (optionally starting with "Exif\0\0") into PNG-style text chunks. */
export function exifToChunks(blob: Buffer): Record<string, string> {
  let tiff = blob
  if (tiff.subarray(0, 6).toString('latin1') === 'Exif\0\0') tiff = tiff.subarray(6)
  if (tiff.length < 8) return {}
  const order = tiff.subarray(0, 2).toString('latin1')
  if (order !== 'II' && order !== 'MM') return {}
  const le = order === 'II'
  const tags = new Map<number, Entry>()
  readIfd(tiff, le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4), le, tags)

  const out: Record<string, string> = {}
  for (const tag of COMFY_TAGS) {
    const e = tags.get(tag)
    if (!e) continue
    const s = clean(e.data.toString('utf8'))
    const m = /^([A-Za-z_][\w-]*):\s*([[{][\s\S]*)$/.exec(s)
    if (m) out[m[1]] = m[2]
  }

  const uc = tags.get(TAG_USER_COMMENT)
  if (uc) {
    const s = clean(decodeUserComment(uc.data))
    if (s) out.parameters = s
  }
  const xp = tags.get(TAG_XP_COMMENT)
  if (xp && !out.parameters) {
    const s = clean(decodeUtf16(xp.data, 'le'))
    if (s) out.parameters = s
  }
  const desc = tags.get(TAG_IMAGE_DESCRIPTION)
  if (desc) {
    const s = clean(desc.data.toString('utf8'))
    // Some tools put A1111 parameters here; anything else is shown as raw metadata only.
    if (s && !/^[A-Za-z_][\w-]*:\s*[[{]/.test(s)) {
      if (!out.parameters && /(^|\n)(Negative prompt:|Steps: )/.test(s)) out.parameters = s
      else out.ImageDescription = s
    }
  }
  return out
}

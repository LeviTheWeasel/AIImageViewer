import type { A1111Params } from './types'

/**
 * Parse the A1111/Forge "parameters" text block:
 *   <positive>
 *   Negative prompt: <negative>
 *   Steps: 30, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 512x512, Model: foo, Lora hashes: "a: 1, b: 2"
 * Prompts may span several lines; the settings line is the last one starting with "Steps:".
 */
export function parseA1111(raw: string): A1111Params {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  let settingsIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Steps: /.test(lines[i])) {
      settingsIdx = i
      break
    }
  }
  const body = (settingsIdx >= 0 ? lines.slice(0, settingsIdx) : lines).join('\n')
  const negAt = body.search(/(^|\n)Negative prompt:/)
  const positive = (negAt >= 0 ? body.slice(0, negAt) : body).trim()
  const negative = negAt >= 0 ? body.slice(negAt).replace(/^\n?Negative prompt:\s*/, '').trim() : ''
  const settings = settingsIdx >= 0 ? parseSettings(lines.slice(settingsIdx).join('\n')) : []
  return { positive, negative, settings }
}

function parseSettings(line: string): [string, string][] {
  const out: [string, string][] = []
  // key: value pairs separated by ", "; values may be double-quoted and contain commas.
  const re = /\s*([^,:]+):\s*("(?:\\.|[^\\"])*"|[^,]*)(?:,|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) && m[0]) {
    let v = m[2].trim()
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v)
      } catch {
        v = v.slice(1, -1)
      }
    }
    out.push([m[1].trim(), v])
  }
  return out
}

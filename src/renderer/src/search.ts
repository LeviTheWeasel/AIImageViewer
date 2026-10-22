import { createContext } from 'react'
import type { SearchDoc } from '@shared/types'

export type Field = 'any' | 'pos' | 'neg' | 'lora' | 'model' | 'seed' | 'file'

export interface Term {
  field: Field
  text: string
  negate: boolean
}

const FIELDS: Record<string, Field> = {
  pos: 'pos', positive: 'pos', prompt: 'pos',
  neg: 'neg', negative: 'neg',
  lora: 'lora', loras: 'lora',
  model: 'model', ckpt: 'model', checkpoint: 'model',
  seed: 'seed',
  file: 'file', name: 'file'
}

/**
 * `red dress` → both words; `"red dress"` → phrase; `-blurry` → exclude;
 * `neg:watermark`, `lora:detail`, `model:sdxl`, `seed:123`, `file:portrait` → specific fields.
 */
export function parseQuery(q: string): Term[] {
  const terms: Term[] = []
  const re = /(-)?(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(q))) {
    if (!m[0]) {
      re.lastIndex++
      continue
    }
    let field = m[2] ? FIELDS[m[2].toLowerCase()] : 'any'
    let text = m[3] ?? m[4] ?? ''
    if (m[2] && !field) {
      // Unknown prefix like "http:" — treat the whole token as plain text.
      field = 'any'
      text = `${m[2]}:${text}`
    }
    text = text.trim().toLowerCase()
    if (text) terms.push({ field, text, negate: !!m[1] })
  }
  return terms
}

/** Lower-cased haystacks per field, computed once per document. */
export interface Prepared {
  pos: string
  neg: string
  lora: string
  model: string
  seed: string
  file: string
}

export function prepare(d: SearchDoc): Prepared {
  const file = d.path.slice(Math.max(d.path.lastIndexOf('/'), d.path.lastIndexOf('\\')) + 1)
  return {
    pos: d.pos.toLowerCase(),
    neg: d.neg.toLowerCase(),
    lora: d.loras.join('\n').toLowerCase(),
    model: d.models.join('\n').toLowerCase(),
    seed: d.seeds.join('\n'),
    file: file.toLowerCase()
  }
}

function hit(p: Prepared, t: Term): boolean {
  switch (t.field) {
    case 'any':
      return p.pos.includes(t.text) || p.lora.includes(t.text) || p.model.includes(t.text) || p.file.includes(t.text)
    case 'seed':
      return p.seed.split('\n').some((s) => s === t.text || s.includes(t.text))
    default:
      return p[t.field].includes(t.text)
  }
}

export const matches = (p: Prepared, terms: Term[]) => terms.every((t) => hit(p, t) !== t.negate)

/** Words to highlight in prompt texts. */
export interface Highlight {
  pos: string[]
  neg: string[]
}

export function highlightTerms(terms: Term[]): Highlight {
  const pos = terms.filter((t) => !t.negate && (t.field === 'any' || t.field === 'pos')).map((t) => t.text)
  const neg = terms.filter((t) => !t.negate && t.field === 'neg').map((t) => t.text)
  return { pos, neg }
}

export const HighlightContext = createContext<Highlight>({ pos: [], neg: [] })

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Split `text` into alternating [plain, match, plain, match, …] parts. */
export function splitMatches(text: string, words: string[]): string[] {
  if (!words.length) return [text]
  const re = new RegExp(`(${words.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})`, 'gi')
  return text.split(re)
}

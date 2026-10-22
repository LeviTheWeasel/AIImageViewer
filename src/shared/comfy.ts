import type { ComfyInfo, LoraRef, ModelKind, ModelRef, PromptText, RuntimeSource, SamplerStage } from './types'

export interface ApiNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}
export type ApiGraph = Record<string, ApiNode>
type Link = [string, number]

const isLink = (v: unknown): v is Link =>
  Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number'

const linkId = (l: Link) => String(l[0])

/**
 * ComfyUI serializes with Python's json, which emits bare NaN/Infinity.
 * Replace those tokens (outside strings) with null so JSON.parse accepts them.
 */
export function parseComfyJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    let out = ''
    let inStr = false
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (inStr) {
        out += c
        if (c === '\\') out += raw[++i] ?? ''
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') {
        inStr = true
        out += c
        continue
      }
      const rest = raw.slice(i, i + 9)
      if (rest.startsWith('NaN')) { out += 'null'; i += 2; continue }
      if (rest.startsWith('-Infinity')) { out += 'null'; i += 8; continue }
      if (rest.startsWith('Infinity')) { out += 'null'; i += 7; continue }
      out += c
    }
    return JSON.parse(out)
  }
}

// ---------------------------------------------------------------------------
// String evaluation: fold primitive/string-utility nodes into literal text.

interface Evaluated {
  text: string
  runtime: RuntimeSource[]
}

/** Node outputs known from saved chunks (final_prompt), keyed by node id, per graph. */
const overridesOf = new WeakMap<ApiGraph, Map<string, string>>()
/** Ids of overrides actually consumed while evaluating, per graph. */
const usedOf = new WeakMap<ApiGraph, Set<string>>()

const STRING_INPUT_KEYS = ['value', 'string', 'String', 'text', 'Text', 'STRING', 'prompt']
/** Concat-node inputs that are options, not parts. */
const CONCAT_OPTION_KEYS = /^(delimiter|separator|clean_whitespace|linebreak_addition)$/

function evalString(graph: ApiGraph, v: unknown, depth = 0, skipOverride = false): Evaluated {
  if (typeof v === 'string') return { text: v, runtime: [] }
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v), runtime: [] }
  if (!isLink(v) || depth > 64) return { text: '', runtime: [] }

  const id = linkId(v)
  const node = graph[id]
  if (!node) return { text: `⟨missing #${id}⟩`, runtime: [] }

  const known = skipOverride ? undefined : overridesOf.get(graph)?.get(id)
  if (known !== undefined) {
    usedOf.get(graph)?.add(id)
    // Still evaluate the subtree to report which runtime nodes the saved text came from.
    const inner = evalString(graph, v, depth, true)
    return { text: known, runtime: inner.runtime.map((r) => ({ ...r, resolved: true })) }
  }
  const inp = node.inputs ?? {}
  const ev = (k: string) => evalString(graph, inp[k], depth + 1)
  const join = (...parts: Evaluated[]): Evaluated['runtime'] => parts.flatMap((p) => p.runtime)

  switch (node.class_type) {
    case 'StringConcatenate': {
      const a = ev('string_a'), b = ev('string_b')
      const delim = typeof inp.delimiter === 'string' ? inp.delimiter : ''
      return { text: a.text + delim + b.text, runtime: join(a, b) }
    }
    case 'StringReplace': {
      const s = ev('string'), f = ev('find'), r = ev('replace')
      return { text: f.text ? s.text.split(f.text).join(r.text) : s.text, runtime: join(s, f, r) }
    }
    case 'StringTrim': {
      const s = ev('string')
      const mode = inp.mode
      const text = mode === 'Left' ? s.text.trimStart() : mode === 'Right' ? s.text.trimEnd() : s.text.trim()
      return { text, runtime: s.runtime }
    }
  }

  // Other concatenators: JWStringConcat (a, b), WAS Text Concatenate (text_a…, delimiter), …
  if (/concat/i.test(node.class_type)) {
    const parts = Object.keys(inp).filter((k) => !CONCAT_OPTION_KEYS.test(k)).map(ev)
    const delim = typeof inp.delimiter === 'string' ? inp.delimiter : typeof inp.separator === 'string' ? inp.separator : ''
    return { text: parts.map((p) => p.text).filter(Boolean).join(delim), runtime: join(...parts) }
  }

  // Switches (rgthree Any Switch…): the first connected input wins.
  if (/switch/i.test(node.class_type)) {
    const first = Object.values(inp).find(isLink)
    if (first) return evalString(graph, first, depth + 1)
  }

  // Generic pass-through for primitives, simple text nodes and text displays (ShowText…).
  const isPrimitive =
    /^Primitive/.test(node.class_type) ||
    /^(String|Text)( ?Multiline)?$/i.test(node.class_type) ||
    /^ttN text$|ShowText|Show Text|PreviewAny/i.test(node.class_type)
  if (isPrimitive) {
    if ('source' in inp) return ev('source')
    const key = STRING_INPUT_KEYS.find((k) => k in inp)
    if (key) return ev(key)
  }

  // Anything else produces its value at runtime (TextGenerate, LLM nodes, wildcards…).
  const src = STRING_INPUT_KEYS.find((k) => k in inp)
  const runtime: RuntimeSource = { nodeId: id, classType: node.class_type }
  if (src) {
    const s = ev(src)
    runtime.input = s.text
  }
  return { text: `⟨${node.class_type} #${id}⟩`, runtime: [runtime] }
}

// ---------------------------------------------------------------------------
// Conditioning → prompt texts

/** Inputs that carry prompt text on text-encoder nodes. */
const TEXT_KEYS = ['text', 'text_g', 'text_l', 'clip_l', 't5xxl', 'prompt', 'positive_prompt', 'negative_prompt']
/** Inputs we never walk through when searching for text encoders. */
const SKIP_WALK = new Set(['clip', 'model', 'vae', 'image', 'pixels', 'latent', 'samples', 'mask'])

/** Loaders that take prompt text themselves and output conditioning (Efficient Loader, Eff. Loader SDXL…). */
const isPromptLoader = (node: ApiNode) => /Loader/i.test(node.class_type)

type Polarity = 'positive' | 'negative'

function collectPrompts(graph: ApiGraph, start: unknown, polarity: Polarity): PromptText[] {
  const out: PromptText[] = []
  const seen = new Set<string>()
  const walk = (v: unknown) => {
    if (!isLink(v)) return
    const id = linkId(v)
    if (seen.has(id)) return
    seen.add(id)
    const node = graph[id]
    if (!node) return
    const inp = node.inputs ?? {}
    const textKeys = TEXT_KEYS.filter((k) => k in inp)
    if (textKeys.length && 'clip' in inp) {
      const parts = textKeys.map((k) => evalString(graph, inp[k]))
      // For SDXL-style encoders text_g/text_l are usually identical — dedupe.
      const uniq = [...new Set(parts.map((p) => p.text))]
      const runtime = parts.flatMap((p) => p.runtime)
      out.push({
        nodeId: id,
        classType: node.class_type,
        text: uniq.join('\n\n'),
        ...(runtime.length ? { runtime } : {})
      })
      return
    }
    if (polarity in inp) {
      if (isPromptLoader(node)) {
        const e = evalString(graph, inp[polarity])
        out.push({ nodeId: id, classType: node.class_type, text: e.text, ...(e.runtime.length ? { runtime: e.runtime } : {}) })
        return
      }
      // Conditioning pass-through with separate polarities (ControlNetApplyAdvanced…):
      // follow only the matching branch so positive and negative don't mix.
      walk(inp[polarity])
      return
    }
    for (const [k, val] of Object.entries(inp)) if (!SKIP_WALK.has(k)) walk(val)
  }
  walk(start)
  return out
}

// ---------------------------------------------------------------------------
// Graph helpers

function ancestors(graph: ApiGraph, roots: string[]): Map<string, number> {
  // node id → shortest distance from any root
  const dist = new Map<string, number>()
  const queue: [string, number][] = roots.map((r) => [r, 0])
  while (queue.length) {
    const [id, d] = queue.shift()!
    if (dist.has(id)) continue
    dist.set(id, d)
    const node = graph[id]
    if (!node) continue
    for (const v of Object.values(node.inputs ?? {})) if (isLink(v)) queue.push([linkId(v), d + 1])
  }
  return dist
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** Strip ComfyUI's counter suffix: "foo_00004_.png" → "foo". */
export function filePrefix(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/_\d{5,}_?$/, '')
}

const isSaveNode = (n: ApiNode) =>
  typeof n.inputs?.filename_prefix === 'string' || (typeof n.inputs?.filename === 'string' && 'images' in n.inputs)

function findOutputNodes(graph: ApiGraph, relPath: string): { ids: string[]; matched: boolean } {
  const fileName = relPath.split('/').pop() ?? relPath
  // Files written by PreviewImage live in temp/ as ComfyUI_temp_xxxxx_NNNNN_.png
  if (/^ComfyUI_temp_/.test(fileName)) {
    const previews = Object.entries(graph).filter(([, n]) => n.class_type === 'PreviewImage')
    if (previews.length) return { ids: previews.map(([id]) => id), matched: previews.length === 1 }
  }
  const outputs = Object.entries(graph).filter(([, n]) => isSaveNode(n))
  const prefix = filePrefix(fileName)
  const relPrefix = filePrefix(relPath)
  const matches = outputs.filter(([, n]) => {
    const p = String(n.inputs.filename_prefix ?? n.inputs.filename).replace(/\\/g, '/')
    return p === relPrefix || p.endsWith('/' + relPrefix) || p.split('/').pop() === prefix
  })
  if (matches.length) return { ids: matches.map(([id]) => id), matched: true }
  return { ids: outputs.map(([id]) => id), matched: false }
}

const MODEL_KEYS: Record<string, ModelKind> = {
  ckpt_name: 'checkpoint',
  base_ckpt_name: 'checkpoint',
  refiner_ckpt_name: 'checkpoint',
  unet_name: 'unet',
  clip_name: 'clip',
  clip_name1: 'clip',
  clip_name2: 'clip',
  clip_name3: 'clip',
  vae_name: 'vae',
  model_name: 'other',
  control_net_name: 'other',
  upscale_model_name: 'other'
}

const isLoraName = (v: unknown): v is string => typeof v === 'string' && v !== 'None' && v !== ''

/**
 * LoRAs declared by a single node. Handles plain loaders, Efficient Loader's built-in slot,
 * and the stack nodes (easy loraStack, Efficiency LoRA Stacker, rgthree stacks / Power Lora Loader).
 */
function nodeLoras(id: string, node: ApiNode): LoraRef[] {
  const inp = node.inputs ?? {}
  const out: LoraRef[] = []
  const add = (name: unknown, model?: unknown, clip?: unknown) => {
    if (isLoraName(name))
      out.push({ name, strengthModel: num(model), strengthClip: num(clip), nodeId: id, classType: node.class_type })
  }

  if (inp.toggle === false) return out
  // Only slots up to the declared count are active; the rest keep stale values.
  const count = num(inp.num_loras) ?? num(inp.lora_count) ?? Infinity
  const advanced = inp.mode === 'advanced' || inp.input_mode === 'advanced'

  add(inp.lora_name, inp.strength_model ?? inp.lora_model_strength ?? inp.strength, inp.strength_clip ?? inp.lora_clip_strength)

  for (const [k, v] of Object.entries(inp)) {
    let m: RegExpMatchArray | null
    if ((m = k.match(/^lora_(\d+)_name$/))) {
      // easy loraStack
      const n = Number(m[1])
      if (n > count) continue
      if (advanced) add(v, inp[`lora_${n}_model_strength`], inp[`lora_${n}_clip_strength`])
      else add(v, inp[`lora_${n}_strength`])
    } else if ((m = k.match(/^lora_name_(\d+)$/))) {
      // Efficiency LoRA Stacker
      const n = Number(m[1])
      if (n > count) continue
      if (advanced) add(v, inp[`model_str_${n}`], inp[`clip_str_${n}`])
      else add(v, inp[`lora_wt_${n}`])
    } else if ((m = k.match(/^lora_(\d+)$/)) && typeof v === 'string') {
      // rgthree Lora Loader Stack: lora_01 / strength_01
      add(v, inp[`strength_${m[1]}`])
    } else if (v && typeof v === 'object' && !Array.isArray(v) && 'lora' in v) {
      // rgthree Power Lora Loader: lora_1: { on, lora, strength, strengthTwo? }
      const o = v as Record<string, unknown>
      if (o.on !== false) add(o.lora, o.strength, o.strengthTwo)
    }
  }
  return out
}

// ---------------------------------------------------------------------------

export function analyzeComfy(graph: ApiGraph, relPath: string, chunks: Record<string, string> = {}): ComfyInfo {
  const final = chunks.final_prompt
  const finalSource = chunks.final_prompt_source
  overridesOf.set(graph, new Map(final !== undefined && finalSource ? [[finalSource, final]] : []))
  usedOf.set(graph, new Set())

  const { ids: outputNodes, matched } = findOutputNodes(graph, relPath)
  // Without any output node (odd export) consider the whole graph.
  const dist = outputNodes.length ? ancestors(graph, outputNodes) : new Map(Object.keys(graph).map((k) => [k, 0]))
  // Upstream-first, ties broken by numeric node id for stable ordering.
  const ordered = [...dist.entries()]
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))
    .map(([id]) => id)

  const stages: SamplerStage[] = []
  const models: ModelRef[] = []
  const loras: LoraRef[] = []
  let latent: ComfyInfo['latent']

  for (const id of ordered) {
    const node = graph[id]
    if (!node) continue
    const inp = node.inputs ?? {}

    // Sampler-like: consumes positive conditioning and actually samples (KSampler, KSamplerAdvanced,
    // Efficient samplers, FaceDetailer, CFGGuider…), or a BasicGuider-style node with one conditioning.
    // Excluded: prompt loaders (Efficient Loader), conditioning pass-throughs (ControlNet), save nodes.
    const samplerish = ['seed', 'noise_seed', 'steps'].some((k) => k in inp) || /Sampler|Detailer|Guider/.test(node.class_type)
    const hasPos = isLink(inp.positive) && samplerish && !isPromptLoader(node) && !isSaveNode(node)
    const basicGuider = !hasPos && isLink(inp.conditioning) && /Guider/.test(node.class_type)
    // KSampler SDXL (Eff.) gets both prompts bundled in a tuple from Eff. Loader SDXL.
    const sdxlTuple = !hasPos && samplerish && isLink(inp.sdxl_tuple)
    if (hasPos || basicGuider || sdxlTuple) {
      stages.push({
        nodeId: id,
        classType: node.class_type,
        seed: num(inp.seed) ?? num(inp.noise_seed),
        steps: num(inp.steps),
        cfg: num(inp.cfg),
        sampler: str(inp.sampler_name),
        scheduler: str(inp.scheduler),
        denoise: num(inp.denoise),
        positive: collectPrompts(graph, hasPos ? inp.positive : sdxlTuple ? inp.sdxl_tuple : inp.conditioning, 'positive'),
        negative: hasPos || sdxlTuple ? collectPrompts(graph, hasPos ? inp.negative : inp.sdxl_tuple, 'negative') : []
      })
    }

    for (const [k, kind] of Object.entries(MODEL_KEYS)) {
      const v = str(inp[k])
      if (!v || v === 'None' || v === 'Baked VAE') continue
      if (!models.some((m) => m.kind === kind && m.name === v)) models.push({ kind, name: v, nodeId: id, classType: node.class_type })
    }

    loras.push(...nodeLoras(id, node))

    if (!latent && /Latent/.test(node.class_type) && num(inp.width) && num(inp.height)) {
      latent = { width: num(inp.width)!, height: num(inp.height)!, batch: num(inp.batch_size) }
    } else if (!latent && num(inp.empty_latent_width) && num(inp.empty_latent_height)) {
      // Efficient Loader creates the latent itself
      latent = { width: num(inp.empty_latent_width)!, height: num(inp.empty_latent_height)!, batch: num(inp.batch_size) }
    }
  }

  const finalPrompt =
    final !== undefined ? { text: final, source: finalSource, used: usedOf.get(graph)!.size > 0 } : undefined
  return { outputNodes, outputMatched: matched, stages, models, loras, latent, finalPrompt }
}

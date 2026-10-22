export interface FileEntry {
  path: string
  /** The opened top-level folder this file belongs to. */
  root: string
  /** Path relative to `root`, with forward slashes. */
  rel: string
  name: string
  size: number
  mtime: number
}

export interface ScanResult {
  files: FileEntry[]
  /** Requested folders that don't exist or aren't reachable right now. */
  missing: string[]
}

/** A piece of a prompt produced at runtime (e.g. by an LLM node) that can't be recovered from metadata. */
export interface RuntimeSource {
  nodeId: string
  classType: string
  /** Best-effort static value of the node's text input, if any. */
  input?: string
  /** The node's actual output was recovered from a saved final_prompt chunk. */
  resolved?: boolean
}

export interface PromptText {
  nodeId: string
  classType: string
  text: string
  /**
   * Runtime-generated parts of `text`. Unresolved ones appear in `text` as ⟨placeholders⟩;
   * resolved ones were filled in from a saved final_prompt chunk.
   */
  runtime?: RuntimeSource[]
}

export interface SamplerStage {
  nodeId: string
  classType: string
  seed?: number
  steps?: number
  cfg?: number
  sampler?: string
  scheduler?: string
  denoise?: number
  positive: PromptText[]
  negative: PromptText[]
}

export type ModelKind = 'checkpoint' | 'unet' | 'clip' | 'vae' | 'other'

export interface ModelRef {
  kind: ModelKind
  name: string
  nodeId: string
  classType: string
}

export interface LoraRef {
  name: string
  strengthModel?: number
  strengthClip?: number
  nodeId: string
  classType: string
}

export interface ComfyInfo {
  /** SaveImage-like node(s) this file is attributed to. */
  outputNodes: string[]
  /** True when the output node was matched by filename_prefix; false = fell back to all outputs. */
  outputMatched: boolean
  stages: SamplerStage[]
  models: ModelRef[]
  loras: LoraRef[]
  latent?: { width: number; height: number; batch?: number }
  /** Text saved by the SaveImageWithText node, if present. */
  finalPrompt?: { text: string; source?: string; used: boolean }
}

/** Text parameters in A1111/Forge format (also written by ComfyUI "Save Image w/Metadata"). */
export interface A1111Params {
  positive: string
  negative: string
  settings: [string, string][]
}

export interface ImageMeta {
  path: string
  width?: number
  height?: number
  format: 'png' | 'jpeg' | 'webp' | 'other'
  hasPrompt: boolean
  hasWorkflow: boolean
  comfy?: ComfyInfo
  a1111?: A1111Params
  /** All text chunks, keyed by PNG keyword. */
  chunks: Record<string, string>
  error?: string
}

/** What the search index keeps per image. */
export interface SearchDoc {
  path: string
  mtime: number
  size: number
  /** All positive prompt texts (sampler stages, saved parameters, final prompt), joined. */
  pos: string
  neg: string
  models: string[]
  loras: string[]
  seeds: number[]
}

export interface IndexProgress {
  /** Increments with every new indexing run, so stale events can be ignored. */
  run: number
  done: number
  total: number
  docs: SearchDoc[]
}

export interface ThumbStats {
  count: number
  bytes: number
  /** Thumbnails not belonging to any file in the open folders (changed, deleted or removed files). */
  unusedCount: number
  unusedBytes: number
}

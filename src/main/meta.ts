import { parseA1111 } from '@shared/a1111'
import { analyzeComfy, parseComfyJson, type ApiGraph } from '@shared/comfy'
import type { ImageMeta } from '@shared/types'
import { readImage } from './formats'

export async function readMeta(path: string, relPath: string): Promise<ImageMeta> {
  const base: ImageMeta = { path, format: 'other', hasPrompt: false, hasWorkflow: false, chunks: {} }
  try {
    const img = await readImage(path)
    const meta: ImageMeta = {
      ...base,
      format: img.format,
      width: img.width || undefined,
      height: img.height || undefined,
      chunks: img.text,
      hasPrompt: 'prompt' in img.text,
      hasWorkflow: 'workflow' in img.text
    }
    if (img.text.parameters) meta.a1111 = parseA1111(img.text.parameters)
    if (meta.hasPrompt) {
      const graph = parseComfyJson(img.text.prompt)
      if (graph && typeof graph === 'object') meta.comfy = analyzeComfy(graph as ApiGraph, relPath, img.text)
    }
    return meta
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

import { parseA1111 } from '@shared/a1111'
import { analyzeComfy, parseComfyJson, type ApiGraph } from '@shared/comfy'
import type { ImageMeta } from '@shared/types'
import { readPng } from './png'

export async function readMeta(path: string, relPath: string): Promise<ImageMeta> {
  const base: ImageMeta = { path, format: 'other', hasPrompt: false, hasWorkflow: false, chunks: {} }
  if (!/\.png$/i.test(path)) return base
  try {
    const png = await readPng(path)
    const meta: ImageMeta = {
      ...base,
      format: 'png',
      width: png.width,
      height: png.height,
      chunks: png.text,
      hasPrompt: 'prompt' in png.text,
      hasWorkflow: 'workflow' in png.text
    }
    if (png.text.parameters) meta.a1111 = parseA1111(png.text.parameters)
    if (meta.hasPrompt) {
      const graph = parseComfyJson(png.text.prompt)
      if (graph && typeof graph === 'object') meta.comfy = analyzeComfy(graph as ApiGraph, relPath, png.text)
    }
    return meta
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

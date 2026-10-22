// Runs the metadata parser over a folder and reports what it extracted.
// Usage: pnpm survey <folder> [--verbose]
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readMeta } from '../src/main/meta'

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(png|jpe?g|webp)$/i.test(e.name)) yield p
  }
}

const [root, flag] = process.argv.slice(2)
const verbose = flag === '--verbose'
let a1111 = 0
let total = 0, errors = 0, unmatched = 0, noStages = 0, emptyPos = 0, runtime = 0
for await (const p of walk(root)) {
  total++
  const rel = relative(root, p).split('\\').join('/')
  const m = await readMeta(p, rel)
  if (m.error) { errors++; console.log('ERR', rel, m.error); continue }
  if (m.a1111) a1111++
  const c = m.comfy
  if (!c) continue
  if (!c.outputMatched) unmatched++
  if (!c.stages.length) { noStages++; if (process.env.SHOW_EMPTY) console.log('NOSTAGE', rel, c.outputNodes.join(','), c.outputMatched) }
  if (c.stages.some((s) => !s.positive.some((t) => t.text.trim()))) { emptyPos++; if (process.env.SHOW_EMPTY) console.log('EMPTY', rel) }
  if (c.stages.some((s) => s.positive.some((t) => t.runtime?.some((r) => !r.resolved)))) runtime++
  if (verbose) {
    console.log(`\n${rel}  ${m.width}x${m.height} wf=${m.hasWorkflow} out=${c.outputNodes}${c.outputMatched ? '' : '(fallback)'}`)
    for (const s of c.stages) {
      console.log(`  [${s.classType} #${s.nodeId}] seed=${s.seed} steps=${s.steps} cfg=${s.cfg} ${s.sampler}/${s.scheduler} d=${s.denoise}`)
      for (const t of s.positive) console.log(`    + ${t.text.slice(0, 100).replace(/\n/g, '⏎')}${t.runtime ? '  RUNTIME:' + t.runtime.map((r) => r.classType + (r.resolved ? '(resolved)' : '')).join(',') : ''}`)
      for (const t of s.negative) console.log(`    - ${t.text.slice(0, 100).replace(/\n/g, '⏎')}`)
    }
    console.log('  models:', c.models.map((x) => `${x.kind}:${x.name}`).join(' | '))
    console.log('  loras:', c.loras.map((x) => `${x.name}@${x.strengthModel}/${x.strengthClip}`).join(' | '))
  }
}
console.log({ a1111, total, errors, unmatched, noStages, emptyPos, runtime })

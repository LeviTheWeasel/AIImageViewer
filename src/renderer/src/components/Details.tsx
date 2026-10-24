import { useContext, useState } from 'react'
import type { A1111Params, FileEntry, ImageMeta, PromptText, SamplerStage } from '@shared/types'
import { parseComfyJson } from '@shared/comfy'
import { fileUrl, formatBytes, useMeta } from '../lib'
import { HighlightContext, splitMatches } from '../search'

export default function Details({
  file, onOpen, showPreview = true, fav, onToggleFav
}: { file: FileEntry; onOpen?: () => void; showPreview?: boolean; fav: boolean; onToggleFav: () => void }) {
  const meta = useMeta(file)
  const stem = file.name.replace(/\.[^.]+$/, '')

  return (
    <div className="details">
      {showPreview && (
        <div
          className="preview"
          onClick={onOpen}
          draggable
          onDragStart={(e) => {
            e.preventDefault()
            window.api.startDrag(file.path)
          }}
          title="Click to enlarge · drag into ComfyUI to load the workflow"
        >
          <img key={file.path} src={fileUrl(file.path)} alt="" draggable={false} />
        </div>
      )}

      <div className="file-head">
        <div className="file-name" title={file.path}>{file.rel}</div>
        <div className="file-sub">
          {meta?.width ? `${meta.width}×${meta.height} · ` : ''}
          {formatBytes(file.size)} · {new Date(file.mtime).toLocaleString()}
        </div>
        {meta && <Badges meta={meta} />}
      </div>

      {meta && (
        <div className="actions">
          <button className={`fav-btn${fav ? ' on' : ''}`} onClick={onToggleFav} title="Toggle favorite (F)">
            {fav ? '★ Favorite' : '☆ Add to favorites'}
          </button>
          {meta.hasWorkflow && (
            <>
              <button onClick={() => window.api.saveText(`${stem}.workflow.json`, pretty(meta.chunks.workflow))}>
                Save workflow.json
              </button>
              <CopyButton label="Copy workflow" text={() => pretty(meta.chunks.workflow)} />
            </>
          )}
          {meta.hasPrompt && (
            <button onClick={() => window.api.saveText(`${stem}.api.json`, pretty(meta.chunks.prompt))}>
              Save API prompt
            </button>
          )}
          {Object.keys(meta.chunks).length > 0 && <CleanCopyButton path={file.path} />}
          <button onClick={() => window.api.reveal(file.path)}>Show in folder</button>
        </div>
      )}

      {!meta ? (
        <div className="muted pad">Reading metadata…</div>
      ) : meta.error ? (
        <div className="warn pad">Couldn't read metadata: {meta.error}</div>
      ) : meta.comfy || meta.a1111 ? (
        <>
          {meta.a1111 && <A1111Card params={meta.a1111} />}
          {meta.comfy && <ComfySection meta={meta} />}
        </>
      ) : (
        <div className="muted pad">
          No generation metadata in this image.
        </div>
      )}

      {meta && Object.keys(meta.chunks).length > 0 && <RawChunks chunks={meta.chunks} />}
    </div>
  )
}

function Badges({ meta }: { meta: ImageMeta }) {
  return (
    <div className="badges">
      {meta.hasWorkflow && <span className="badge wf">Workflow</span>}
      {meta.hasPrompt && !meta.hasWorkflow && <span className="badge api" title="Contains the API prompt only. ComfyUI can still load it, but without node layout, groups and notes.">API prompt only</span>}
      {meta.a1111 && (
        <span className="badge params" title="Generation parameters as text (A1111 format)">Parameters</span>
      )}
      {!meta.hasPrompt && !meta.hasWorkflow && !meta.a1111 && <span className="badge none">No metadata</span>}
    </div>
  )
}

function ComfySection({ meta }: { meta: ImageMeta }) {
  const c = meta.comfy!
  return (
    <>
      {!c.outputMatched && c.outputNodes.length > 1 && (
        <div className="note pad">
          Couldn't tell which of the {c.outputNodes.length} output nodes saved this file, so all their branches are shown.
        </div>
      )}

      {c.stages.map((s, i) => <StageCard key={s.nodeId} stage={s} index={i} total={c.stages.length} />)}

      {c.finalPrompt && !c.finalPrompt.used && (
        <div className="stage">
          <PromptBlock
            label="Final prompt (saved)"
            kind="pos"
            texts={[{ nodeId: c.finalPrompt.source ?? '', classType: 'final_prompt', text: c.finalPrompt.text }]}
          />
        </div>
      )}

      <Section title="Models">
        {c.models.length ? (
          <ul className="list">
            {c.models.map((m) => (
              <li key={m.nodeId + m.name}>
                <span className="tag">{m.kind}</span>
                <span className="mono">{m.name}</span>
              </li>
            ))}
          </ul>
        ) : <div className="muted">—</div>}
      </Section>

      <Section title={`LoRAs (${c.loras.length})`}>
        {c.loras.length ? (
          <ul className="list">
            {c.loras.map((l, i) => (
              <li key={l.nodeId + i}>
                <span className="mono grow">{l.name}</span>
                <span className="strength" title="strength model / clip">
                  {fmt(l.strengthModel)}{l.strengthClip !== undefined && l.strengthClip !== l.strengthModel ? ` / ${fmt(l.strengthClip)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : <div className="muted">None</div>}
      </Section>

      {c.latent && (
        <Section title="Latent">
          <div className="mono">
            {c.latent.width}×{c.latent.height}{c.latent.batch && c.latent.batch > 1 ? ` · batch ${c.latent.batch}` : ''}
          </div>
        </Section>
      )}
    </>
  )
}

function A1111Card({ params: p }: { params: A1111Params }) {
  const seed = Number(p.settings.find(([k]) => k === 'Seed')?.[1])
  return (
    <div className="stage">
      <div className="stage-head">
        <span>Saved parameters</span>
        <span className="muted" title="Text block written by the save node (A1111 format). It holds the prompt exactly as it was sent, including randomly generated parts.">
          A1111 format
        </span>
        {Number.isFinite(seed) && seed > 0 && <SeedChip seed={seed} />}
      </div>
      <div className="params">
        {p.settings.filter(([k]) => k !== 'Seed').map(([k, v]) => (
          <div key={k}><span className="muted">{k}</span> <span className="mono">{v}</span></div>
        ))}
      </div>
      <PromptBlock label="Positive" kind="pos" texts={[{ nodeId: '', classType: 'parameters', text: p.positive }]} />
      {p.negative && <PromptBlock label="Negative" kind="neg" texts={[{ nodeId: '', classType: 'parameters', text: p.negative }]} />}
    </div>
  )
}

function StageCard({ stage: s, index, total }: { stage: SamplerStage; index: number; total: number }) {
  const params: [string, unknown][] = [
    ['steps', s.steps], ['cfg', s.cfg], ['sampler', s.sampler],
    ['scheduler', s.scheduler], ['denoise', s.denoise]
  ]
  return (
    <div className="stage">
      <div className="stage-head">
        {total > 1 && <span className="stage-n">{index + 1}</span>}
        <span>{s.classType}</span>
        <span className="muted">#{s.nodeId}</span>
        {s.seed !== undefined && <SeedChip seed={s.seed} />}
      </div>
      <div className="params">
        {params.filter(([, v]) => v !== undefined).map(([k, v]) => (
          <div key={k}><span className="muted">{k}</span> <span className="mono">{String(v)}</span></div>
        ))}
      </div>
      <PromptBlock label="Positive" kind="pos" texts={s.positive} />
      {s.negative.length > 0 && <PromptBlock label="Negative" kind="neg" texts={s.negative} />}
    </div>
  )
}

function SeedChip({ seed }: { seed: number }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="seed"
      title="Copy seed"
      onClick={async () => {
        await navigator.clipboard.writeText(String(seed))
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      <span className="muted">seed</span> <span className="mono">{seed}</span> <span className="seed-icon">{done ? '✓' : '⧉'}</span>
    </button>
  )
}

function Highlighted({ text, words }: { text: string; words: string[] }) {
  const parts = splitMatches(text, words)
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>
}

function PromptBlock({ label, kind, texts }: { label: string; kind: 'pos' | 'neg'; texts: PromptText[] }) {
  const hl = useContext(HighlightContext)
  const joined = texts.map((t) => t.text).join('\n\n')
  const runtime = texts.flatMap((t) => t.runtime ?? [])
  return (
    <div className={`prompt ${kind}`}>
      <div className="prompt-head">
        <span>{label}</span>
        {texts.length > 1 && <span className="muted">{texts.length} encoders</span>}
        <CopyButton label="Copy" text={() => joined} small />
      </div>
      {joined.trim() ? (
        <div className="prompt-text"><Highlighted text={joined} words={kind === 'pos' ? hl.pos : hl.neg} /></div>
      ) : <div className="muted">(empty)</div>}
      {runtime.map((r) => (
        <details key={r.nodeId} className={`runtime${r.resolved ? ' resolved' : ''}`}>
          <summary>
            {r.resolved
              ? <>Includes text generated by {r.classType} #{r.nodeId} at run time</>
              : <>⟨{r.classType} #{r.nodeId}⟩ was generated at run time and isn't stored in the image</>}
          </summary>
          {!r.resolved && (
            <div className="muted">
              Save with the “Save Image (+ final prompt)” node to keep the generated text in the file.
            </div>
          )}
          {r.input && (
            <>
              <div className="muted">Input it received:</div>
              <div className="prompt-text">{r.input}</div>
            </>
          )}
        </details>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  )
}

function RawChunks({ chunks }: { chunks: Record<string, string> }) {
  return (
    <Section title="Raw metadata">
      {Object.entries(chunks).map(([k, v]) => <RawItem key={k} name={k} text={v} />)}
    </Section>
  )
}

function RawItem({ name, text }: { name: string; text: string }) {
  // Pretty-printing big workflows is only worth doing once the user expands one.
  const [open, setOpen] = useState(false)
  return (
    <details className="raw" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="mono">{name}</span> <span className="muted">{formatBytes(text.length)}</span>
      </summary>
      {open && (
        <div className="raw-body">
          <CopyButton label="Copy" text={() => pretty(text)} small />
          <pre>{pretty(text)}</pre>
        </div>
      )}
    </details>
  )
}

function CopyButton({ label, text, small }: { label: string; text: () => string; small?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={small ? 'small' : undefined}
      onClick={async () => {
        await navigator.clipboard.writeText(text())
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  )
}

function pretty(raw: string) {
  try {
    return JSON.stringify(parseComfyJson(raw), null, 2)
  } catch {
    return raw
  }
}

const fmt = (n?: number) => (n === undefined ? '—' : String(Math.round(n * 100) / 100))

function CleanCopyButton({ path }: { path: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')
  const run = async () => {
    setState('busy')
    const r = await window.api.saveCleanCopy(path)
    if (r === 'saved') {
      setState('saved')
      setTimeout(() => setState('idle'), 2000)
    } else if (r === 'canceled') setState('idle')
    else {
      setError(r)
      setState('error')
    }
  }
  return (
    <button
      onClick={run}
      disabled={state === 'busy'}
      title={state === 'error' ? error : 'Save a copy of the image with prompts, workflow and EXIF removed. The image itself is not re-encoded.'}
    >
      {state === 'saved' ? 'Saved ✓' : state === 'error' ? 'Couldn\'t save copy' : 'Save copy without metadata'}
    </button>
  )
}

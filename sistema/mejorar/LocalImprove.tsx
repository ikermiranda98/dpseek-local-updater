/**
 * «Improve message» en la barra del cuadro de texto (añadido por dpseek-local-updater).
 *
 * Un botón más de la barra, junto al «+» y con su mismo aspecto: pide al modelo del
 * chat (en su misma variante de contexto, así Ollama no lo recarga) una versión más
 * clara del mensaje para la IA. También convierte un documento (PDF, DOCX o texto)
 * en un prompt: con el cuadro vacío, el botón pide el fichero; con texto, el fichero
 * se añade desde la tarjeta o soltándolo sobre el botón.
 *
 * La tarjeta, encima del cuadro, enseña el texto mientras el modelo lo escribe y
 * «Cancel» corta la petición también en Ollama. Con la sugerencia: otras versiones
 * (corta, detallada, en pasos), «Think deeper» (con el razonamiento del modelo),
 * «Show changes» (lo añadido y lo quitado respecto a tu texto) y, si falta algo, una o
 * dos preguntas. «Use» la pone en el cuadro (no la envía). Si lo que escribes es vago
 * («arregla eso»), el propio botón lo indica al dejar de escribir.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconSparkleMedium, Tooltip, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { DOCUMENT_ACCEPT, localDocumentText } from './local-document-text.ts'
import { localDiff, localDiffCount } from './local-improve-diff.ts'
import {
  improver, isLongPrompt, subscribeImprover,
  type LocalImproveDocument, type LocalImproveOptions, type LocalImproveStyle, type LocalImproveSuggestion,
} from './local-improve-bridge.ts'
import css from './LocalImprove.module.css'

type VersionKey = 'suggested' | LocalImproveStyle

const VERSIONS: readonly { readonly key: VersionKey; readonly label: string }[] = [
  { key: 'suggested', label: 'Suggested' },
  { key: 'short', label: 'Short' },
  { key: 'detailed', label: 'Detailed' },
  { key: 'steps', label: 'Step by step' },
]

/** Cómo se llama cada fase del Host en la tarjeta. */
const PHASES: Readonly<Record<string, string>> = {
  writing: 'Writing…',
  thinking: 'Thinking…',
  reviewing: 'Reviewing the prompt…',
  rewriting: 'Rewriting it, keeping all of it…',
}

/** Una orden sin objeto: «arregla», «hazlo», «mejóralo eso». */
const BARE_COMMAND = /^(por favor,?\s*)?(arr[eé]gl(a|alo|ala)|hazlo|haz(lo)? que funcione|mej[oó]r(a|alo|ala)|c[aá]mbialo|fix|improve|change)(\s+(eso|esto|aquello|it|this|that|lo|la))?\s*(por favor)?[.!?]*$/i
/** Una referencia a algo sin decir qué: «lo de antes», «lo que te dije». */
const VAGUE_REFERENCE = /(^|\s)(eso|esto|aquello|lo de antes|lo que (te )?dije|como (te )?dije|como antes)([\s.,!?]|$)/i
/** Una queja sin detalles: solo vale como vaga si el mensaje es muy corto. */
const BARE_COMPLAINT = /(no va|no funciona|sigue (sin funcionar|igual|mal)|que funcione|doesn'?t work|not working|make it work)/i
/** Algo concreto: un fichero, código, un identificador o una cifra. */
const SPECIFIC = /[\w-]+\.[a-z0-9]{1,5}\b|`|\b[a-z]+[A-Z]\w*|\w+_\w+|\d{2,}/

/** @returns si el mensaje es corto y vago (el botón lo indica; nunca cambia nada solo). */
export function isVagueDraft(draft: string): boolean {
  const text = draft.trim()
  if (text.length < 4 || text.length > 140 || SPECIFIC.test(text)) return false
  const words = text.split(/\s+/).length
  return BARE_COMMAND.test(text) || (VAGUE_REFERENCE.test(text) && words <= 8) || (BARE_COMPLAINT.test(text) && words <= 5)
}

/**
 * El botón de la barra y la tarjeta con la sugerencia.
 * @param props - chat, borrador, cómo sustituirlo y la clase del botón «+» (mismo aspecto).
 * @returns el botón, o nada fuera de un chat o dentro de un subagente.
 */
export function LocalImprove({ sessionId, draft, subagent, setDraft, className, disabled }: {
  sessionId: string | undefined
  draft: string
  subagent: boolean
  setDraft: (text: string) => void
  className: string | undefined
  disabled: boolean
}): ReactNode {
  const host = useSyncExternalStore(subscribeImprover, improver)
  const [busy, setBusy] = useState<string | null>(null)
  const [live, setLive] = useState<{ phase: string; text: string }>({ phase: '', text: '' })
  const [document, setDocument] = useState<LocalImproveDocument | null>(null)
  const [versions, setVersions] = useState<Partial<Record<VersionKey, LocalImproveSuggestion & { deep?: boolean }>>>({})
  const [active, setActive] = useState<VersionKey>('suggested')
  const [original, setOriginal] = useState('')
  const [answers, setAnswers] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showChanges, setShowChanges] = useState(false)
  // Un prompt largo se reorganiza entero en el Host y tarda minutos.
  const [slow, setSlow] = useState(false)
  const [vague, setVague] = useState(false)
  const button = useRef<HTMLButtonElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  const liveBox = useRef<HTMLPreElement | null>(null)
  // Cada petición lleva un número: si se descarta la tarjeta, la respuesta que llegue tarde no se enseña.
  const generation = useRef(0)
  const job = useRef<string | null>(null)
  // La tarjeta va encima de todo el cuadro de texto y con su ancho.
  const composer = useRef<HTMLElement | null>(null)
  composer.current = button.current?.closest<HTMLElement>('[data-composer-dock]')?.parentElement
    ?? button.current?.parentElement?.parentElement?.parentElement ?? null
  const suggestion = versions[active] ?? null
  const open = busy !== null || suggestion !== null || error !== null
  const position = useAnchoredPosition({ open, anchorRef: composer, panelRef: card, side: 'top', align: 'start', gap: 8, margin: 12 })
  const width = composer.current?.getBoundingClientRect().width

  // El botón avisa de un mensaje vago cuando dejas de escribir (no mientras escribes).
  useEffect(() => {
    const timer = setTimeout(() => { setVague(isVagueDraft(draft)) }, 800)
    return () => { clearTimeout(timer) }
  }, [draft])
  // El texto en directo, siempre por el final.
  useEffect(() => {
    if (liveBox.current !== null) liveBox.current.scrollTop = liveBox.current.scrollHeight
  }, [live.text])

  if (host === undefined || sessionId === undefined || subagent) return null
  const empty = draft.trim() === ''

  const run = (options: LocalImproveOptions, status: string, key: VersionKey = 'suggested', deep = false): void => {
    const current = ++generation.current
    const jobId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${String(Date.now())}-${String(Math.random())}`
    job.current = jobId
    setBusy(status)
    setError(null)
    setLive({ phase: '', text: '' })
    setShowChanges(false)
    // Lo que lleva escrito, cada medio segundo, mientras dure.
    const poll = setInterval(() => {
      host.progress(jobId).then((value) => {
        if (current === generation.current && value.phase !== '') setLive(value)
      }, () => undefined)
    }, 500)
    host.improve(sessionId, draft, { ...options, jobId }).then(
      (value) => {
        if (current !== generation.current) return
        setVersions((known) => ({ ...known, [key]: { ...value, ...deep ? { deep: true } : {} } }))
        setActive(key)
        setAnswers(value.questions.map(() => ''))
      },
      (reason: unknown) => { if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) },
    ).finally(() => {
      clearInterval(poll)
      if (current === generation.current) { setBusy(null); job.current = null }
    })
  }
  /** Primera sugerencia (o desde cero): se olvidan las versiones anteriores. */
  const start = (options: LocalImproveOptions, status: string, long: boolean): void => {
    setVersions({})
    setActive('suggested')
    setOriginal(draft)
    setSlow(long)
    run(options, status)
  }
  const base = (): LocalImproveOptions => (document === null ? {} : { document })
  const load = (file: File): void => {
    const current = ++generation.current
    const controller = new AbortController()
    setBusy(`Reading ${file.name}…`)
    setLive({ phase: '', text: '' })
    setError(null)
    setVersions({})
    localDocumentText(file, controller.signal).then(
      (value) => {
        if (current !== generation.current) return
        setDocument(value)
        setVersions({})
        setActive('suggested')
        setOriginal(draft)
        setSlow(false)
        run({ document: value }, `Writing a prompt from ${file.name}…`)
      },
      (reason: unknown) => {
        if (current !== generation.current) return
        setBusy(null)
        setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }
  const pick = (): void => { picker.current?.click() }
  const click = (): void => {
    if (busy !== null) return
    if (empty && document === null) { pick(); return }
    const long = document === null && isLongPrompt(draft)
    start(base(), long ? 'Reorganizing a long prompt, keeping all of it… (a few minutes)' : 'Improving message…', long)
  }
  const close = (): void => {
    // Cortar también en Ollama lo que estuviera escribiendo.
    if (job.current !== null) void host.cancel(job.current).catch(() => undefined)
    job.current = null
    generation.current++
    setBusy(null)
    setVersions({})
    setActive('suggested')
    setError(null)
    setDocument(null)
    setAnswers([])
    setSlow(false)
    setShowChanges(false)
  }
  const pickVersion = (key: VersionKey): void => {
    if (busy !== null) return
    if (versions[key] !== undefined) { setActive(key); setShowChanges(false); return }
    run({ ...base(), ...key === 'suggested' ? {} : { style: key } }, `Writing the ${VERSIONS.find((v) => v.key === key)?.label.toLowerCase() ?? ''} version…`, key)
  }
  const thinkDeeper = (): void => {
    if (busy !== null) return
    run({ ...base(), ...active === 'suggested' ? {} : { style: active }, think: true },
      slow ? 'Thinking it through, then reorganizing… (several minutes)' : 'Thinking it through…', active, true)
  }
  const answered = suggestion === null ? [] : suggestion.questions
    .map((question, index) => ({ question, answer: (answers[index] ?? '').trim() }))
    .filter((item) => item.answer !== '')
  const diff = suggestion !== null && original.trim() !== '' ? localDiff(original, suggestion.text) : null
  const counts = diff === null ? null : localDiffCount(diff)
  const hint = vague && busy === null && !open
  const label = busy ?? (empty ? 'Create a prompt from a file (PDF, DOCX or text)'
    : hint ? 'This message is a bit vague: click to make it clearer' : 'Improve message (or drop a file here)')
  const phase = live.phase === '' ? busy : PHASES[live.phase] ?? `${live.phase.charAt(0).toUpperCase()}${live.phase.slice(1)}…`

  return (
    <>
      <Tooltip label={label} side="top" delayMs={hint ? 0 : 500}>
        <button ref={button} type="button" className={hint ? `${className ?? ''} ${css.hint}` : className}
          aria-label={empty ? 'Create a prompt from a file' : 'Improve message'}
          data-local-improve data-local-improve-hint={hint || undefined} data-busy={busy !== null || undefined}
          disabled={disabled || busy !== null}
          onMouseDown={(event) => { event.preventDefault() }} onClick={click}
          onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
          onDrop={(event) => {
            const file = event.dataTransfer.files[0]
            if (file === undefined) return
            event.preventDefault()
            event.stopPropagation()
            load(file)
          }}>
          <IconSparkleMedium size={14} className={busy !== null ? css.busy : undefined} />
        </button>
      </Tooltip>
      <input ref={picker} type="file" accept={DOCUMENT_ACCEPT} hidden data-local-improve-file
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) load(file)
        }} />
      {open && createPortal(
        <div ref={card} className={css.card} role="dialog" aria-label="Suggested message" data-local-improve-card
          style={{ ...position ?? { visibility: 'hidden', left: 0, top: 0 }, ...width === undefined ? {} : { width } }}>
          <div className={css.head}>
            <span>{slow ? 'Reorganized prompt' : document === null ? 'Suggested message' : 'Suggested prompt'}</span>
            {suggestion !== null && busy === null && (
              <span className={css.meta}>{suggestion.deep === true ? 'thought through · ' : ''}{(suggestion.ms / 1000).toFixed(1)} s</span>
            )}
          </div>
          {document !== null && (
            <div className={css.chip} data-local-improve-document>
              <span className={css.chipName}>📄 {document.name}{document.pages === undefined ? '' : ` · ${String(document.pages)} pages`}</span>
              {busy === null && (
                <button type="button" className={css.chipRemove} aria-label="Remove file" onClick={() => {
                  setDocument(null)
                  if (empty) close()
                  else start({}, 'Improving message…', false)
                }}>✕</button>
              )}
            </div>
          )}
          {!slow && (versions.suggested !== undefined || (busy !== null && active !== 'suggested')) && (
            <div className={css.tabs} role="tablist" data-local-improve-versions>
              {VERSIONS.map((version) => (
                <button key={version.key} type="button" role="tab" className={css.tab} aria-selected={active === version.key}
                  disabled={busy !== null} data-ready={versions[version.key] !== undefined || undefined}
                  onClick={() => { pickVersion(version.key) }}>{version.label}</button>
              ))}
            </div>
          )}
          {busy !== null && <>
            <p className={css.status}>{phase}</p>
            {live.text !== '' && (
              <pre ref={liveBox} className={css.live} data-local-improve-live data-phase={live.phase}>
                {live.text.length > 6000 ? `…${live.text.slice(-6000)}` : live.text}
              </pre>
            )}
          </>}
          {error !== null && busy === null && <p className={css.error}>Could not improve the message: {error}</p>}
          {suggestion !== null && busy === null && error === null && <>
            {suggestion.note !== undefined && <p className={css.note}>{suggestion.note}</p>}
            {showChanges && diff !== null
              ? (
                <div className={css.diff} data-local-improve-diff
                  style={{ maxHeight: `${String(Math.min(slow ? 22 : 12, Math.max(3, suggestion.text.split('\n').length + 1)) * 20 + 18)}px` }}>
                  {diff.map((part, index) => part.kind === 'same'
                    ? <span key={index}>{part.text}</span>
                    : part.kind === 'add'
                      ? <ins key={index} className={css.ins}>{part.text}</ins>
                      : <del key={index} className={css.del}>{part.text}</del>)}
                </div>
              )
              : (
                <textarea className={css.text} value={suggestion.text}
                  rows={Math.min(slow ? 22 : 12, Math.max(3, suggestion.text.split('\n').length + 1))}
                  onChange={(event) => {
                    const text = event.target.value
                    setVersions((known) => ({ ...known, [active]: { ...suggestion, text } }))
                  }} />
              )}
            {suggestion.questions.length > 0 && (
              <div className={css.questions} data-local-improve-questions>
                <span className={css.questionsTitle}>To make it clearer:</span>
                {suggestion.questions.map((question, index) => (
                  <label key={index} className={css.question}>
                    <span>{question}</span>
                    <input className={css.answer} value={answers[index] ?? ''} placeholder="Your answer (optional)"
                      onChange={(event) => {
                        const next = [...answers]
                        next[index] = event.target.value
                        setAnswers(next)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && answered.length > 0) {
                          event.preventDefault()
                          run({ ...base(), ...active === 'suggested' ? {} : { style: active }, answers: answered }, 'Updating with your answers…', active)
                        }
                      }} />
                  </label>
                ))}
              </div>
            )}
          </>}
          <div className={css.actions}>
            {busy === null && document === null && suggestion === null && (
              <button type="button" className={css.secondary} onClick={pick}>Add file…</button>
            )}
            {busy === null && suggestion !== null && error === null && suggestion.questions.length > 0 && (
              <button type="button" className={css.secondary} disabled={answered.length === 0}
                onClick={() => { run({ ...base(), ...active === 'suggested' ? {} : { style: active }, answers: answered }, 'Updating with your answers…', active) }}>
                Update with answers
              </button>
            )}
            {busy === null && suggestion !== null && error === null && counts !== null && (
              <button type="button" className={css.secondary} aria-pressed={showChanges} data-local-improve-changes
                onClick={() => { setShowChanges((value) => !value) }}>
                {showChanges ? 'Edit' : `Show changes (+${String(counts.added)} −${String(counts.removed)})`}
              </button>
            )}
            {busy === null && suggestion !== null && error === null && suggestion.deep !== true && (
              <Tooltip label="Ask again with the model's reasoning: better for tricky cases, but slower (about a minute)" side="top" delayMs={400}>
                <button type="button" className={css.secondary} onClick={thinkDeeper} data-local-improve-deeper>Think deeper</button>
              </Tooltip>
            )}
            <span className={css.spacer} />
            {busy === null && suggestion !== null && error === null && (
              <button type="button" className={css.use} onClick={() => { setDraft(suggestion.text); close() }}>Use</button>
            )}
            <button type="button" className={css.dismiss} onClick={close}>{busy === null ? 'Dismiss' : 'Cancel'}</button>
          </div>
        </div>,
        window.document.body,
      )}
    </>
  )
}

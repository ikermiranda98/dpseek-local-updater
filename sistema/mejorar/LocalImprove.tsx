/**
 * «Improve message» en la barra del cuadro de texto (añadido por dpseek-local-updater).
 *
 * Un botón más de la barra, junto al «+» y con su mismo aspecto: pide al modelo del
 * chat (en su misma variante de contexto, así Ollama no lo recarga) una versión más
 * clara del mensaje para la IA. También convierte un documento (PDF, DOCX o texto)
 * en un prompt: con el cuadro vacío, el botón pide el fichero; con texto, el fichero
 * se añade desde la tarjeta o soltándolo sobre el botón. La sugerencia sale en una
 * tarjeta encima del cuadro, editable; si falta algo, trae una o dos preguntas que se
 * pueden contestar para rehacerla. «Use» la pone en el cuadro (no la envía).
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconSparkleMedium, Tooltip, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { DOCUMENT_ACCEPT, localDocumentText } from './local-document-text.ts'
import {
  improver, subscribeImprover, type LocalImproveDocument, type LocalImproveOptions, type LocalImproveSuggestion,
} from './local-improve-bridge.ts'
import css from './LocalImprove.module.css'

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
  const [document, setDocument] = useState<LocalImproveDocument | null>(null)
  const [suggestion, setSuggestion] = useState<LocalImproveSuggestion | null>(null)
  const [answers, setAnswers] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  // Cada petición lleva un número: si se descarta la tarjeta, la respuesta que llegue tarde no se enseña.
  const generation = useRef(0)
  // La tarjeta va encima de todo el cuadro de texto y con su ancho.
  const composer = useRef<HTMLElement | null>(null)
  composer.current = button.current?.closest<HTMLElement>('[data-composer-dock]')?.parentElement
    ?? button.current?.parentElement?.parentElement?.parentElement ?? null
  // Con un documento, la lectura puede tardar: la tarjeta se abre ya con el progreso.
  const open = suggestion !== null || error !== null || (busy !== null && document !== null)
  const position = useAnchoredPosition({ open, anchorRef: composer, panelRef: card, side: 'top', align: 'start', gap: 8, margin: 12 })
  const width = composer.current?.getBoundingClientRect().width
  if (host === undefined || sessionId === undefined || subagent) return null
  const empty = draft.trim() === ''

  const run = (options: LocalImproveOptions, status: string): void => {
    const current = ++generation.current
    setBusy(status)
    setError(null)
    host.improve(sessionId, draft, options).then(
      (value) => {
        if (current !== generation.current) return
        setSuggestion(value)
        setAnswers(value.questions.map(() => ''))
      },
      (reason: unknown) => { if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) },
    ).finally(() => { if (current === generation.current) setBusy(null) })
  }
  const load = (file: File): void => {
    const current = ++generation.current
    const controller = new AbortController()
    setBusy(`Reading ${file.name}…`)
    setError(null)
    setSuggestion(null)
    localDocumentText(file, controller.signal).then(
      (value) => {
        if (current !== generation.current) return
        setDocument(value)
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
    if (empty && document === null) pick()
    else run(document === null ? {} : { document }, 'Improving message…')
  }
  const close = (): void => {
    generation.current++
    setBusy(null)
    setSuggestion(null)
    setError(null)
    setDocument(null)
    setAnswers([])
  }
  const answered = suggestion === null ? [] : suggestion.questions
    .map((question, index) => ({ question, answer: (answers[index] ?? '').trim() }))
    .filter((item) => item.answer !== '')
  const label = empty ? 'Create a prompt from a file (PDF, DOCX or text)' : 'Improve message (or drop a file here)'

  return (
    <>
      <Tooltip label={busy ?? label} side="top" delayMs={500}>
        <button ref={button} type="button" className={className} aria-label={empty ? 'Create a prompt from a file' : 'Improve message'}
          data-local-improve data-busy={busy !== null || undefined} disabled={disabled || busy !== null}
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
            <span>{document === null ? 'Suggested message' : 'Suggested prompt'}</span>
            {suggestion !== null && busy === null && <span className={css.meta}>{(suggestion.ms / 1000).toFixed(1)} s</span>}
          </div>
          {document !== null && (
            <div className={css.chip} data-local-improve-document>
              <span className={css.chipName}>📄 {document.name}{document.pages === undefined ? '' : ` · ${String(document.pages)} pages`}</span>
              {busy === null && (
                <button type="button" className={css.chipRemove} aria-label="Remove file" onClick={() => {
                  setDocument(null)
                  if (empty) close()
                  else run({}, 'Improving message…')
                }}>✕</button>
              )}
            </div>
          )}
          {busy !== null && <p className={css.status}>{busy}</p>}
          {error !== null && busy === null && <p className={css.error}>Could not improve the message: {error}</p>}
          {suggestion !== null && busy === null && error === null && <>
            {suggestion.note !== undefined && <p className={css.note}>{suggestion.note}</p>}
            <textarea className={css.text} value={suggestion.text}
              rows={Math.min(12, Math.max(3, suggestion.text.split('\n').length + 1))}
              onChange={(event) => { setSuggestion({ ...suggestion, text: event.target.value }) }} />
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
                          run({ ...document === null ? {} : { document }, answers: answered }, 'Updating with your answers…')
                        }
                      }} />
                  </label>
                ))}
              </div>
            )}
          </>}
          <div className={css.actions}>
            {busy === null && document === null && (
              <button type="button" className={css.secondary} onClick={pick}>Add file…</button>
            )}
            {busy === null && suggestion !== null && error === null && suggestion.questions.length > 0 && (
              <button type="button" className={css.secondary} disabled={answered.length === 0}
                onClick={() => { run({ ...document === null ? {} : { document }, answers: answered }, 'Updating with your answers…') }}>
                Update with answers
              </button>
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

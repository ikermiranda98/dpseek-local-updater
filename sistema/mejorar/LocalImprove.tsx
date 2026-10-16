/**
 * «Improve message» en la barra del cuadro de texto (añadido por dpseek-local-updater).
 *
 * Un botón más de la barra, junto al «+» y con su mismo aspecto: pide al modelo del
 * chat (en su misma variante de contexto, así Ollama no lo recarga) una versión más
 * clara del mensaje para la IA. La sugerencia sale en una tarjeta encima del cuadro,
 * editable: «Use» la pone en el cuadro (no la envía) y «Dismiss» deja lo tuyo.
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconSparkleMedium, Tooltip, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { improver, subscribeImprover } from './local-improve-bridge.ts'
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
  const [busy, setBusy] = useState(false)
  const [suggestion, setSuggestion] = useState<{ text: string; ms: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  // La tarjeta va encima de todo el cuadro de texto y con su ancho.
  const composer = useRef<HTMLElement | null>(null)
  composer.current = button.current?.closest<HTMLElement>('[data-composer-dock]')?.parentElement
    ?? button.current?.parentElement?.parentElement?.parentElement ?? null
  const open = suggestion !== null || error !== null
  const position = useAnchoredPosition({ open, anchorRef: composer, panelRef: card, side: 'top', align: 'start', gap: 8, margin: 12 })
  const width = composer.current?.getBoundingClientRect().width
  if (host === undefined || sessionId === undefined || subagent) return null
  const empty = draft.trim() === ''
  const run = (): void => {
    if (empty || busy) return
    setBusy(true)
    setError(null)
    host.improve(sessionId, draft).then(
      (value) => { setSuggestion(value) },
      (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) },
    ).finally(() => { setBusy(false) })
  }
  return (
    <>
      <Tooltip label={busy ? 'Improving message…' : 'Improve message'} side="top" delayMs={500}>
        <button ref={button} type="button" className={className} aria-label="Improve message" data-local-improve
          data-busy={busy || undefined} disabled={disabled || empty || busy}
          onMouseDown={(event) => { event.preventDefault() }} onClick={run}>
          <IconSparkleMedium size={14} className={busy ? css.busy : undefined} />
        </button>
      </Tooltip>
      {open && createPortal(
        <div ref={card} className={css.card} role="dialog" aria-label="Suggested message" data-local-improve-card
          style={{ ...position ?? { visibility: 'hidden', left: 0, top: 0 }, ...width === undefined ? {} : { width } }}>
          {error !== null
            ? <p className={css.error}>Could not improve the message: {error}</p>
            : suggestion !== null && <>
              <div className={css.head}>
                <span>Suggested message</span>
                <span className={css.meta}>{(suggestion.ms / 1000).toFixed(1)} s</span>
              </div>
              <textarea className={css.text} value={suggestion.text} rows={Math.min(8, Math.max(3, suggestion.text.split('\n').length + 1))}
                onChange={(event) => { setSuggestion({ ...suggestion, text: event.target.value }) }} />
            </>}
          <div className={css.actions}>
            {suggestion !== null && error === null && (
              <button type="button" className={css.use} onClick={() => { setDraft(suggestion.text); setSuggestion(null) }}>Use</button>
            )}
            <button type="button" className={css.dismiss} onClick={() => { setSuggestion(null); setError(null) }}>Dismiss</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

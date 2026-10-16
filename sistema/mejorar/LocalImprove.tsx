/**
 * «Improve» en el cuadro de texto (añadido por dpseek-local-updater).
 *
 * Con algo escrito, el botón pide al modelo elegido (selector al lado, recordado)
 * una versión más clara del mensaje para la IA. La sugerencia sale en una tarjeta
 * encima del cuadro, editable: «Use» la pone en el cuadro (no la envía) y «Dismiss»
 * deja lo tuyo. Si eliges el mismo modelo que el chat, avisa: Ollama pierde lo que
 * tenía preparado de la conversación y el siguiente mensaje tarda más en empezar.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Menu, Tooltip, useAnchoredPosition, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { improver, subscribeImprover, type LocalImproveModel } from './local-improve-bridge.ts'
import css from './LocalImprove.module.css'

const MODEL_KEY = 'dpseek-local-updater.improve.model'
const readModel = (): string | null => { try { return localStorage.getItem(MODEL_KEY) } catch { return null } }
const writeModel = (id: string): void => { try { localStorage.setItem(MODEL_KEY, id) } catch { /* solo esta vez */ } }

const baseOf = (id: string): string => id.replace(/:(?:(.+)-)?dsh-ctx-(?:auto|\d+)$/, (_, tag: string | undefined) => `:${tag ?? 'latest'}`)
const shortName = (id: string): string => id.replace(/:latest$/, '')
const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(bytes < 1e10 ? 1 : 0)} GB`

/**
 * El botón «Improve», su selector de modelo y la tarjeta con la sugerencia.
 * @param props - chat, borrador y cómo sustituirlo.
 * @returns el botón, o nada sin borrador o dentro de un subagente.
 */
export function LocalImprove({ sessionId, draft, subagent, setDraft }: {
  sessionId: string | undefined
  draft: string
  subagent: boolean
  setDraft: (text: string) => void
}): ReactNode {
  const host = useSyncExternalStore(subscribeImprover, improver)
  const [models, setModels] = useState<readonly LocalImproveModel[] | null>(null)
  const [chatModel, setChatModel] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(readModel)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [suggestion, setSuggestion] = useState<{ text: string; ms: number; model: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLSpanElement | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  // La tarjeta va encima de todo el cuadro de texto (no del botón, que está debajo) y con su ancho.
  const composer = useRef<HTMLElement | null>(null)
  composer.current = root.current?.closest<HTMLElement>('[data-composer-dock]')?.parentElement ?? root.current
  const open = suggestion !== null || error !== null
  const position = useAnchoredPosition({ open, anchorRef: composer, panelRef: card, side: 'top', align: 'start', gap: 8, margin: 12 })
  const width = composer.current?.getBoundingClientRect().width
  // La lista de modelos se pide la primera vez que hace falta y al abrir el selector.
  const load = (): void => {
    if (host === undefined || sessionId === undefined) return
    host.models(sessionId).then((value) => {
      setModels(value.models)
      setChatModel(value.chatModel)
      // Sin elección guardada (o si ya no existe), el más pequeño.
      setModel((current) => current !== null && value.models.some((entry) => entry.id === current) ? current : value.models[0]?.id ?? null)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }
  useEffect(() => { if (models === null && draft.trim() !== '') load() }, [host, sessionId, draft === ''])
  if (host === undefined || sessionId === undefined || subagent || (draft.trim() === '' && suggestion === null)) return null
  const sameAsChat = model !== null && chatModel !== null && baseOf(chatModel) === baseOf(model)
  const run = (): void => {
    if (model === null || draft.trim() === '') return
    setBusy(true)
    setError(null)
    host.improve(sessionId, draft, model).then(
      (value) => { setSuggestion({ ...value, model }) },
      (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) },
    ).finally(() => { setBusy(false) })
  }
  const items: MenuEntry[] = (models ?? []).map((entry) => ({
    id: entry.id,
    label: <span className={css.item}>
      <span>{shortName(entry.id)}</span>
      <span className={css.size}>{gigabytes(entry.sizeBytes)}{chatModel !== null && baseOf(chatModel) === baseOf(entry.id) ? ' · chat model' : ''}</span>
    </span>,
  }))
  const help = sameAsChat
    ? 'Rewrites your message so the AI understands it better. This is the chat model: Ollama drops what it had prepared for this conversation, so your next message takes longer to start. A small separate model avoids that.'
    : 'Rewrites your message so the AI understands it better. Nothing is sent until you do.'
  return (
    <span ref={root} className={css.root} data-local-improve>
      <Tooltip label={help} side="top">
        <button type="button" className={css.improve} data-warn={sameAsChat || undefined} disabled={busy || model === null}
          onMouseDown={(event) => { event.preventDefault() }} onClick={run}>
          <span aria-hidden="true">✨</span>
          <span>{busy ? 'Improving…' : 'Improve'}</span>
        </button>
      </Tooltip>
      <Menu open={picking} portal dense autoFocus onClose={() => { setPicking(false) }}
        anchor={(
          <button type="button" className={css.model} aria-haspopup="menu" aria-expanded={picking} title="Model that writes the suggestion"
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => { load(); setPicking((value) => !value) }}>
            {model === null ? 'Model' : shortName(model)} ▾
          </button>
        )}
        items={items.length === 0 ? [{ id: 'none', label: 'No Ollama models', disabled: true }] : items}
        selectedId={model ?? undefined}
        onSelect={(id) => { setModel(String(id)); writeModel(String(id)); setPicking(false) }} />
      {(suggestion !== null || error !== null) && createPortal(
        <div ref={card} className={css.card} role="dialog" aria-label="Suggested message" data-local-improve-card
          style={{ ...position ?? { visibility: 'hidden', left: 0, top: 0 }, ...width === undefined ? {} : { width } }}>
          {error !== null
            ? <p className={css.error}>Could not improve the message: {error}</p>
            : suggestion !== null && <>
              <div className={css.head}>
                <span>Suggested message</span>
                <span className={css.meta}>{shortName(suggestion.model)} · {(suggestion.ms / 1000).toFixed(1)} s</span>
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
    </span>
  )
}

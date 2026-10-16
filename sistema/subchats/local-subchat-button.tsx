/**
 * Subchats, lado del chat (añadido por dpseek-local-updater).
 *
 * - «Open in subchat» bajo cada respuesta del chat principal, y al seleccionar un
 *   trozo de una respuesta (con ese texto citado en la tarea): abre el cuadro para
 *   escribir la tarea, con tareas rápidas y la opción de revisar el resultado antes
 *   de que vuelva. El subchat empieza con toda la conversación (subagente «fork»
 *   oficial), trabaja con esfuerzo alto y su respuesta final vuelve al chat
 *   principal una vez (localStartSubchat en el Host).
 * - Dentro de un subchat, «Send to main chat» bajo cada respuesta: la manda al chat
 *   principal (para los que se revisan antes, y para las respuestas posteriores).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, IconPaperPlaneOutlineRegular, IconTreeCornerRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { deliverLocalSubchat, startLocalSubchat } from './local-subchat-start.ts'
import { setSubchatStarter, subchatOf } from './local-subchat-store.ts'
import css from './local-subchat-button.module.css'

let localCtx: Context | undefined

/** @param ctx - contexto de ui-chat, o nada al descargarse. */
export function setLocalSubchat(ctx: Context | undefined): void {
  localCtx = ctx
  setSubchatStarter(ctx === undefined ? undefined : (sessionId, task, options) => startLocalSubchat(ctx, sessionId, task, options))
}

const REVIEW_KEY = 'dpseek-local-updater.subchats.review'
const readReview = (): boolean => { try { return localStorage.getItem(REVIEW_KEY) === 'on' } catch { return false } }
const writeReview = (on: boolean): void => { try { localStorage.setItem(REVIEW_KEY, on ? 'on' : 'off') } catch { /* solo esta vez */ } }

/** Tareas rápidas del cuadro: rellenan la tarea con un clic. */
const QUICK_TASKS: readonly (readonly [string, string])[] = [
  ['Review the code', 'Review the code we have been working on, find bugs or improvements and give me the corrected code.'],
  ['Write tests', 'Write tests for the code we have been working on and tell me how to run them.'],
  ['Find the bug', 'Investigate the error we have been seeing, find its cause and give me the fix.'],
  ['Explain it', 'Explain in detail how this works, step by step.'],
  ['Summarize', 'Summarize this conversation: decisions taken, current state and next steps.'],
]

/** Si el chat es un subagente (también los subchats), según la lista de sesiones. */
function isSubagent(sessionId: string): boolean {
  const sessions = localCtx?.get('sessions') as
    { list: { getSnapshot(): { byId: Record<string, { origin?: string } | undefined> } } } | undefined
  return sessions?.list.getSnapshot().byId[sessionId]?.origin === 'subagent'
}

interface SubchatScope {
  readonly sessionId: string
  /** Abre el cuadro para lanzar un subchat, con una tarea inicial opcional. */
  readonly open: (initial?: string) => void
}

const SubchatContext = createContext<SubchatScope | undefined>(undefined)

/** @returns el chat de la vista y cómo abrir el cuadro, dentro de LocalSubchatSession. */
export function useLocalSubchatScope(): SubchatScope | undefined {
  return useContext(SubchatContext)
}

/** @returns el contexto de ui-chat, para abrir un subchat a la derecha. */
export function localSubchatContext(): Context | undefined {
  return localCtx
}

/** Cita un texto seleccionado para la tarea. */
function quote(text: string): string {
  const clipped = text.length > 1500 ? `${text.slice(0, 1500)}…` : text
  return `${clipped.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`
}

/**
 * Da el chat a los botones de dentro y aloja el cuadro de la tarea y el botón del texto seleccionado.
 * @param props - chat y contenido.
 * @returns el contenido.
 */
export function LocalSubchatSession({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [initial, setInitial] = useState<string | null>(null)
  const open = useCallback((text?: string) => { setInitial(text ?? '') }, [])
  const scope = useMemo(() => ({ sessionId, open }), [sessionId, open])
  const main = !isSubagent(sessionId)
  return (
    <SubchatContext.Provider value={scope}>
      <div data-local-subchat-scope={sessionId} style={{ display: 'contents' }}>{children}</div>
      {main && <SelectionButton sessionId={sessionId} onOpen={(text) => { open(quote(text)) }} />}
      {initial !== null && <SubchatDialog sessionId={sessionId} initial={initial} onClose={() => { setInitial(null) }} />}
    </SubchatContext.Provider>
  )
}

/** «Open in subchat» junto a un texto seleccionado de la conversación. */
function SelectionButton({ sessionId, onOpen }: { sessionId: string; onOpen: (text: string) => void }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const check = (): void => {
      const selection = window.getSelection()
      const text = selection?.toString().trim() ?? ''
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed || text.length < 3) { setAt(null); return }
      const range = selection.getRangeAt(0)
      const node = range.commonAncestorContainer
      const element = node instanceof Element ? node : node.parentElement
      // Solo lo seleccionado en esta conversación, no en el cuadro de texto ni en otros paneles.
      if (element === null || element.closest('[data-local-subchat-scope]')?.getAttribute('data-local-subchat-scope') !== sessionId
        || element.closest('textarea, input, [contenteditable="true"]') !== null) { setAt(null); return }
      const rect = range.getBoundingClientRect()
      // Debajo de lo seleccionado, sin salirse de la ventana.
      setAt({
        x: Math.max(8, Math.min(rect.right, window.innerWidth - 150)),
        y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 40)),
        text,
      })
    }
    const up = (event: Event): void => {
      if (button.current !== null && event.target instanceof Node && button.current.contains(event.target)) return
      setTimeout(check, 0)
    }
    const hide = (): void => { setAt(null) }
    document.addEventListener('mouseup', up)
    document.addEventListener('keyup', up)
    document.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('mouseup', up)
      document.removeEventListener('keyup', up)
      document.removeEventListener('scroll', hide, true)
    }
  }, [sessionId])
  if (at === null) return null
  return (
    <button ref={button} type="button" className={css.selection} style={{ left: at.x, top: at.y }} data-local-subchat-selection
      onMouseDown={(event) => { event.preventDefault() }}
      onClick={() => { onOpen(at.text); setAt(null) }}>
      <IconTreeCornerRegular />
      <span>Open in subchat</span>
    </button>
  )
}

/** El cuadro para escribir la tarea del subchat. */
function SubchatDialog({ sessionId, initial, onClose }: { sessionId: string; initial: string; onClose: () => void }) {
  const [task, setTask] = useState(initial)
  const [review, setReview] = useState(readReview)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const element = area.current
    if (element !== null) { element.focus(); element.setSelectionRange(element.value.length, element.value.length) }
  }, [])
  const start = async (): Promise<void> => {
    const ctx = localCtx
    if (ctx === undefined || task.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await startLocalSubchat(ctx, sessionId, task, { review })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      closeLabel="Close"
      title="Open in subchat"
      description="The subchat remembers this whole conversation, works on its own with high effort (and subagents if it needs them) and sends only its final answer back here. It does not fill this chat's context."
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || task.trim() === ''} onClick={() => { void start() }}>
            {busy ? 'Starting…' : 'Start subchat'}
          </Button>
        </>
      )}
    >
      <div className={css.quick}>
        {QUICK_TASKS.map(([label, text]) => (
          <button key={label} type="button" className={css.chip} disabled={busy}
            onClick={() => { setTask((current) => current.trim() === '' ? text : `${current.trimEnd()}\n${text}`); area.current?.focus() }}>
            {label}
          </button>
        ))}
      </div>
      <textarea ref={area} className={css.task} value={task} rows={5} disabled={busy}
        placeholder="What should the subchat do? E.g. Review calc.py, find the bugs and give me the fixed code."
        onChange={(event) => { setTask(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void start() }
        }} />
      <label className={css.review}>
        <input type="checkbox" checked={review} disabled={busy}
          onChange={(event) => { setReview(event.target.checked); writeReview(event.target.checked) }} />
        Let me review the result before it goes back to this chat
      </label>
      {error !== null && <p className={css.error}>{error}</p>}
      <p className={css.hint}>Ctrl+Enter to start</p>
    </Modal>
  )
}

/**
 * Bajo cada respuesta: «Open in subchat» en el chat principal y «Send to main chat»
 * dentro de un subchat de la app (en otros subagentes, nada).
 * @param props - texto de la respuesta.
 * @returns el botón.
 */
export function LocalSubchatButton({ replyText }: { replyText?: string }): ReactNode {
  const scope = useContext(SubchatContext)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')
  if (scope === undefined || localCtx === undefined) return null
  if (subchatOf(scope.sessionId) !== undefined) {
    const label = { idle: 'Send to main chat', sending: 'Sending…', sent: 'Sent to main chat', error: message }[state]
    return (
      <Tooltip label={label} side="bottom">
        <button type="button" className={css.action} aria-label={label} data-local-subchat-send data-state={state}
          disabled={state === 'sending'}
          onClick={() => {
            const ctx = localCtx
            if (ctx === undefined) return
            setState('sending')
            deliverLocalSubchat(ctx, scope.sessionId, replyText).then(
              () => { setState('sent') },
              (reason: unknown) => { setMessage(reason instanceof Error ? reason.message : String(reason)); setState('error') },
            )
          }}>
          <IconPaperPlaneOutlineRegular />
        </button>
      </Tooltip>
    )
  }
  // Dentro de otros subagentes no se abre un subchat: el servicio solo los lanza desde un chat principal.
  if (isSubagent(scope.sessionId)) return null
  return (
    <Tooltip label="Open in subchat" side="bottom">
      <button type="button" className={css.action} aria-label="Open in subchat" data-local-subchat
        onClick={() => { scope.open() }}>
        <IconTreeCornerRegular />
      </button>
    </Tooltip>
  )
}

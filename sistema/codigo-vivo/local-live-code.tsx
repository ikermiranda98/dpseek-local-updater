/**
 * Código en vivo, lado del panel derecho (añadido por dpseek-local-updater).
 *
 * - Pestaña «Live code»: lo que el modelo escribe en el turno actual, en tiempo
 *   real (si el proveedor lo envía por trozos; Ollama lo da entero al terminar),
 *   con una pestaña por fichero. Se abre con «View code» en la línea de estado
 *   del turno en el chat (local-live-watch.tsx), nunca sola.
 * - Botón «Undo» en la revisión de cambios del turno: deja ese fichero como
 *   estaba al empezar el turno (localUndoTurnFile en el Host).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { IconCodeOutlineRegular, languageForPath, useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceChangedFile } from '@deepseek-ai/dsh-workspace-changes/types'
import { changesReviewAddress } from '../changes.ts'
import { liveSnapshot, onLiveOpen, subscribeLive, type LiveEdit, type LiveFile } from './local-live-store.ts'
import css from './local-live-code.module.css'

/** Tipo de pestaña y su identidad en el sistema de pestañas. */
export const LIVE_KIND = 'local-live-code'
const LIVE_ID = 'dpseek-local-updater/live-code'
/** Más allá de esto se dibuja sin colores: resaltar en cada pulsación saldría caro. */
const HIGHLIGHT_LIMIT = 120_000

let localCtx: Context | undefined

/**
 * Registra la pestaña, su cuerpo y su apertura desde el chat.
 * @param ctx - contexto del plugin de entregables.
 */
export function setLocalLive(ctx: Context): void {
  localCtx = ctx
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: LIVE_ID,
    kind: LIVE_KIND,
    title: () => 'Live code',
    guide: [{
      id: 'live-code', order: 15, icon: IconCodeOutlineRegular,
      title: () => 'Live code',
      description: () => 'What the agent is writing, as it writes',
    }],
  }), 'local: live code type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: LIVE_ID },
    LiveCodeTab,
  )), 'local: live code body')
  ctx.effect(() => onLiveOpen((sessionId) => {
    const right = ctx.sidebarRight as typeof ctx.sidebarRight & {
      openTabIn?: (sessionId: SessionId, kind: string) => void
    }
    try {
      if (right.openTabIn) right.openTabIn(sessionId as SessionId, LIVE_KIND)
      else right.openTab(LIVE_KIND)
    } catch (error) {
      console.warn('local live code:', error)
    }
  }), 'local: live code open')
}

/** El fichero que conviene ver: el que se está escribiendo o, si no, el último. */
function currentPath(files: readonly LiveFile[]): string | undefined {
  const active = files.findLast((file) => file.edits.some((edit) => edit.status === 'writing' || edit.status === 'running'))
  return (active ?? files.at(-1))?.path
}

const fileStatus = (file: LiveFile): LiveEdit['status'] => file.edits.at(-1)?.status ?? 'done'
const basename = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

/** Ediciones que se ven: desde la última escritura completa del fichero. */
function visibleEdits(file: LiveFile): readonly LiveEdit[] {
  const lastWrite = file.edits.findLastIndex((edit) => edit.kind === 'write')
  return lastWrite < 0 ? file.edits : file.edits.slice(lastWrite)
}

function spans(highlight: CodeHighlighter, text: string): readonly (readonly HighlightSpan[])[] | undefined {
  return text.length > HIGHLIGHT_LIMIT ? undefined : highlight(text)
}

/** Líneas con número, resaltadas si se puede; `tone` las marca como añadidas o quitadas. */
function Lines({ text, highlight, tone, caret }: {
  text: string; highlight: CodeHighlighter; tone?: 'add' | 'del'; caret: boolean
}): ReactNode {
  const colored = useMemo(() => spans(highlight, text), [highlight, text])
  const lines = text === '' ? [''] : text.replace(/\r/g, '').split('\n')
  const sign = tone === 'add' ? '+' : tone === 'del' ? '−' : undefined
  return lines.map((line, at) => (
    <div key={at} className={`${css.line} ${tone === undefined ? '' : css[tone]}`}>
      <span className={css.number}>{sign ?? at + 1}</span>
      <span className={css.text}>
        {colored?.[at]?.map((span, i) => <span key={i} style={span.style}>{span.text}</span>) ?? line}
        {caret && at === lines.length - 1 && <span className={css.caret} />}
      </span>
    </div>
  ))
}

/** Una escritura o edición del fichero. */
function EditBlock({ edit, index, count, highlight }: {
  edit: LiveEdit; index: number; count: number; highlight: CodeHighlighter
}): ReactNode {
  const live = edit.status === 'writing'
  const title = edit.kind === 'write'
    ? live ? 'Writing the whole file…' : edit.status === 'failed' ? 'Write failed' : 'Whole file written'
    : `${live ? 'Editing' : edit.status === 'failed' ? 'Edit failed' : 'Edit'}${count > 1 ? ` ${String(index + 1)} of ${String(count)}` : ''}`
  return (
    <div className={css.block} data-live-edit={edit.callId}>
      <div className={css.blockTitle}>{title}</div>
      {edit.kind === 'write'
        ? <Lines text={edit.text} highlight={highlight} caret={live} />
        : <>
          {edit.oldText !== undefined && edit.oldText !== '' && <Lines text={edit.oldText} highlight={highlight} tone="del" caret={false} />}
          <Lines text={edit.text} highlight={highlight} tone="add" caret={live} />
        </>}
    </div>
  )
}

/**
 * Cuerpo de la pestaña «Live code».
 * @param props - pestaña y chat en el que está.
 * @returns el código del turno actual.
 */
function LiveCodeTab({ sessionId, useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const { tab } = useTabInfo()
  const live = useSyncExternalStore(subscribeLive, () => liveSnapshot(sessionId))
  const files = live?.files ?? []
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  // Una pestaña elegida a mano deja de seguir al modelo hasta que pulses «Follow» o empiece otro turno.
  const turn = live?.turn
  useEffect(() => { setChosen(undefined) }, [turn])
  const following = chosen === undefined || !files.some((file) => file.path === chosen)
  const path = following ? currentPath(files) : chosen
  const file = files.find((entry) => entry.path === path)
  const highlight = useCodeHighlighter(path === undefined ? undefined : languageForPath(path))
  const body = useRef<HTMLDivElement>(null)
  const edits = file === undefined ? [] : visibleEdits(file)
  const writing = edits.some((edit) => edit.status === 'writing')
  const size = edits.reduce((total, edit) => total + edit.text.length, 0)
  // Siguiendo al modelo, la vista baja con lo que escribe, como un editor.
  useLayoutEffect(() => {
    const element = body.current
    if (element !== null && following && writing) element.scrollTop = element.scrollHeight
  }, [following, writing, size, path])
  const review = live !== undefined && !live.running && live.changesSeq !== undefined
  return (
    <div className={css.root} data-live-code data-live-running={live?.running === true}>
      <div className={css.header}>
        <div className={css.chips} role="tablist" aria-label="Files written in this turn">
          {files.map((entry) => (
            <button key={entry.path} type="button" role="tab" className={css.chip} aria-selected={entry.path === path}
              title={entry.path} onClick={() => { setChosen(entry.path) }}>
              <span className={css.dot} data-status={fileStatus(entry)} />
              <span className={css.chipName}>{basename(entry.path)}</span>
            </button>
          ))}
        </div>
        <button type="button" className={css.tool} aria-pressed={following} disabled={files.length === 0}
          title="Show the file the agent is writing" onClick={() => { setChosen(undefined) }}>Follow</button>
      </div>
      {file !== undefined && <div className={css.path} title={file.path}>{file.path}</div>}
      <div ref={body} className={css.body}>
        {file === undefined
          ? <p className={css.empty}>
            {live?.running === true
              ? 'Nothing written yet in this turn. When the agent writes or edits a file, it shows up here.'
              : 'When the agent writes or edits a file, it shows up here, one tab per file.'}
          </p>
          : edits.map((edit, index) => (
            <EditBlock key={edit.callId} edit={edit} index={index} count={edits.length} highlight={highlight} />
          ))}
      </div>
      <div className={css.footer}>
        <span>{live === undefined ? '' : `Turn ${String(live.turn)}${live.running ? ' · running' : ''}`}</span>
        {review && <button type="button" className={css.tool} onClick={() => {
          tab.actions.openResource(changesReviewAddress({ sessionId, seq: live.changesSeq ?? 0, turn: live.turn }))
        }}>Review changes and undo</button>}
      </div>
    </div>
  )
}

/** Ficheros ya restaurados en esta sesión de la app. */
const undone = new Set<string>()

/**
 * «Undo» de un fichero en la revisión de cambios: lo deja como estaba al empezar
 * el turno. Pide confirmación con un segundo clic.
 * @param props - fichero de la revisión.
 * @returns el botón.
 */
export function LocalUndoButton({ sessionId, seq, index, file }: {
  sessionId: string; seq: number; index: number; file: WorkspaceChangedFile
}): ReactNode {
  const key = `${sessionId}:${String(seq)}:${String(index)}`
  const [state, setState] = useState<'idle' | 'confirm' | 'working' | 'done' | 'error'>(undone.has(key) ? 'done' : 'idle')
  const [message, setMessage] = useState('')
  useEffect(() => { setState(undone.has(key) ? 'done' : 'idle'); setMessage('') }, [key])
  useEffect(() => {
    if (state !== 'confirm') return
    const timer = setTimeout(() => { setState('idle') }, 4000)
    return () => { clearTimeout(timer) }
  }, [state])
  if (file.binary === true || file.oversized === true) return null
  const run = async (): Promise<void> => {
    const ctx = localCtx
    if (ctx === undefined) return
    setState('working')
    const result = await ctx.remote.session.localUndoTurnFile({ sessionId: sessionId as SessionId, seq, index })
    if (result.ok) {
      undone.add(key)
      setState('done')
    } else {
      setMessage(result.error.message)
      setState('error')
    }
  }
  const label = { idle: 'Undo', confirm: 'Undo this file?', working: 'Undoing…', done: 'Undone', error: 'Undo failed' }[state]
  const title = state === 'error' ? message
    : state === 'done' ? 'This file is back as it was before this turn'
      : 'Put this file back as it was before this turn'
  return (
    <button type="button" className={css.undo} data-state={state} title={title}
      disabled={state === 'working' || state === 'done'}
      onClick={() => {
        if (state === 'confirm') void run()
        else setState('confirm')
      }}>{label}</button>
  )
}

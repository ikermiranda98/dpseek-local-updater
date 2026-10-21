/**
 * Código en vivo, lado del panel derecho (añadido por dpseek-local-updater).
 *
 * - Pestaña «Live code»: lo que el modelo escribe en el turno actual, en tiempo
 *   real (si el proveedor lo envía por trozos; Ollama lo da entero al terminar),
 *   con una pestaña por fichero, y lo que escribió en los turnos anteriores (se
 *   elige el turno abajo). Se abre con «View code» en la línea de estado del turno
 *   en el chat (local-live-watch.tsx), nunca sola.
 * - Botón «Undo» en la revisión de cambios del turno: deja ese fichero como
 *   estaba al empezar el turno (localUndoTurnFile en el Host).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { IconCodeOutlineRegular, languageForPath, Tooltip, useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceChangedFile } from '@deepseek-ai/dsh-workspace-changes/types'
import { changesReviewAddress } from '../changes.ts'
import {
  liveChoice, liveSnapshot, onLiveOpen, sessionTurns, subscribeLive, turnSnapshot, type LiveEdit, type LiveFile,
} from './local-live-store.ts'
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
  // El título de la pestaña lleva su icono, como las demás («Files», la terminal).
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: LIVE_ID },
    LiveCodeTitle,
  )), 'local: live code title')
  ctx.effect(() => onLiveOpen((sessionId) => {
    const right = ctx.sidebarRight as typeof ctx.sidebarRight & {
      openTabIn?: (sessionId: SessionId, kind: string) => void
    }
    try {
      right.openTabIn(sessionId as SessionId, LIVE_KIND)
    } catch (error) {
      console.warn('local live code:', error)
    }
  }), 'local: live code open')
}

/** El icono de código y «Live code» en la pestaña. */
function LiveCodeTitle(): ReactNode {
  return <><IconCodeOutlineRegular className={css.titleIcon} />Live code</>
}

/** El fichero que conviene ver: el que se está escribiendo o, si no, el último. */
function currentPath(files: readonly LiveFile[]): string | undefined {
  const active = files.findLast(file => file.edits.some(edit => edit.status === 'writing' || edit.status === 'running'))
  return (active ?? files.at(-1))?.path
}

const fileStatus = (file: LiveFile): LiveEdit['status'] => file.edits.at(-1)?.status ?? 'done'
const basename = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

/** Ediciones que se ven: desde la última escritura completa del fichero. */
function visibleEdits(file: LiveFile): readonly LiveEdit[] {
  const lastWrite = file.edits.findLastIndex(edit => edit.kind === 'write')
  return lastWrite < 0 ? file.edits : file.edits.slice(lastWrite)
}

function spans(highlight: CodeHighlighter, text: string): readonly (readonly HighlightSpan[])[] | undefined {
  return text.length > HIGHLIGHT_LIMIT ? undefined : highlight(text)
}

/** Líneas con número, resaltadas si se puede; `tone` las marca como añadidas o quitadas. */
function Lines({ text, highlight, tone, caret }: {
  text: string
  highlight: CodeHighlighter
  tone?: 'add' | 'del'
  caret: boolean
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
  edit: LiveEdit
  index: number
  count: number
  highlight: CodeHighlighter
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
  const current = useSyncExternalStore(subscribeLive, () => liveSnapshot(sessionId))
  // Un turno anterior elegido abajo o desde su línea en el chat; sin él, el actual.
  const [viewTurn, setViewTurn] = useState<number | undefined>(undefined)
  const older = useSyncExternalStore(subscribeLive, () => viewTurn === undefined ? undefined : turnSnapshot(sessionId, viewTurn))
  const live = older ?? current
  const turns = useSyncExternalStore(subscribeLive, () => sessionTurns(sessionId))
  const written = turns.filter(entry => entry.files.length > 0)
  const files = live?.files ?? []
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  // Una pestaña elegida a mano deja de seguir al modelo hasta que pulses «Follow» o empiece otro turno (que se enseña).
  const turn = current?.turn
  useEffect(() => { setChosen(undefined); setViewTurn(undefined) }, [turn])
  // Un fichero pulsado en la lista de la flecha, en el chat: se enseña ese, en su turno.
  const choice = useSyncExternalStore(subscribeLive, () => liveChoice(sessionId))
  useEffect(() => {
    if (choice === undefined) return
    setViewTurn(choice.turn === undefined || choice.turn === turn ? undefined : choice.turn)
    setChosen(choice.path)
  }, [choice?.at])
  const following = chosen === undefined || !files.some(file => file.path === chosen)
  const path = following ? currentPath(files) : chosen
  const file = files.find(entry => entry.path === path)
  const highlight = useCodeHighlighter(path === undefined ? undefined : languageForPath(path))
  const body = useRef<HTMLDivElement>(null)
  const edits = file === undefined ? [] : visibleEdits(file)
  const writing = edits.some(edit => edit.status === 'writing')
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
          {files.map(entry => (
            <Tooltip key={entry.path} label={entry.path} side="bottom" delayMs={500}>
              <button type="button" role="tab" className={css.chip} aria-selected={entry.path === path}
                onClick={() => { setChosen(entry.path) }}>
                <span className={css.dot} data-status={fileStatus(entry)} />
                <span className={css.chipName}>{basename(entry.path)}</span>
              </button>
            </Tooltip>
          ))}
        </div>
        <Tooltip label="Show the file the agent is writing" side="bottom" align="end" delayMs={500}>
          <button type="button" className={css.tool} aria-pressed={following && older === undefined} disabled={current === undefined || current.files.length === 0}
            onClick={() => { setChosen(undefined); setViewTurn(undefined) }}>Follow</button>
        </Tooltip>
      </div>
      {file !== undefined && <Tooltip label={file.path} side="bottom" delayMs={500}><div className={css.path}>{file.path}</div></Tooltip>}
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
        {written.length > 1 && live !== undefined
          ? (
            <select className={css.turnSelect} aria-label="Turn" value={String(live.turn)} data-live-turn
              onChange={(event) => {
                const picked = Number(event.target.value)
                setChosen(undefined)
                setViewTurn(picked === turn ? undefined : picked)
              }}>
              {!written.some(entry => entry.turn === live.turn) && <option value={String(live.turn)}>{`Turn ${String(live.turn)}`}</option>}
              {written.map(entry => (
                <option key={entry.turn} value={String(entry.turn)}>
                  {`Turn ${String(entry.turn)}${entry.running ? ' · running' : ''} · ${String(entry.files.length)} ${entry.files.length === 1 ? 'file' : 'files'}`}
                </option>
              ))}
            </select>
          )
          : <span>{live === undefined ? '' : `Turn ${String(live.turn)}${live.running ? ' · running' : ''}`}</span>}
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
  sessionId: string
  seq: number
  index: number
  file: WorkspaceChangedFile
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
    <Tooltip label={title} side="top" delayMs={500}>
      <button type="button" className={css.undo} data-state={state}
        disabled={state === 'working' || state === 'done'}
        onClick={() => {
          if (state === 'confirm') void run()
          else setState('confirm')
        }}>{label}</button>
    </Tooltip>
  )
}

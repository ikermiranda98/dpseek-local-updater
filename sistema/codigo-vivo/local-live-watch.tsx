/**
 * Código en vivo, lado del chat (añadido por dpseek-local-updater).
 *
 * Mira las llamadas a write/edit/str_replace_editor del último turno del chat y
 * publica lo que van escribiendo (local-live-store.ts). Los argumentos crecen en
 * su sitio mientras llegan, sin avisar, así que mientras el turno está en marcha
 * se leen unas siete veces por segundo.
 *
 * El panel no se abre solo: la línea de estado del turno («Deep diving…» y
 * «Completed in…») lleva el botón «View code» cuando el turno escribe ficheros.
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { LinkIconMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from '../contract/snapshot.ts'
import type { UseChat } from '../contract/slots.ts'
import {
  liveSnapshot, publishLive, requestBrowserOpen, requestLiveOpen, subscribeLive,
  type LiveBrowserStep, type LiveEdit, type LiveFile,
} from './local-live-store.ts'
import css from './local-live-watch.module.css'

const TICK_MS = 150

interface ReadCall {
  readonly path: string
  readonly edit: LiveEdit
}

/** Una llamada que escribe un fichero, con lo que lleva escrito; nada si no es de ese tipo o aún no tiene ruta. */
function readCall(block: ToolCallBlock): ReadCall | undefined {
  const args = block.args
  const status: LiveEdit['status'] = 'kind' in block
    ? block.isError ? 'failed' : 'done'
    : block.phase === 'preparing' ? 'writing' : 'running'
  const pathOf = (key: string): string | undefined => args.complete(key) ? args.text(key) : undefined
  const base = { callId: block.callId, status }
  switch (block.name) {
    case 'write': {
      const path = pathOf('file_path')
      return path === undefined ? undefined : { path, edit: { ...base, kind: 'write', text: args.text('content') ?? '' } }
    }
    case 'edit': {
      const path = pathOf('file_path')
      return path === undefined ? undefined
        : { path, edit: { ...base, kind: 'edit', oldText: args.text('old_string') ?? '', text: args.text('new_string') ?? '' } }
    }
    case 'str_replace_editor': {
      const path = pathOf('path')
      const command = args.complete('command') ? args.text('command') : undefined
      if (path === undefined) return undefined
      if (command === 'create') return { path, edit: { ...base, kind: 'write', text: args.text('file_text') ?? '' } }
      if (command === 'str_replace') {
        return { path, edit: { ...base, kind: 'edit', oldText: args.text('old_str') ?? '', text: args.text('new_str') ?? '' } }
      }
      if (command === 'insert') return { path, edit: { ...base, kind: 'edit', oldText: '', text: args.text('new_str') ?? '' } }
      return undefined
    }
    default:
      return undefined
  }
}

/** Ficheros del turno en el orden en que se empezaron a escribir. */
function filesOf(blocks: readonly ToolCallBlock[]): LiveFile[] {
  const files = new Map<string, LiveEdit[]>()
  for (const block of blocks) {
    const call = readCall(block)
    if (call === undefined) continue
    const edits = files.get(call.path) ?? []
    edits.push(call.edit)
    files.set(call.path, edits)
  }
  return [...files].map(([path, edits]) => ({ path, edits }))
}

/** Herramientas del navegador del agente (servidor Playwright MCP). */
const BROWSER_PREFIX = 'mcp__playwright-mcp__browser_'

/** Pasos del turno con el navegador: qué herramienta y sobre qué, sin lo que escribe en los campos. */
function browserSteps(blocks: readonly ToolCallBlock[]): LiveBrowserStep[] {
  const steps: LiveBrowserStep[] = []
  for (const block of blocks) {
    if (!block.name.startsWith(BROWSER_PREFIX)) continue
    const args = block.args
    const text = (key: string): string | undefined => args.complete(key) ? args.text(key) : undefined
    const action = block.name.slice(BROWSER_PREFIX.length)
    const status: LiveBrowserStep['status'] = 'kind' in block ? block.isError ? 'failed' : 'done' : 'running'
    // `text` solo se lee en find y wait_for (lo que busca o espera); en type es lo que escribe y no se enseña.
    const detail = action === 'navigate' ? text('url')
      : action === 'find' ? text('text') ?? text('regex')
        : action === 'wait_for' ? text('text') ?? text('textGone')
          : action === 'press_key' ? text('key')
            : action === 'tabs' ? text('action')
              : text('element')
    steps.push({ callId: block.callId, action, detail: (detail ?? '').slice(0, 120), status })
  }
  return steps
}

/** Firma barata para no republicar si nada ha cambiado. */
function signature(running: boolean, files: readonly LiveFile[], changesSeq: number | undefined,
  browser: readonly LiveBrowserStep[] = []): string {
  return `${String(running)}|${String(changesSeq)}|${files.map((file) =>
    `${file.path}:${file.edits.map((edit) => `${edit.callId}${edit.status}${String(edit.text.length)}`).join(',')}`).join(';')}|${
    browser.map((step) => `${step.callId}${step.status}${step.detail}`).join(',')}`
}

/**
 * Publica lo que se está escribiendo en el chat abierto.
 * @param props - chat y lector de su estado.
 * @returns nada visible.
 */
export function LocalLiveWatcher({ sessionId, useChat }: { sessionId: string; useChat: UseChat }) {
  const turn = useChat((s) => s.timeline.turnOrder.at(-1))
  const running = useChat((s) => turn !== undefined && s.timeline.turns.get(turn)?.status === 'open')
  const source = useChat((s) => turn === undefined ? undefined : s.nodes.turnDataSource(turn, 'tool-call'))
  // La ubicación del turno cambia con cada paso; se lee al vuelo sin reiniciar la lectura.
  const location = useRef<{ get(key: string): unknown } | undefined>(undefined)
  location.current = useChat((s) => turn === undefined ? undefined
    : s.timeline.turns.get(turn)?.data as unknown as { get(key: string): unknown } | undefined)
  useEffect(() => {
    if (turn === undefined || source === undefined) return
    let last = ''
    const read = (): void => {
      const blocks = source.getSnapshot().map((data) => data.root)
      const files = filesOf(blocks)
      const browser = browserSteps(blocks)
      const data = location.current
      const changes = (data?.get('deliverables') as { changes?: { seq: number } } | undefined)?.changes
      const now = signature(running, files, changes?.seq, browser)
      if (now === last) return
      last = now
      publishLive({
        sessionId, turn, running, files,
        ...changes === undefined ? {} : { changesSeq: changes.seq },
        ...browser.length === 0 ? {} : { browser },
      })
    }
    read()
    const unsubscribe = source.subscribe(read)
    // Terminado el turno, el resumen de cambios llega un poco después: se busca unos segundos.
    let checks = 0
    const timer = setInterval(() => {
      if (!running && (++checks > 20 || liveSnapshot(sessionId)?.changesSeq !== undefined)) {
        clearInterval(timer)
        return
      }
      read()
    }, running ? TICK_MS : 1000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [sessionId, turn, running, source])
  return null
}

/** El chat de la vista, para los botones de las líneas de estado del turno. */
const LiveSession = createContext<string | undefined>(undefined)

/**
 * Da el chat a los botones «View code» de dentro.
 * @param props - chat y contenido.
 * @returns el contenido.
 */
export function LocalLiveSession({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  return <LiveSession.Provider value={sessionId}>{children}</LiveSession.Provider>
}

/**
 * «View code» en la línea de estado del turno: abre la pestaña «Live code».
 * @param props - turno de la línea (sin él, el que está en marcha) y dónde va.
 * @returns el botón, o nada si ese turno no ha escrito ficheros.
 */
export function LocalLiveCodeButton({ turn, placement }: { turn?: number; placement: 'running' | 'process' }) {
  const sessionId = useContext(LiveSession)
  const live = useSyncExternalStore(subscribeLive, () => sessionId === undefined ? undefined : liveSnapshot(sessionId))
  if (sessionId === undefined || live === undefined || live.files.length === 0) return null
  if (turn === undefined ? !live.running : live.turn !== turn) return null
  const writing = live.files.some((file) => file.edits.some((edit) => edit.status === 'writing'))
  const count = live.files.length
  return (
    <Tooltip label="Open the code in the right panel" side="top" delayMs={500}>
      <button type="button" className={css.button} data-placement={placement} data-live-code-button
        onClick={(event) => {
          // Dentro de la línea «Completed in…», que pliega el turno: el clic es solo nuestro.
          event.stopPropagation()
          requestLiveOpen(sessionId)
        }}>
        <LinkIconMedium kind="code" className={css.icon} />
        <span>{writing ? 'Writing code' : 'View code'}</span>
        <span className={css.count}>{count === 1 ? '1 file' : `${String(count)} files`}</span>
      </button>
    </Tooltip>
  )
}

/**
 * «View browser» en la línea de estado del turno: abre la pestaña «Agent browser» con lo que hace el agente.
 * @param props - turno de la línea (sin él, el que está en marcha) y dónde va.
 * @returns el botón, o nada si ese turno no ha usado el navegador.
 */
export function LocalBrowserButton({ turn, placement }: { turn?: number; placement: 'running' | 'process' }) {
  const sessionId = useContext(LiveSession)
  const live = useSyncExternalStore(subscribeLive, () => sessionId === undefined ? undefined : liveSnapshot(sessionId))
  const steps = live?.browser ?? []
  if (sessionId === undefined || live === undefined || steps.length === 0) return null
  if (turn === undefined ? !live.running : live.turn !== turn) return null
  const busy = live.running && steps.at(-1)?.status === 'running'
  return (
    <Tooltip label="See what the agent is doing in the browser" side="top" delayMs={500}>
      <button type="button" className={css.button} data-placement={placement} data-browser-button
        onClick={(event) => {
          event.stopPropagation()
          requestBrowserOpen(sessionId)
        }}>
        <LinkIconMedium kind="url" className={css.icon} />
        <span>{busy ? 'Browsing' : 'View browser'}</span>
        <span className={css.count}>{steps.length === 1 ? '1 step' : `${String(steps.length)} steps`}</span>
      </button>
    </Tooltip>
  )
}

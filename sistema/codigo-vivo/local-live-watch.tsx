/**
 * Código en vivo, lado del chat (añadido por dpseek-local-updater).
 *
 * Mira las llamadas a write/edit/str_replace_editor del último turno del chat y
 * publica lo que van escribiendo (local-live-store.ts). Los argumentos crecen en
 * su sitio mientras llegan, sin avisar, así que mientras el turno está en marcha
 * se leen unas siete veces por segundo.
 *
 * El panel no se abre solo: la línea de estado del turno («Deep diving…» y
 * «Completed in…») lleva el botón «View code» cuando el turno escribe ficheros, y el globo del navegador (con su
 * paso a paso en una lista desplegable) cuando usa el navegador.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconGlobeOutlineRegular, LinkIconMedium, MenuSurface, Tooltip, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from '../contract/snapshot.ts'
import type { UseChat } from '../contract/slots.ts'
import {
  browserStepText, liveSnapshot, publishLive, requestBrowserOpen, requestLiveOpen, subscribeLive,
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
 * El navegador en la línea de estado del turno: el globo abre la pestaña «Browser» y la flecha de al lado despliega el
 * paso a paso del agente. La lista mide el hueco que tiene (hasta la barra de escribir por abajo y hasta la cabecera por
 * arriba), se abre hacia donde cabe y ajusta su altura; si no cabe entera, se desplaza por dentro.
 * @param props - turno de la línea (sin él, el que está en marcha) y dónde va.
 * @returns los dos botones, o nada si ese turno no ha usado el navegador.
 */
export function LocalBrowserButton({ turn, placement }: { turn?: number; placement: 'running' | 'process' }) {
  const sessionId = useContext(LiveSession)
  const live = useSyncExternalStore(subscribeLive, () => sessionId === undefined ? undefined : liveSnapshot(sessionId))
  const [open, setOpen] = useState(false)
  const group = useRef<HTMLSpanElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const list = useRef<HTMLOListElement | null>(null)
  const [place, setPlace] = useState<StepsPlacement | null>(null)
  const steps = live?.browser ?? []
  useDismissOnOutsidePointer(group, open, setOpen, panel)
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null)
      return
    }
    const measure = (): void => {
      if (group.current !== null && panel.current !== null) setPlace(placeSteps(group.current, panel.current))
    }
    measure()
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, steps.length])
  // El último paso, siempre a la vista.
  useLayoutEffect(() => {
    if (list.current !== null) list.current.scrollTop = list.current.scrollHeight
  }, [open, steps.length, place?.maxHeight])
  if (sessionId === undefined || live === undefined || steps.length === 0) return null
  if (turn === undefined ? !live.running : live.turn !== turn) return null
  const busy = live.running && steps.at(-1)?.status === 'running'
  return (
    <span ref={group} className={css.browserGroup} data-placement={placement} data-browser-button
      // Dentro de la línea «Completed in…», que pliega el turno: los clics son solo nuestros.
      onClick={(event) => { event.stopPropagation() }}>
      <Tooltip label="Open the browser" side="top" delayMs={500} portal>
        <button type="button" className={css.groupButton} aria-label="Open the browser" data-browser-open
          onClick={() => { requestBrowserOpen(sessionId) }}>
          <IconGlobeOutlineRegular className={css.globe} data-busy={busy || undefined} />
        </button>
      </Tooltip>
      <Tooltip label={open ? 'Hide the steps' : "The agent's steps"} side="top" delayMs={500} disabled={open} portal>
        <button type="button" className={css.groupButton} aria-label="The agent's steps" aria-expanded={open} data-browser-steps
          onClick={() => { setOpen(value => !value) }}>
          <IconChevronDownOutlineRegular className={css.chevron} data-up={place?.up === true || undefined} />
        </button>
      </Tooltip>
      {open && createPortal(
        <MenuSurface ref={panel} className={css.stepsMenu} role="dialog" aria-label="The agent's steps in the browser"
          style={place === null
            ? { visibility: 'hidden', left: 0, top: 0 }
            : { left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}>
          <div className={css.stepsHead}><span>Agent steps</span><span>{String(steps.length)}</span></div>
          <ol ref={list} className={css.stepsList}>
            {steps.map(step => (
              <li key={step.callId} className={css.step} data-status={step.status}>
                <span className={css.stepDot} />
                <span className={css.stepText}>{browserStepText(step)}</span>
              </li>
            ))}
          </ol>
        </MenuSurface>,
        document.body,
      )}
    </span>
  )
}

interface StepsPlacement {
  readonly left: number
  readonly top?: number
  readonly bottom?: number
  readonly maxHeight: number
  readonly up: boolean
}

/** Separación entre los botones y la lista, y margen con los bordes. */
const STEPS_GAP = 6
const STEPS_MARGIN = 10
/** Altura con la que la lista se ve bien; con menos sitio debajo, se abre hacia arriba si allí hay más. */
const STEPS_COMFORT = 220
const STEPS_MAX = 420

/** Dónde va la lista: hacia abajo si cabe (hasta la barra de escribir), si no hacia donde haya más sitio. */
function placeSteps(anchor: HTMLElement, panel: HTMLElement): StepsPlacement {
  const rect = anchor.getBoundingClientRect()
  let scroller: HTMLElement | null = anchor.parentElement
  while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
  const area = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
  const composer = scroller?.querySelector<HTMLElement>('[data-composer-seat]')?.getBoundingClientRect()
  const topLimit = Math.max(overlayTopMargin(STEPS_MARGIN), area.top + STEPS_MARGIN)
  const bottomLimit = Math.min(window.innerHeight - STEPS_MARGIN,
    composer !== undefined && composer.top > rect.bottom ? composer.top - STEPS_MARGIN : area.bottom - STEPS_MARGIN)
  const below = bottomLimit - rect.bottom - STEPS_GAP
  const above = rect.top - STEPS_GAP - topLimit
  const natural = Math.min(STEPS_MAX, panel.scrollHeight)
  const up = below < Math.min(natural, STEPS_COMFORT) && above > below
  const left = Math.min(Math.max(rect.right - panel.offsetWidth, STEPS_MARGIN), window.innerWidth - panel.offsetWidth - STEPS_MARGIN)
  const maxHeight = Math.max(96, Math.min(STEPS_MAX, up ? above : below))
  return up
    ? { left, bottom: window.innerHeight - rect.top + STEPS_GAP, maxHeight, up }
    : { left, top: rect.bottom + STEPS_GAP, maxHeight, up }
}

/** Margen superior de los menús de la app: el de la franja reservada de la ventana (como overlayTopMargin de la app). */
function overlayTopMargin(min: number): number {
  const root = document.documentElement
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return min
  return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20)
}

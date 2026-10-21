/**
 * Navegador compartido del agente y del usuario, lado del panel derecho (añadido por dpseek-local-updater).
 *
 * Sustituye a la pestaña «Browser» de la app (mismo tipo, `browser`): los enlaces del chat se abren aquí. Enseña en
 * directo el Edge que usa el agente (fotogramas que da el Host, local-agent-browser.ts, en cuanto la página cambia) con
 * su barra: atrás, adelante, recargar, «Fix the view» (vuelve a la página de verdad, no a una ventana emergente, con el
 * tamaño del panel), dirección editable con una etiqueta de quién lo maneja («Agent» o «You»), pestañas, modo «solo
 * mirar», paso a paso del agente y llave.
 *
 * El usuario usa la página directamente: al pulsar, desplazar o escribir en ella toma el control (el interruptor «You |
 * Agent» de la barra de dirección pasa a «You»); mientras, las acciones del agente en el navegador esperan. El control
 * vuelve al agente con «Agent», al pulsar en el chat, al mandar un mensaje o tras un rato sin tocarla.
 * Lo que se escribe va directo a la página por el Host, nunca al chat ni al modelo.
 *
 * Como un navegador de diario: pestañas (se ve la que usa el agente; se puede elegir otra, abrir y cerrar), Ctrl+C y
 * Ctrl+X al portapapeles de Windows, Ctrl+F para buscar, Ctrl + / - / 0 para el zoom, Ctrl+L, F5, Alt+←/→, el cursor
 * de la página, un menú con el botón derecho y ficheros soltados sobre la página (se suben como un arrastre de verdad).
 *
 * Cuando el agente va a pulsar un botón que envía algo en una web real, una tarjeta pide permiso aquí («Allow» o
 * «Don't allow»); el panel se abre solo si no se estaba viendo.
 *
 * La página se adapta sola al panel, como una ventana de navegador (su tamaño y la densidad de la pantalla). Al
 * redimensionar, la imagen se escala al momento y la página se recoloca como mucho cada 100 ms; mientras el panel se
 * desliza al abrirse o cerrarse, no se cambia nada (como el resto de animaciones de la app).
 *
 * La flecha junto a la dirección despliega el paso a paso del agente de todos los turnos del chat. La llave abre las
 * contraseñas guardadas (bloqueadas hasta confirmar con Windows Hello o la contraseña de Windows; cada una con su web, y
 * con copia de seguridad cifrada) y las webs con sesión iniciada.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  DragEvent as ReactDragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode,
} from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  GuideArtworkBrowser, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular, IconCloseOutlineRegular, IconGlobeOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
  MenuSurface, SegmentedControl, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  browserStepText, liveSnapshot, onBrowserOpen, onTurnStart, requestBrowserOpen, runningSessions, sessionTurns, subscribeLive,
} from './local-live-store.ts'
import css from './local-agent-browser-tab.module.css'

/** El tipo de la pestaña «Browser» de la app: los enlaces del chat (`openTab('browser', { params: { url } })`) llegan aquí. */
export const BROWSER_KIND = 'browser'
const BROWSER_ID = 'dpseek-local-updater/shared-browser'
/** Sin navegador en marcha, cada cuánto se vuelve a mirar. */
const IDLE_MS = 1500
/** Al redimensionar, la página se recoloca como mucho con esta frecuencia (la imagen se escala mientras tanto). */
const RESIZE_MS = 100
/** Lo que dura el deslizamiento del panel (--ds-transition-duration-slow) y un poco más: sin cambios mientras tanto. */
const SLIDE_MS = 350
/** Pasos del zoom, como en Edge. */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

interface Confirm {
  readonly id: string
  readonly label: string
  readonly site: string
}

interface Frame {
  readonly running: boolean
  readonly url: string
  readonly title: string
  readonly seq: number
  readonly image: string | null
  readonly control: boolean
  readonly viewport: { readonly width: number; readonly height: number }
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly tabId: string
  readonly tabCount: number
  readonly lookOnly: boolean
  readonly zoom: number
  readonly confirm: Confirm | null
}

/** Un gesto para la página (posiciones de 0 a 1 sobre la imagen), como lo espera el Host. */
type Gesture =
  | {
    readonly kind: 'mouse'
    readonly type: 'down' | 'up' | 'move'
    readonly x: number
    readonly y: number
    readonly button: 'left' | 'right' | 'middle' | 'none'
    readonly buttons: number
    readonly clickCount: number
    readonly modifiers: number
  }
  | { readonly kind: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number; readonly modifiers: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly key: string; readonly code: string; readonly keyCode: number; readonly modifiers: number }

interface Site {
  readonly domain: string
  readonly cookies: number
}

interface Secret {
  readonly name: string
  readonly site: string
}

interface BrowserTabRow {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly shown: boolean
  readonly agent: boolean
}

/** El atajo de la app para abrir el navegador (Ctrl+T), el mismo que tenía la pestaña «Browser» original. */
const BROWSER_COMMAND = 'browser.new'

/** Lo que se usa del servicio de atajos y del panel derecho para registrar Ctrl+T. */
interface ShortcutScope {
  effect(setup: () => () => void, label: string): void
  shortcuts: { register(command: Record<string, unknown>): () => void }
  /** Del panel derecho de la app (el del plugin, no el del ámbito del servicio de atajos). */
  sidebarRight: {
    commandTarget(element: Element | null): unknown
    openTabFromTarget(kind: string, target: unknown): void
  }
}

let localCtx: Context | undefined
/** El último fotograma, para que la pestaña se vea al momento al volver a montarse (sin «cargando»). */
let lastFrame: Frame | undefined
/** Cuándo tocó el usuario la página por última vez (para no devolver el control por un mensaje anterior). */
let controlTakenAt = 0
/** Navegaciones ya atendidas por pestaña (los enlaces del chat), para no repetirlas al volver a montarla. */
const handledNavigation = new Map<string, number>()
/** Si Edge falta o es viejo, el aviso (se mira una vez). */
let edgeProblem: Promise<string | null> | undefined

/**
 * Registra la pestaña, su cuerpo y su apertura desde el chat.
 * @param ctx - contexto del plugin de entregables.
 */
export function setLocalAgentBrowser(ctx: Context): void {
  localCtx = ctx
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    // Montada aunque no se vea: al volver a ella está tal cual (sin parpadeo); oculta no pide fotogramas.
    keepMounted: true,
    title: () => 'Browser',
    guide: [{
      // El atajo (Ctrl+T) se ve junto a la entrada, como en la pestaña «Browser» original.
      ...({ commandId: BROWSER_COMMAND } as object),
      id: 'shared-browser', order: 30, icon: GuideArtworkBrowser,
      title: () => 'Browser',
      description: () => 'Browse the web together with the agent',
    }],
  }), 'local: shared browser type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: BROWSER_ID },
    BrowserTab,
  )), 'local: shared browser body')
  // Ctrl+T abre el navegador, como la pestaña «Browser» original de la app (que ya no se carga). El servicio de atajos
  // es de otro paquete: se usa por su nombre, sin sus tipos.
  const scoped = ctx as unknown as { inject(deps: readonly string[], callback: (scope: ShortcutScope) => void): void }
  scoped.inject(['shortcuts'], (scope) => {
    scope.effect(() => scope.shortcuts.register({
      id: BROWSER_COMMAND, label: () => 'Browser', aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }: { target: Element | null }) => {
        const right = ctx.sidebarRight as unknown as ShortcutScope['sidebarRight']
        const target = right.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: 'Open a session first' }
        return { status: 'handled', run: () => { right.openTabFromTarget(BROWSER_KIND, target) } }
      },
    }), 'local: shared browser shortcut')
  })
  // El título de la pestaña lleva su icono, como las demás («Files», la terminal).
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: BROWSER_ID },
    BrowserTitle,
  )), 'local: shared browser title')
  ctx.effect(() => onBrowserOpen((sessionId) => {
    const right = ctx.sidebarRight as typeof ctx.sidebarRight & {
      openTabIn?: (sessionId: SessionId, kind: string) => void
    }
    try {
      right.openTabIn(sessionId as SessionId, BROWSER_KIND)
    } catch (error) {
      console.warn('local shared browser:', error)
    }
  }), 'local: shared browser open')
  // Mandar un mensaje en el chat devuelve el control del navegador al agente (si el usuario toca la página después, el
  // agente espera: solo cuenta el momento en que empieza el turno).
  ctx.effect(() => onTurnStart((_sessionId, startedAt) => {
    // El turno se ve en el chat un poco después de mandar el mensaje: si el usuario tocó la página entre medias, sigue.
    if (startedAt !== undefined && controlTakenAt > startedAt) return
    void ctx.remote.session.localAgentBrowserControl({ active: false }).catch(() => undefined)
  }), 'local: shared browser give back on message')
  // Un clic del agente que espera permiso: se abre el panel del navegador en ese chat, donde está la tarjeta para
  // responder (una vez por permiso). Solo se pregunta al Host mientras algún chat tiene un turno en marcha.
  let opened = ''
  const pending = setInterval(() => {
    const running = runningSessions()
    if (running.length === 0) return
    void ctx.remote.session.localAgentBrowserPending({}).then((result) => {
      const confirm = result.ok ? result.value.confirm : null
      if (confirm === null || confirm.id === opened) return
      opened = confirm.id
      const sessionId = running[0]
      if (sessionId !== undefined) requestBrowserOpen(sessionId)
    }).catch(() => undefined)
  }, 1000)
  ctx.effect(() => () => { clearInterval(pending) }, 'local: shared browser pending clicks')
  // Al ocultar o cerrar la ventana, las contraseñas guardadas se vuelven a bloquear.
  const lock = (): void => {
    if (document.visibilityState === 'hidden') void ctx.remote.session.localAgentBrowserLock({}).catch(() => undefined)
  }
  document.addEventListener('visibilitychange', lock)
  ctx.effect(() => () => { document.removeEventListener('visibilitychange', lock) }, 'local: shared browser lock')
}

/** El globo y «Browser» en la pestaña. */
function BrowserTitle(): ReactNode {
  return <><IconGlobeOutlineRegular className={css.titleIcon} />Browser</>
}

const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

const messageOf = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/** El sitio de la página en el panel, en píxeles CSS, y la densidad de la pantalla (cambia al moverla a otro monitor). */
function useViewSize(element: HTMLElement | null): { width: number; height: number; dpr: number } {
  const [size, setSize] = useState({ width: 0, height: 0, dpr: window.devicePixelRatio || 1 })
  useEffect(() => {
    if (element === null) return
    const measure = (): void => {
      const box = element.getBoundingClientRect()
      const next = { width: Math.floor(box.width), height: Math.floor(box.height), dpr: window.devicePixelRatio || 1 }
      setSize(previous => previous.width === next.width && previous.height === next.height && previous.dpr === next.dpr ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    let media = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`)
    const onDpr = (): void => {
      measure()
      media.removeEventListener('change', onDpr)
      media = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`)
      media.addEventListener('change', onDpr)
    }
    media.addEventListener('change', onDpr)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', onDpr)
    }
  }, [element])
  return size
}

/**
 * Los fotogramas en directo mientras la pestaña se ve: el Host responde en cuanto hay uno nuevo (o al poco, si la página
 * está quieta), así que se piden uno tras otro sin esperas.
 */
function useFrames(visible: boolean): Frame | undefined {
  const [frame, setFrame] = useState<Frame | undefined>(lastFrame)
  useEffect(() => {
    if (!visible) return
    const state = { stopped: false }
    const stopped = (): boolean => state.stopped
    const loop = async (): Promise<void> => {
      while (!state.stopped) {
        let next: Frame | undefined
        try {
          if (localCtx !== undefined && document.visibilityState === 'visible') {
            next = unwrap(await localCtx.remote.session.localAgentBrowserFrame({ after: lastFrame?.image == null ? 0 : lastFrame.seq }))
          }
        } catch {
          // Sin Host o sin respuesta: se vuelve a intentar.
        }
        if (stopped()) return
        if (next !== undefined) {
          const kept = next.image === null && next.running && lastFrame?.image != null
            ? { ...next, image: lastFrame.image, seq: lastFrame.seq }
            : next
          lastFrame = kept
          setFrame(kept)
        }
        if (next?.running !== true) await new Promise(resolve => setTimeout(resolve, IDLE_MS))
      }
    }
    void loop()
    return () => { state.stopped = true }
  }, [visible])
  return frame
}

/** Modificadores como los cuenta el protocolo de depuración: Alt 1, Ctrl 2, Meta 4, Mayús 8. */
const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

/**
 * Cola de gestos hacia la página: en orden, uno tras otro, y los movimientos del ratón sin acumularse (si hay uno
 * esperando, el nuevo lo sustituye). Al mover el ratón, el Host dice a veces qué cursor pondría la página.
 */
function useGestureQueue(onError: (message: string) => void, onCursor: (cursor: string) => void): (gesture: Gesture) => void {
  const queue = useRef<Gesture[]>([])
  const busy = useRef(false)
  const pump = useCallback(async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      for (let gesture = queue.current.shift(); gesture !== undefined; gesture = queue.current.shift()) {
        try {
          if (localCtx === undefined) continue
          const result = unwrap(await localCtx.remote.session.localAgentBrowserInput({ input: gesture }))
          if (result.cursor !== undefined) onCursor(result.cursor)
        } catch (error) {
          onError(messageOf(error))
        }
      }
    } finally {
      busy.current = false
    }
  }, [onError, onCursor])
  return useCallback((gesture: Gesture) => {
    const last = queue.current.at(-1)
    if (gesture.kind === 'mouse' && gesture.type === 'move' && last?.kind === 'mouse' && last.type === 'move') queue.current[queue.current.length - 1] = gesture
    else queue.current.push(gesture)
    void pump()
  }, [pump])
}

/** Posición (0..1) de un punto sobre la imagen, descontando las bandas si la imagen no llena su caja. */
function pointOn(image: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } {
  const box = image.getBoundingClientRect()
  const natural = { width: image.naturalWidth || box.width, height: image.naturalHeight || box.height }
  const scale = Math.min(box.width / natural.width, box.height / natural.height)
  const width = natural.width * scale
  const height = natural.height * scale
  return { x: (clientX - box.left - (box.width - width) / 2) / width, y: (clientY - box.top - (box.height - height) / 2) / height }
}

/** El contenido de un fichero en base64 (sin la cabecera data:). */
function fileData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result.replace(/^data:[^,]*,/, '') : '') }
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')) }
    reader.readAsDataURL(file)
  })
}

/** Cursores que se pueden poner sobre la imagen (los de la página; «auto» y los de URL se quedan en el normal). */
const safeCursor = (cursor: string): string => /^[a-z-]+$/.test(cursor) && cursor !== 'auto' ? cursor : 'default'

const BUTTONS = ['left', 'middle', 'right'] as const

function BrowserTab({ useTabInfo, sessionId }: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const { tab, sidebar } = useTabInfo()
  const visible = tab.visible
  const frame = useFrames(visible)
  const running = frame?.running === true
  const [viewElement, setViewElement] = useState<HTMLDivElement | null>(null)
  const view = useRef<HTMLDivElement | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const addressInput = useRef<HTMLInputElement | null>(null)
  const area = useViewSize(viewElement)
  const live = useSyncExternalStore(subscribeLive, () => liveSnapshot(sessionId))
  const steps = live?.browser ?? []
  const turns = useSyncExternalStore(subscribeLive, () => sessionTurns(sessionId))
  const anySteps = turns.some(entry => (entry.browser?.length ?? 0) > 0)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [cursor, setCursor] = useState('default')
  const send = useGestureQueue(setError, setCursor)
  // Los avisos se van solos.
  useEffect(() => {
    if (error === null) return
    const timer = setTimeout(() => { setError(null) }, 6000)
    return () => { clearTimeout(timer) }
  }, [error])
  useEffect(() => {
    if (note === null) return
    const timer = setTimeout(() => { setNote(null) }, 1600)
    return () => { clearTimeout(timer) }
  }, [note])
  // Si falta Edge o es viejo, se dice en vez de «Nothing open yet».
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (localCtx === undefined) return
    const ctx = localCtx
    const check = edgeProblem ??= ctx.remote.session.localAgentBrowserCheck({})
      .then(result => result.ok && !result.value.ok ? result.value.message ?? 'Microsoft Edge cannot run the browser.' : null)
      .catch(() => null)
    void check.then(setProblem)
  }, [])

  // Quién maneja la página: lo que diga el Host, salvo justo después de un cambio hecho aquí (llega con retraso).
  const [control, setControlState] = useState(frame?.control === true)
  const changedAt = useRef(0)
  useEffect(() => {
    if (frame !== undefined && Date.now() - changedAt.current > 1500) setControlState(frame.control)
  }, [frame])
  const markControl = (active: boolean): void => {
    changedAt.current = Date.now()
    if (active) controlTakenAt = Date.now()
    setControlState(active)
  }
  // «You | Agent»: tomar el control o devolvérselo al agente (lo mismo que tocar la página o mandar un mensaje).
  const setDriver = async (you: boolean): Promise<void> => {
    markControl(you)
    try {
      if (localCtx !== undefined) unwrap(await localCtx.remote.session.localAgentBrowserControl({ active: you }))
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  // Tamaño de la página = el del panel. Al montarse y mientras el panel se desliza, quieto; al redimensionar, como
  // mucho cada RESIZE_MS (la imagen se escala entre medias).
  const frozenUntil = useRef(Date.now() + SLIDE_MS)
  const expanded = sidebar.expanded
  useLayoutEffect(() => { frozenUntil.current = Date.now() + SLIDE_MS }, [expanded, visible])
  const sentSize = useRef('')
  const sizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastSent = useRef(0)
  useEffect(() => {
    if (!visible || area.width < 50 || area.height < 50) return
    const key = `${String(area.width)}x${String(area.height)}@${String(area.dpr)}`
    const push = (): void => {
      const wait = Math.max(frozenUntil.current - Date.now(), lastSent.current + RESIZE_MS - Date.now())
      if (wait > 0) {
        clearTimeout(sizeTimer.current)
        sizeTimer.current = setTimeout(push, wait)
        return
      }
      if (sentSize.current === key || localCtx === undefined) return
      sentSize.current = key
      lastSent.current = Date.now()
      void localCtx.remote.session.localAgentBrowserViewport({ width: area.width, height: area.height, dpr: area.dpr })
        .catch(() => undefined)
    }
    push()
  }, [area.width, area.height, area.dpr, visible])
  useEffect(() => () => { clearTimeout(sizeTimer.current) }, [])
  // Si la imagen sigue sin cuadrar con el panel (se perdió un cambio de tamaño), se vuelve a pedir. Se mira cada poco:
  // una página quieta no manda fotogramas.
  const areaRef = useRef(area)
  areaRef.current = area
  const zoom = frame?.zoom ?? 1
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  useEffect(() => {
    if (!visible || !running) return
    const timer = setInterval(() => {
      const picture = image.current
      const now = areaRef.current
      if (picture === null || picture.naturalWidth === 0 || now.width < 50 || localCtx === undefined) return
      // Con los mismos límites que pone el Host (página de 320 × 240 como mínimo, densidad de 1 a 3); el zoom no cambia
      // los píxeles de la imagen.
      const dpr = Math.min(3, Math.max(1, now.dpr))
      const off = Math.abs(picture.naturalWidth / dpr - Math.max(320, now.width)) > 3 + zoomRef.current
        || Math.abs(picture.naturalHeight / dpr - Math.max(240, now.height)) > 3 + zoomRef.current
      if (!off || Date.now() - lastSent.current < 1500 || Date.now() < frozenUntil.current) return
      lastSent.current = Date.now()
      void localCtx.remote.session.localAgentBrowserViewport({ width: now.width, height: now.height, dpr: now.dpr }).catch(() => undefined)
    }, 1000)
    return () => { clearInterval(timer) }
  }, [visible, running])

  // Barra de dirección.
  const [address, setAddress] = useState<string | null>(null)
  const navigate = useCallback(async (navigation: { action: 'url'; url: string } | { action: 'back' | 'forward' | 'reload' }): Promise<void> => {
    setError(null)
    changedAt.current = Date.now()
    controlTakenAt = Date.now()
    setControlState(true)
    try {
      if (localCtx !== undefined) unwrap(await localCtx.remote.session.localAgentBrowserNavigate(navigation))
    } catch (reason) {
      setError(messageOf(reason))
    }
  }, [])
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (address === null || address.trim() === '') return
    void navigate({ action: 'url', url: address })
    setAddress(null)
    view.current?.focus()
  }
  // «Fix the view»: la página de verdad (no una ventana emergente), con el tamaño del panel y un fotograma nuevo.
  const [repairing, setRepairing] = useState(false)
  const repair = async (): Promise<void> => {
    if (localCtx === undefined) return
    setRepairing(true)
    setError(null)
    try {
      unwrap(await localCtx.remote.session.localAgentBrowserRepair({}))
      sentSize.current = ''
      lastSent.current = Date.now()
      void localCtx.remote.session.localAgentBrowserViewport({ width: area.width, height: area.height, dpr: area.dpr })
        .catch(() => undefined)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setRepairing(false)
    }
  }
  // Los enlaces del chat llegan como navegación de la pestaña.
  const revision = tab.navigation.revision
  const wantedUrl = (tab.navigation.params as { url?: unknown } | undefined)?.url
  useEffect(() => {
    if (revision === 0 || handledNavigation.get(tab.id) === revision) return
    handledNavigation.set(tab.id, revision)
    if (typeof wantedUrl === 'string' && wantedUrl !== '') void navigate({ action: 'url', url: wantedUrl })
  }, [revision, wantedUrl, tab.id, navigate])
  useEffect(() => tab.actions.bindCommands({ refresh: () => { void navigate({ action: 'reload' }) } }), [tab.actions, navigate])

  // Zoom (se guarda en el Host) y modo «solo mirar».
  const [lookOnly, setLookOnly] = useState(frame?.lookOnly === true)
  const settingsAt = useRef(0)
  useEffect(() => {
    if (frame !== undefined && Date.now() - settingsAt.current > 1500) setLookOnly(frame.lookOnly)
  }, [frame])
  const settings = async (change: { lookOnly?: boolean; zoom?: number }): Promise<void> => {
    settingsAt.current = Date.now()
    if (change.lookOnly !== undefined) setLookOnly(change.lookOnly)
    try {
      if (localCtx !== undefined) unwrap(await localCtx.remote.session.localAgentBrowserSettings(change))
    } catch (reason) {
      setError(messageOf(reason))
    }
  }
  const zoomBy = (direction: -1 | 0 | 1): void => {
    const index = ZOOM_STEPS.findIndex(step => step >= zoom - 0.001)
    const at = (index < 0 ? ZOOM_STEPS.length - 1 : index) + direction
    const next = direction === 0 ? 1 : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at))] ?? 1
    void settings({ zoom: next })
    setNote(`${String(Math.round(next * 100))}%`)
  }

  // Copiar al portapapeles de Windows lo seleccionado en la página (el Edge sin ventana no siempre llega a él).
  const copySelection = async (): Promise<void> => {
    if (localCtx === undefined) return
    try {
      const { text } = unwrap(await localCtx.remote.session.localAgentBrowserCopy({}))
      if (text === '') return
      await navigator.clipboard.writeText(text)
      setNote('Copied')
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  // Buscar en la página (Ctrl+F).
  const [findOpen, setFindOpen] = useState(false)

  // Ratón: pulsar toma el control; con él, también se mueve el puntero y se arrastra. El botón derecho abre el menú.
  const pointer = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null)
  const moveFrame = useRef(0)
  const take = (): void => {
    if (!control) markControl(true)
    setError(null)
  }
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    event.preventDefault()
    view.current?.focus({ preventScroll: true })
    if (event.button === 2) return
    setMenu(null)
    event.currentTarget.setPointerCapture(event.pointerId)
    take()
    send({
      kind: 'mouse', type: 'down', ...pointOn(event.currentTarget, event.clientX, event.clientY),
      button: BUTTONS[event.button] ?? 'left', buttons: event.buttons, clickCount: Math.max(1, event.detail), modifiers: modifiersOf(event),
    })
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (!control) return
    pointer.current = {
      ...pointOn(event.currentTarget, event.clientX, event.clientY), buttons: event.buttons, modifiers: modifiersOf(event),
    }
    if (moveFrame.current !== 0) return
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0
      const at = pointer.current
      if (at === null) return
      const button = (at.buttons & 1) === 1 ? 'left' : (at.buttons & 2) === 2 ? 'right' : (at.buttons & 4) === 4 ? 'middle' : 'none'
      send({ kind: 'mouse', type: 'move', x: at.x, y: at.y, button, buttons: at.buttons, clickCount: 0, modifiers: at.modifiers })
    })
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (event.button === 2) return
    send({
      kind: 'mouse', type: 'up', ...pointOn(event.currentTarget, event.clientX, event.clientY),
      button: BUTTONS[event.button] ?? 'left', buttons: event.buttons, clickCount: Math.max(1, event.detail), modifiers: modifiersOf(event),
    })
  }
  useEffect(() => () => { cancelAnimationFrame(moveFrame.current) }, [])

  // La rueda desplaza la página (no el panel), agrupada por fotograma de pantalla; con Ctrl, el zoom.
  const controlRef = useRef(control)
  controlRef.current = control
  // Pulsar en el chat (fuera del panel derecho) devuelve el navegador al agente, como «Agent».
  const setDriverRef = useRef(setDriver)
  setDriverRef.current = setDriver
  useEffect(() => {
    if (!visible) return
    const onDown = (event: PointerEvent): void => {
      if (!controlRef.current || !(event.target instanceof Element)) return
      if (event.target.closest('[data-rightbar-col], [data-sidebar-right-panel], [data-agent-browser]') !== null) return
      void setDriverRef.current(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => { document.removeEventListener('pointerdown', onDown, true) }
  }, [visible])
  const zoomByRef = useRef(zoomBy)
  zoomByRef.current = zoomBy
  useEffect(() => {
    const element = view.current
    if (element === null || !running) return
    const wheel = { dx: 0, dy: 0, x: 0, y: 0, modifiers: 0, frame: 0, zoomAt: 0 }
    const onWheel = (event: WheelEvent): void => {
      const picture = image.current
      if (picture === null) return
      event.preventDefault()
      if (event.ctrlKey) {
        if (Date.now() - wheel.zoomAt > 120 && event.deltaY !== 0) {
          wheel.zoomAt = Date.now()
          zoomByRef.current(event.deltaY < 0 ? 1 : -1)
        }
        return
      }
      if (!controlRef.current) {
        changedAt.current = Date.now()
        controlTakenAt = Date.now()
        setControlState(true)
      }
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? picture.clientHeight : 1
      wheel.dx += event.deltaX * scale
      wheel.dy += event.deltaY * scale
      Object.assign(wheel, pointOn(picture, event.clientX, event.clientY), { modifiers: modifiersOf(event) })
      if (wheel.frame !== 0) return
      wheel.frame = requestAnimationFrame(() => {
        send({ kind: 'wheel', x: wheel.x, y: wheel.y, deltaX: wheel.dx, deltaY: wheel.dy, modifiers: wheel.modifiers })
        wheel.dx = 0
        wheel.dy = 0
        wheel.frame = 0
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(wheel.frame)
    }
  }, [running, send])

  // Teclado: el texto se agrupa (una llamada por ráfaga, no por letra); las demás teclas van una a una. Algunos atajos
  // son del navegador, como en Edge.
  const typed = useRef('')
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flush = (): void => {
    clearTimeout(flushTimer.current)
    if (typed.current === '') return
    const text = typed.current
    typed.current = ''
    send({ kind: 'text', text })
  }
  const newTab = async (): Promise<void> => {
    try {
      if (localCtx !== undefined) unwrap(await localCtx.remote.session.localAgentBrowserTab({ action: 'new' }))
      // La dirección, vacía y lista para escribir (la del fotograma anterior llegaba después y se quedaba delante).
      setAddress('')
      addressInput.current?.focus()
    } catch (reason) {
      setError(messageOf(reason))
    }
  }
  const sendKey = (event: {
    key: string
    code: string
    keyCode: number
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
  }): void => {
    send({ kind: 'key', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiersOf(event) })
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!running || event.target !== event.currentTarget) return
    const primary = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    // Ctrl+V lo atiende el evento de pegar (con el texto del portapapeles).
    if (primary && key === 'v') return
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return
    event.preventDefault()
    const shortcut = (run: () => void): void => { flush(); run() }
    if (primary && key === 'l') {  shortcut(() => { addressInput.current?.focus() }); return }
    if (primary && key === 'f') {  shortcut(() => { setFindOpen(true) }); return }
    if (primary && key === 't') {  shortcut(() => { void newTab() }); return }
    if ((primary && key === 'r') || event.key === 'F5') {  shortcut(() => { void navigate({ action: 'reload' }) }); return }
    if (event.altKey && event.key === 'ArrowLeft') {  shortcut(() => { void navigate({ action: 'back' }) }); return }
    if (event.altKey && event.key === 'ArrowRight') {  shortcut(() => { void navigate({ action: 'forward' }) }); return }
    if (primary && (event.key === '+' || event.key === '=')) {  shortcut(() => { zoomBy(1) }); return }
    if (primary && event.key === '-') {  shortcut(() => { zoomBy(-1) }); return }
    if (primary && event.key === '0') {  shortcut(() => { zoomBy(0) }); return }
    take()
    // Copiar o cortar: primero se lee lo seleccionado (cortar lo borra) y luego la tecla llega a la página.
    if (primary && (key === 'c' || key === 'x')) {
      flush()
      // React ya no reutiliza los eventos: se puede mandar este mismo después.
      void copySelection().finally(() => { sendKey(event) })
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typed.current += event.key
      clearTimeout(flushTimer.current)
      flushTimer.current = setTimeout(flush, 40)
      return
    }
    flush()
    sendKey(event)
  }

  // Ficheros soltados sobre la página: se suben como un arrastre de verdad en ese punto.
  const [dropping, setDropping] = useState(false)
  const hasFiles = (event: ReactDragEvent): boolean => [...event.dataTransfer.types].includes('Files')
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!running || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = async (event: ReactDragEvent<HTMLDivElement>): Promise<void> => {
    setDropping(false)
    const picture = image.current
    if (!running || !hasFiles(event) || picture === null || localCtx === undefined) return
    event.preventDefault()
    const point = pointOn(picture, event.clientX, event.clientY)
    const files = [...event.dataTransfer.files]
    take()
    try {
      const data = await Promise.all(files.map(async file => ({ name: file.name, data: await fileData(file) })))
      const { dropped } = unwrap(await localCtx.remote.session.localAgentBrowserDrop({ ...point, files: data }))
      setNote(dropped === 1 ? 'File dropped on the page' : `${String(dropped)} files dropped on the page`)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  // El permiso para un clic del agente.
  const [answered, setAnswered] = useState('')
  const [always, setAlways] = useState(false)
  const confirm = frame?.confirm != null && frame.confirm.id !== answered ? frame.confirm : null
  const answer = async (allow: boolean): Promise<void> => {
    if (confirm === null || localCtx === undefined) return
    setAnswered(confirm.id)
    try {
      unwrap(await localCtx.remote.session.localAgentBrowserConfirm({ id: confirm.id, allow, always: allow && always }))
    } catch (reason) {
      setError(messageOf(reason))
    }
    setAlways(false)
  }

  const [stepsOpen, setStepsOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [tabsOpen, setTabsOpen] = useState(false)
  // Una pestaña en blanco deja la dirección vacía (con su texto de ayuda), no «about:blank».
  const shownUrl = address ?? (frame?.url === 'about:blank' ? '' : frame?.url ?? '')
  const agentBusy = !control && live?.running === true && steps.at(-1)?.status === 'running'
  const tabCount = frame?.tabCount ?? 0
  return (
    <div className={css.root} data-agent-browser data-control={control || undefined}>
      <div className={css.header}>
        <Tooltip label="Back (Alt+←)" side="bottom" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Back" disabled={frame?.canGoBack !== true}
            onClick={() => { void navigate({ action: 'back' }) }}><IconChevronLeftOutlineRegular /></button>
        </Tooltip>
        <Tooltip label="Forward (Alt+→)" side="bottom" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Forward" disabled={frame?.canGoForward !== true} data-optional
            onClick={() => { void navigate({ action: 'forward' }) }}><IconChevronRightOutlineRegular /></button>
        </Tooltip>
        <Tooltip label="Reload (F5)" side="bottom" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Reload" disabled={!running}
            onClick={() => { void navigate({ action: 'reload' }) }}><IconRefreshOutlineRegular /></button>
        </Tooltip>
        <Tooltip label="Fix the view" side="bottom" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Fix the view" disabled={!running || repairing} data-browser-repair data-optional
            onClick={() => { void repair() }}><FitIcon /></button>
        </Tooltip>
        <form className={css.address} onSubmit={submit}>
          {running && (
            <span className={css.driver} role="group" aria-label="Who uses the browser">
              <Tooltip label="You use the page; the agent waits" side="bottom" delayMs={500}>
                <button type="button" className={css.driverOption} aria-pressed={control} data-browser-you
                  onClick={() => { void setDriver(true) }}>You</button>
              </Tooltip>
              <Tooltip label="Give the browser back to the agent" side="bottom" delayMs={500}>
                <button type="button" className={css.driverOption} aria-pressed={!control} data-browser-agent data-busy={agentBusy || undefined}
                  onClick={() => { void setDriver(false) }}>Agent</button>
              </Tooltip>
            </span>
          )}
          <input ref={addressInput} className={css.addressInput} value={shownUrl} placeholder="Search or type an address" aria-label="Address"
            spellCheck={false} autoComplete="off"
            onFocus={(event) => { event.currentTarget.select() }}
            onChange={(event) => { setAddress(event.target.value) }}
            onBlur={() => { setAddress(null) }}
            onKeyDown={(event) => { if (event.key === 'Escape') { setAddress(null); event.currentTarget.blur(); view.current?.focus() } }} />
          {Math.abs(zoom - 1) > 0.001 && (
            <Tooltip label="Reset zoom (Ctrl+0)" side="bottom" delayMs={500}>
              <button type="button" className={css.zoomChip} aria-label="Reset zoom" data-browser-zoom
                onClick={() => { zoomBy(0) }}>{`${String(Math.round(zoom * 100))}%`}</button>
            </Tooltip>
          )}
        </form>
        <Tooltip label="Tabs" side="bottom" delayMs={500} disabled={tabsOpen}>
          <button type="button" className={css.icon} aria-label="Tabs" aria-expanded={tabsOpen} data-browser-tabs disabled={!running}
            onClick={() => { setTabsOpen(open => !open) }}><TabsIcon count={tabCount} /></button>
        </Tooltip>
        {anySteps && (
          <Tooltip label="The agent's steps" side="bottom" delayMs={500} disabled={stepsOpen}>
            <button type="button" className={css.icon} aria-label="The agent's steps" aria-expanded={stepsOpen} data-browser-steps
              onClick={() => { setStepsOpen(open => !open) }}>
              <IconChevronDownOutlineRegular className={css.chevron} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={lookOnly ? 'Look only is on: the agent cannot click or type on real sites' : 'Look only: the agent can read real sites but not click or type'}
          side="bottom" align="end" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Look only" aria-pressed={lookOnly} data-browser-look-only
            onClick={() => { void settings({ lookOnly: !lookOnly }) }}><EyeIcon /></button>
        </Tooltip>
        <Tooltip label="Passwords and sign-ins" side="bottom" align="end" delayMs={500} disabled={keysOpen}>
          <button type="button" className={css.icon} aria-label="Passwords and sign-ins" aria-expanded={keysOpen} data-browser-keys
            onClick={() => { setKeysOpen(open => !open) }}><KeyIcon /></button>
        </Tooltip>
        {stepsOpen && anySteps && <StepsPopover sessionId={sessionId} onClose={() => { setStepsOpen(false) }} />}
        {keysOpen && <KeysPopover onClose={() => { setKeysOpen(false) }} />}
        {tabsOpen && (
          <TabsPopover onClose={() => { setTabsOpen(false) }} onError={setError}
            onNewTab={() => { setTabsOpen(false); void newTab() }} />
        )}
      </div>
      <div ref={(element) => { view.current = element; setViewElement(element) }} className={css.view}
        data-dropping={dropping || undefined} tabIndex={running ? 0 : -1}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          if (!running) return
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          take()
          flush()
          if (text !== '') send({ kind: 'text', text })
        }}
        onDragOver={onDragOver}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDropping(false) }}
        onDrop={(event) => { void onDrop(event) }}>
        {running && frame.image != null && frame.url !== 'about:blank'
          ? <img ref={image} className={css.image} src={`data:image/jpeg;base64,${frame.image}`} alt={frame.title} draggable={false}
            style={{ cursor: control ? safeCursor(cursor) : 'default' }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }) }} />
          : (
            <p className={css.empty} data-problem={problem !== null || undefined}>
              {problem ?? (running && frame.url !== 'about:blank' ? 'Loading the page…' : 'Nothing open yet. Type an address above, or ask the agent to visit a site.')}
            </p>
          )}
        {findOpen && running && <FindBar onClose={() => { setFindOpen(false); view.current?.focus() }} />}
        {dropping && <div className={css.dropHint}>Drop to upload to the page</div>}
        {confirm !== null && (
          <div className={css.confirm} role="alertdialog" aria-label="The agent asks to send something" data-browser-confirm>
            <div className={css.confirmTitle}>The agent wants to {confirm.label}</div>
            <div className={css.confirmSite}>on {confirm.site} · it may send, pay, delete or publish something</div>
            <label className={css.confirmAlways}>
              <input type="checkbox" checked={always} onChange={(event) => { setAlways(event.target.checked) }} />
              Always allow on this site until the app closes
            </label>
            <div className={css.confirmActions}>
              <button type="button" className={css.secondary} onClick={() => { void answer(false) }} data-browser-decline>Don't allow</button>
              <button type="button" className={css.primary} onClick={() => { void answer(true) }} data-browser-allow>Allow</button>
            </div>
          </div>
        )}
        {error !== null && <p className={css.toast} role="alert" onClick={() => { setError(null) }}>{error}</p>}
        {error === null && note !== null && <p className={css.note} role="status">{note}</p>}
        {menu !== null && (
          <PageMenu at={menu} canBack={frame?.canGoBack === true} canForward={frame?.canGoForward === true} zoom={zoom}
            onClose={() => { setMenu(null); view.current?.focus({ preventScroll: true }) }}
            onAction={(action) => {
              setMenu(null)
              view.current?.focus({ preventScroll: true })
              if (action === 'back' || action === 'forward' || action === 'reload') void navigate({ action })
              else if (action === 'copy') void copySelection()
              else if (action === 'paste') {
                void navigator.clipboard.readText().then((text) => { if (text !== '') { take(); send({ kind: 'text', text }) } })
                  .catch(() => { setError('The clipboard could not be read. Use Ctrl+V.') })
              } else if (action === 'selectAll') {
                take()
                send({ kind: 'key', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
              } else if (action === 'find') setFindOpen(true)
              else if (action === 'zoomIn') zoomBy(1)
              else if (action === 'zoomOut') zoomBy(-1)
              else zoomBy(0)
            }} />
        )}
      </div>
    </div>
  )
}

type MenuAction = 'back' | 'forward' | 'reload' | 'copy' | 'paste' | 'selectAll' | 'find' | 'zoomIn' | 'zoomOut' | 'zoomReset'

/** El menú del botón derecho sobre la página. */
function PageMenu({ at, canBack, canForward, zoom, onClose, onAction }: {
  at: { x: number; y: number }
  canBack: boolean
  canForward: boolean
  zoom: number
  onClose: () => void
  onAction: (action: MenuAction) => void
}): ReactNode {
  const box = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  usePopoverDismiss(box, onClose, '[data-browser-menu-none]')
  useLayoutEffect(() => {
    const element = box.current
    const parent = element?.offsetParent?.getBoundingClientRect()
    if (element === null || parent === undefined) return
    const left = Math.min(at.x - parent.left, parent.width - element.offsetWidth - 6)
    const top = Math.min(at.y - parent.top, parent.height - element.offsetHeight - 6)
    setPlace({ left: Math.max(6, left), top: Math.max(6, top) })
  }, [at.x, at.y])
  const item = (action: MenuAction, label: string, keys: string, disabled = false): ReactNode => (
    <button type="button" role="menuitem" className={css.menuItem} disabled={disabled} onClick={() => { onAction(action) }}>
      <span>{label}</span><span className={css.menuKeys}>{keys}</span>
    </button>
  )
  return (
    <MenuSurface ref={box} className={css.pageMenu} role="menu" aria-label="Page"
      style={place === null ? { visibility: 'hidden', left: 0, top: 0 } : place}>
      {item('back', 'Back', 'Alt+←', !canBack)}
      {item('forward', 'Forward', 'Alt+→', !canForward)}
      {item('reload', 'Reload', 'F5')}
      <div className={css.menuSeparator} />
      {item('copy', 'Copy', 'Ctrl+C')}
      {item('paste', 'Paste', 'Ctrl+V')}
      {item('selectAll', 'Select all', 'Ctrl+A')}
      <div className={css.menuSeparator} />
      {item('find', 'Find in page…', 'Ctrl+F')}
      {item('zoomIn', 'Zoom in', 'Ctrl++')}
      {item('zoomOut', 'Zoom out', 'Ctrl+-')}
      {item('zoomReset', `Reset zoom (${String(Math.round(zoom * 100))}%)`, 'Ctrl+0', Math.abs(zoom - 1) < 0.001)}
    </MenuSurface>
  )
}

/** Buscar en la página: Intro, la siguiente; Mayús+Intro, la anterior; Escape cierra. */
function FindBar({ onClose }: { onClose: () => void }): ReactNode {
  const [text, setText] = useState('')
  const [missing, setMissing] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => { input.current?.focus() }, [])
  const find = async (backwards: boolean): Promise<void> => {
    if (localCtx === undefined || text === '') return
    try {
      const { found } = unwrap(await localCtx.remote.session.localAgentBrowserFind({ text, backwards }))
      setMissing(!found)
    } catch {
      setMissing(true)
    }
  }
  return (
    <div className={css.findBar} role="search" data-browser-find>
      <input ref={input} className={css.findInput} value={text} placeholder="Find in page" aria-label="Find in page" spellCheck={false}
        data-missing={missing || undefined}
        onChange={(event) => { setText(event.target.value); setMissing(false) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); void find(event.shiftKey) }
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
        }} />
      {missing && <span className={css.findMissing}>No matches</span>}
      <button type="button" className={css.icon} aria-label="Previous match" disabled={text === ''} onClick={() => { void find(true) }}>
        <IconChevronUpOutlineRegular />
      </button>
      <button type="button" className={css.icon} aria-label="Next match" disabled={text === ''} onClick={() => { void find(false) }}>
        <IconChevronDownOutlineRegular />
      </button>
      <button type="button" className={css.icon} aria-label="Close find" onClick={onClose}><IconCloseOutlineRegular /></button>
    </div>
  )
}

/** Las pestañas abiertas: la que se ve, la del agente, cambiar, cerrar y abrir otra. */
function TabsPopover({ onClose, onError, onNewTab }: {
  onClose: () => void
  onError: (message: string) => void
  onNewTab: () => void
}): ReactNode {
  const box = useRef<HTMLDivElement | null>(null)
  const [tabs, setTabs] = useState<readonly BrowserTabRow[] | null>(null)
  usePopoverDismiss(box, onClose, '[data-browser-tabs]')
  const load = useCallback(async (): Promise<void> => {
    if (localCtx === undefined) return
    try {
      setTabs(unwrap(await localCtx.remote.session.localAgentBrowserTabs({})).tabs)
    } catch (reason) {
      onError(messageOf(reason))
    }
  }, [onError])
  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 2000)
    return () => { clearInterval(timer) }
  }, [load])
  const act = async (request: { action: 'show' | 'close'; id: string }): Promise<void> => {
    if (localCtx === undefined) return
    try {
      unwrap(await localCtx.remote.session.localAgentBrowserTab(request))
      if (request.action === 'show') onClose()
      else await load()
    } catch (reason) {
      onError(messageOf(reason))
    }
  }
  return (
    <MenuSurface ref={box} className={css.popover} data-kind="tabs" role="dialog" aria-label="Tabs">
      <div className={css.stepsHead}><span>Tabs</span><span>{tabs === null ? '' : String(tabs.length)}</span></div>
      <ul className={css.rows}>
        {(tabs ?? []).map(entry => (
          <li key={entry.id} className={css.tabRow} data-shown={entry.shown || undefined}>
            <button type="button" className={css.tabMain} title={entry.url} onClick={() => { void act({ action: 'show', id: entry.id }) }}>
              <span className={css.tabTitle}>{entry.title}</span>
              <span className={css.tabUrl}>{entry.url}</span>
            </button>
            {entry.agent && <span className={css.who} data-who="agent">Agent</span>}
            <button type="button" className={css.icon} aria-label={`Close ${entry.title}`} onClick={() => { void act({ action: 'close', id: entry.id }) }}>
              <IconCloseOutlineRegular />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className={css.newTab} onClick={onNewTab}><IconPlusOutlineRegular />New tab<span className={css.menuKeys}>Ctrl+T</span></button>
    </MenuSurface>
  )
}

/** El paso a paso del agente en el navegador en todos los turnos del chat, bajo la barra (oculto hasta pulsar la flecha). */
function StepsPopover({ sessionId, onClose }: { sessionId: string; onClose: () => void }): ReactNode {
  const turns = useSyncExternalStore(subscribeLive, () => sessionTurns(sessionId))
  const groups = turns.filter(entry => (entry.browser?.length ?? 0) > 0)
  const count = groups.reduce((total, entry) => total + (entry.browser?.length ?? 0), 0)
  const box = useRef<HTMLDivElement | null>(null)
  const list = useRef<HTMLOListElement | null>(null)
  usePopoverDismiss(box, onClose, '[data-browser-steps]')
  useLayoutEffect(() => {
    if (list.current !== null) list.current.scrollTop = list.current.scrollHeight
  }, [count])
  return (
    <MenuSurface ref={box} className={css.popover} data-kind="steps" role="dialog" aria-label="The agent's steps in the browser">
      <div className={css.stepsHead}><span>Agent steps</span><span>{String(count)}</span></div>
      <ol ref={list} className={css.steps}>
        {groups.map(entry => [
          groups.length > 1 && <li key={`turn-${String(entry.turn)}`} className={css.stepTurn}>{`Turn ${String(entry.turn)}${entry.running ? ' · now' : ''}`}</li>,
          ...(entry.browser ?? []).map(step => (
            <li key={step.callId} className={css.step} data-status={step.status}>
              <span className={css.stepDot} />
              <span className={css.stepText}>{browserStepText(step)}</span>
            </li>
          )),
        ])}
      </ol>
    </MenuSurface>
  )
}

/** Cierra una ventanita al pulsar fuera (salvo en su propio botón, que ya la alterna) o con Escape. */
function usePopoverDismiss(box: { current: HTMLElement | null }, onClose: () => void, trigger: string): void {
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    const down = (event: PointerEvent): void => {
      if (!(event.target instanceof Element)) return
      // El botón que la abrió la cierra él mismo: sin esto se cerraría y se volvería a abrir.
      if (box.current?.contains(event.target) === true || event.target.closest(trigger) !== null) return
      onClose()
    }
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', down, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', down, true)
    }
  }, [box, onClose, trigger])
}

/** La llave: contraseñas guardadas (bloqueadas con Windows) y webs con sesión iniciada. */
function KeysPopover({ onClose }: { onClose: () => void }): ReactNode {
  const box = useRef<HTMLDivElement | null>(null)
  const [section, setSection] = useState<'passwords' | 'sites'>('passwords')
  usePopoverDismiss(box, onClose, '[data-browser-keys]')
  return (
    <MenuSurface ref={box} className={css.popover} data-kind="keys" role="dialog" aria-label="Passwords and sign-ins">
      <SegmentedControl id="local-browser-keys" label="Passwords and sign-ins" value={section} onChange={setSection}
        className={css.segments}
        options={[{ value: 'passwords', label: 'Passwords' }, { value: 'sites', label: 'Signed-in sites' }]} />
      <div id={`local-browser-keys-${section}-panel`} role="tabpanel" aria-labelledby={`local-browser-keys-${section}`}>
        {section === 'passwords' ? <SavedPasswords /> : <SignedInSites />}
      </div>
    </MenuSurface>
  )
}

/** Webs con sesión iniciada en el navegador, para cerrar la que ya no quieras. */
function SignedInSites(): ReactNode {
  const [sites, setSites] = useState<readonly Site[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = async (): Promise<void> => {
    if (localCtx === undefined) return
    try {
      setSites(unwrap(await localCtx.remote.session.localAgentBrowserSites({})).sites)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }
  useEffect(() => { void load() }, [])
  const forget = async (domain: string): Promise<void> => {
    if (localCtx === undefined) return
    setBusy(domain)
    setError(null)
    try {
      unwrap(await localCtx.remote.session.localAgentBrowserForget({ domain }))
      await load()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className={css.section}>
      <p className={css.hint}>Sites where this browser keeps you signed in. Remove one to sign it out.</p>
      {sites === null && error === null && <p className={css.hint}>Loading…</p>}
      {sites !== null && sites.length === 0 && <p className={css.hint}>None yet.</p>}
      {sites !== null && sites.length > 0 && (
        <ul className={css.rows}>
          {sites.map(site => (
            <li key={site.domain} className={css.row}>
              <span className={css.rowName}>{site.domain}</span>
              <button type="button" className={css.remove} disabled={busy !== null} onClick={() => { void forget(site.domain) }}>
                {busy === site.domain ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== null && <p className={css.error}>{error}</p>}
    </div>
  )
}

/** Cómo se desbloquean las contraseñas en este PC (se pregunta una vez). */
let unlockMethod: Promise<'hello' | 'password'> | undefined

/**
 * Contraseñas para el navegador, guardadas cifradas en este PC. Bloqueadas hasta confirmar con Windows Hello o la
 * contraseña de Windows: el agente puede usarlas por su nombre igualmente (escribe el nombre y el navegador pone el
 * valor; nunca lo ve), y solo en su web. Se exportan e importan en un fichero cifrado con una frase de paso.
 */
function SavedPasswords(): ReactNode {
  const [state, setState] = useState<{ locked: boolean; count: number; secrets: readonly Secret[] } | null>(null)
  const [method, setMethod] = useState<'hello' | 'password'>('password')
  const [name, setName] = useState('')
  const [site, setSite] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [backup, setBackup] = useState<'export' | 'import' | null>(null)
  const load = async (): Promise<void> => {
    if (localCtx === undefined) return
    try {
      setState(unwrap(await localCtx.remote.session.localAgentBrowserSecrets({})))
    } catch (reason) {
      setMessage({ kind: 'error', text: messageOf(reason) })
    }
  }
  useEffect(() => {
    void load()
    if (localCtx === undefined) return
    const ctx = localCtx
    const known = unlockMethod ??= ctx.remote.session.localAgentBrowserUnlockMethod({}).then(result => result.ok ? result.value.method : 'password')
      .catch(() => 'password' as const)
    void known.then(setMethod)
  }, [])
  const run = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      await task()
    } catch (reason) {
      setMessage({ kind: 'error', text: messageOf(reason) })
      await load()
    } finally {
      setBusy(false)
    }
  }
  const unlock = (): Promise<void> => run(async () => {
    if (localCtx === undefined) return
    const result = unwrap(await localCtx.remote.session.localAgentBrowserUnlock({}))
    if (!result.unlocked && result.message !== undefined) setMessage({ kind: 'error', text: result.message })
    await load()
  })
  const save = (): Promise<void> => run(async () => {
    if (localCtx === undefined) return
    const saved = unwrap(await localCtx.remote.session.localAgentBrowserSaveSecret({ name, site, value }))
    setValue('')
    setName('')
    setSite('')
    setMessage({ kind: 'ok', text: `Saved as ${saved.name}. New chats can use it on ${site.trim()}.` })
    await load()
  })
  const remove = (secret: string): Promise<void> => run(async () => {
    if (localCtx === undefined) return
    unwrap(await localCtx.remote.session.localAgentBrowserRemoveSecret({ name: secret }))
    await load()
  })
  const hello = method === 'hello'
  if (state === null) return <div className={css.section}><p className={css.hint}>{message?.text ?? 'Loading…'}</p></div>
  if (state.locked) {
    return (
      <div className={css.locked}>
        <LockIcon />
        <div className={css.lockedTitle}>Saved passwords are locked</div>
        <p className={css.hint}>
          {hello ? 'Confirm it\'s you with Windows Hello to see or change them.' : 'Confirm it\'s you with your Windows password to see or change them.'}
          {' '}The agent can still use them by name, each on its own site.
          {state.count > 0 ? ` ${String(state.count)} saved.` : ''}
        </p>
        <button type="button" className={css.primary} disabled={busy} onClick={() => { void unlock() }} data-browser-unlock>
          <ShieldIcon />{busy ? 'Waiting for Windows…' : hello ? 'Unlock with Windows Hello' : 'Unlock with Windows'}
        </button>
        {message !== null && <p className={message.kind === 'error' ? css.error : css.okNote}>{message.text}</p>}
      </div>
    )
  }
  return (
    <div className={css.section}>
      {state.secrets.length > 0 && (
        <ul className={css.rows}>
          {state.secrets.map(secret => (
            <li key={secret.name} className={css.row}>
              <span className={css.rowName}>{secret.name}
                <span className={css.rowSite} data-missing={secret.site === '' || undefined}> · {secret.site === '' ? 'no site: the agent cannot use it' : secret.site}</span>
              </span>
              <button type="button" className={css.remove} disabled={busy} onClick={() => { void remove(secret.name) }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className={css.secretForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
        <input className={css.field} placeholder="Name (e.g. Work admin password)" value={name} onChange={(event) => { setName(event.target.value) }} aria-label="Password name" />
        <input className={css.field} placeholder="Site where it's used (e.g. example.com)" value={site} onChange={(event) => { setSite(event.target.value) }} aria-label="Site" />
        <input className={css.field} type="password" autoComplete="new-password" placeholder="Password" value={value} onChange={(event) => { setValue(event.target.value) }} aria-label="Password" />
        <button type="submit" className={css.primary} disabled={busy || name.trim() === '' || site.trim() === '' || value === ''}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
      <p className={css.hint}>
        Encrypted on this PC. The agent types the name and the browser fills in the password, only on its site. Locks again when
        you hide the window or after 5 minutes.
      </p>
      <div className={css.backupActions}>
        <button type="button" className={css.link} aria-expanded={backup === 'export'} disabled={state.count === 0}
          onClick={() => { setBackup(backup === 'export' ? null : 'export'); setMessage(null) }}>Export…</button>
        <button type="button" className={css.link} aria-expanded={backup === 'import'}
          onClick={() => { setBackup(backup === 'import' ? null : 'import'); setMessage(null) }}>Import…</button>
      </div>
      {backup !== null && (
        <PasswordsBackup mode={backup} busy={busy} run={run}
          onDone={(text) => { setBackup(null); setMessage({ kind: 'ok', text }); void load() }} />
      )}
      {message !== null && <p className={message.kind === 'error' ? css.error : css.okNote}>{message.text}</p>}
    </div>
  )
}

/** Exportar (a un fichero cifrado con una frase de paso) o importar las contraseñas guardadas. */
function PasswordsBackup({ mode, busy, run, onDone }: {
  mode: 'export' | 'import'
  busy: boolean
  run: (task: () => Promise<void>) => Promise<void>
  onDone: (text: string) => void
}): ReactNode {
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const ready = mode === 'export' ? passphrase.length >= 8 && passphrase === repeat : passphrase !== '' && file !== null
  const go = (): Promise<void> => run(async () => {
    if (localCtx === undefined) return
    if (mode === 'export') {
      const result = unwrap(await localCtx.remote.session.localAgentBrowserExportSecrets({ passphrase }))
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([result.file], { type: 'application/json' }))
      link.download = `browser-passwords-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      setTimeout(() => { URL.revokeObjectURL(link.href) }, 10_000)
      onDone(`${String(result.count)} ${result.count === 1 ? 'password' : 'passwords'} exported. Keep the passphrase: without it the file cannot be opened.`)
      return
    }
    if (file === null) return
    const result = unwrap(await localCtx.remote.session.localAgentBrowserImportSecrets({ file: await file.text(), passphrase }))
    onDone(`${String(result.count)} ${result.count === 1 ? 'password' : 'passwords'} imported.`)
  })
  return (
    <form className={css.secretForm} data-browser-backup={mode} onSubmit={(event) => { event.preventDefault(); if (ready) void go() }}>
      {mode === 'import' && (
        <input className={css.field} type="file" accept=".json,application/json" aria-label="Backup file"
          onChange={(event) => { setFile(event.target.files?.[0] ?? null) }} />
      )}
      <input className={css.field} type="password" autoComplete="new-password" placeholder={mode === 'export' ? 'Passphrase (8 characters or more)' : 'Passphrase of the backup'}
        value={passphrase} onChange={(event) => { setPassphrase(event.target.value) }} aria-label="Passphrase" />
      {mode === 'export' && (
        <input className={css.field} type="password" autoComplete="new-password" placeholder="Repeat the passphrase"
          value={repeat} onChange={(event) => { setRepeat(event.target.value) }} aria-label="Repeat the passphrase" />
      )}
      <button type="submit" className={css.primary} disabled={busy || !ready}>
        {busy ? 'Working…' : mode === 'export' ? 'Export encrypted file' : 'Import passwords'}
      </button>
    </form>
  )
}

/** Iconos que la app no trae (mismo trazo que los suyos: 1.5 px, puntas redondeadas). */
function KeyIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6.5" cy="13.5" r="3.5" /><path d="M9 11l7.5-7.5M14 6l2 2M12 8l1.5 1.5" />
    </svg>
  )
}

function EyeIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" /><circle cx="10" cy="10" r="2.5" />
    </svg>
  )
}

/** Dos pestañas superpuestas con el número de las abiertas. */
function TabsIcon({ count }: { count: number }): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5h9.5A1.5 1.5 0 0 1 17 5v9.5" />
      <rect x="3" y="6" width="11" height="11" rx="1.5" />
      {count > 0 && <text x="8.5" y="14.6" textAnchor="middle" fontSize="7.5" fontWeight="600" fill="currentColor" stroke="none">{count > 9 ? '9+' : String(count)}</text>}
    </svg>
  )
}

function LockIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={css.lockIcon}>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2" />
    </svg>
  )
}

function ShieldIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2.5l6 2.2v4.6c0 3.9-2.6 6.6-6 8.2-3.4-1.6-6-4.3-6-8.2V4.7z" /><path d="M7.5 10l1.8 1.8 3.4-3.6" />
    </svg>
  )
}

/** Cuatro esquinas alrededor de un recuadro: ajustar la vista. */
function FitIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13" />
      <rect x="7" y="7" width="6" height="6" rx="1" />
    </svg>
  )
}

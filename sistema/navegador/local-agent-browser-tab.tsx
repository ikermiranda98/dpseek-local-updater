/**
 * Navegador compartido del agente y del usuario, lado del panel derecho (añadido por dpseek-local-updater).
 *
 * Sustituye a la pestaña «Browser» de la app (mismo tipo, `browser`): los enlaces del chat se abren aquí. Enseña en
 * directo el Edge que usa el agente (fotogramas que da el Host, local-agent-browser.ts, en cuanto la página cambia) con
 * su barra: atrás, adelante, recargar, «Fix the view» (vuelve a la página de verdad, no a una ventana emergente, con el
 * tamaño del panel) y dirección editable, con una etiqueta de quién lo maneja («Agent» o «You»).
 *
 * El usuario usa la página directamente: al pulsar, desplazar o escribir en ella toma el control (borde ámbar, «You» y
 * una píldora «You're browsing — the agent waits · Resume agent»); mientras, las acciones del agente en el navegador
 * esperan. El control vuelve al agente con «Resume agent», al mandar un mensaje en el chat o tras un rato sin tocarla.
 * Lo que se escribe va directo a la página por el Host, nunca al chat ni al modelo.
 *
 * La página se adapta sola al panel, como una ventana de navegador (su tamaño y la densidad de la pantalla). Al
 * redimensionar, la imagen se escala al momento y la página se recoloca como mucho cada 100 ms; mientras el panel se
 * desliza al abrirse o cerrarse, no se cambia nada (como el resto de animaciones de la app).
 *
 * La flecha junto a la dirección despliega el paso a paso del agente (oculto por defecto). La llave abre las contraseñas
 * guardadas (bloqueadas hasta confirmar la contraseña de Windows) y las webs con sesión iniciada.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  GuideArtworkBrowser, IconChevronDownOutlineRegular, IconGlobeOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconRefreshOutlineRegular, MenuSurface, SegmentedControl, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { browserStepText, liveSnapshot, onBrowserOpen, subscribeLive } from './local-live-store.ts'
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
}

/** Un gesto para la página (posiciones de 0 a 1 sobre la imagen), como lo espera el Host. */
type Gesture =
  | {
    readonly kind: 'mouse'; readonly type: 'down' | 'up' | 'move'; readonly x: number; readonly y: number
    readonly button: 'left' | 'right' | 'middle' | 'none'; readonly buttons: number; readonly clickCount: number; readonly modifiers: number
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

let localCtx: Context | undefined
/** El último fotograma, para que la pestaña se vea al momento al volver a montarse (sin «cargando»). */
let lastFrame: Frame | undefined
/** Navegaciones ya atendidas por pestaña (los enlaces del chat), para no repetirlas al volver a montarla. */
const handledNavigation = new Map<string, number>()

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
      id: 'shared-browser', order: 30, icon: GuideArtworkBrowser,
      title: () => 'Browser',
      description: () => 'Browse the web together with the agent',
    }],
  }), 'local: shared browser type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: BROWSER_ID },
    BrowserTab,
  )), 'local: shared browser body')
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
      if (right.openTabIn) right.openTabIn(sessionId as SessionId, BROWSER_KIND)
      else right.openTab(BROWSER_KIND)
    } catch (error) {
      console.warn('local shared browser:', error)
    }
  }), 'local: shared browser open')
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
    let stopped = false
    const loop = async (): Promise<void> => {
      while (!stopped) {
        let next: Frame | undefined
        try {
          if (localCtx !== undefined && document.visibilityState === 'visible') {
            next = unwrap(await localCtx.remote.session.localAgentBrowserFrame({ after: lastFrame?.image == null ? 0 : lastFrame.seq }))
          }
        } catch {
          // Sin Host o sin respuesta: se vuelve a intentar.
        }
        if (stopped) return
        if (next !== undefined) {
          const kept = next.image === null && next.running && lastFrame?.image != null ? { ...next, image: lastFrame.image, seq: lastFrame.seq } : next
          lastFrame = kept
          setFrame(kept)
        }
        if (next?.running !== true) await new Promise(resolve => setTimeout(resolve, IDLE_MS))
      }
    }
    void loop()
    return () => { stopped = true }
  }, [visible])
  return frame
}

/** Modificadores como los cuenta el protocolo de depuración: Alt 1, Ctrl 2, Meta 4, Mayús 8. */
const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

/**
 * Cola de gestos hacia la página: en orden, uno tras otro, y los movimientos del ratón sin acumularse (si hay uno
 * esperando, el nuevo lo sustituye).
 */
function useGestureQueue(onError: (message: string) => void): (gesture: Gesture) => void {
  const queue = useRef<Gesture[]>([])
  const busy = useRef(false)
  const pump = useCallback(async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      for (let gesture = queue.current.shift(); gesture !== undefined; gesture = queue.current.shift()) {
        try {
          if (localCtx !== undefined) unwrap(await localCtx.remote.session.localAgentBrowserInput({ input: gesture }))
        } catch (error) {
          onError(messageOf(error))
        }
      }
    } finally {
      busy.current = false
    }
  }, [onError])
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

const BUTTONS = ['left', 'middle', 'right'] as const

function BrowserTab({ useTabInfo, sessionId }: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const { tab, sidebar } = useTabInfo()
  const visible = tab.visible
  const frame = useFrames(visible)
  const running = frame?.running === true
  const [viewElement, setViewElement] = useState<HTMLDivElement | null>(null)
  const view = useRef<HTMLDivElement | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const area = useViewSize(viewElement)
  const live = useSyncExternalStore(subscribeLive, () => liveSnapshot(sessionId))
  const steps = live?.browser ?? []
  const [error, setError] = useState<string | null>(null)
  const send = useGestureQueue(setError)
  // El aviso de error se va solo.
  useEffect(() => {
    if (error === null) return
    const timer = setTimeout(() => { setError(null) }, 6000)
    return () => { clearTimeout(timer) }
  }, [error])

  // Quién maneja la página: lo que diga el Host, salvo justo después de un cambio hecho aquí (llega con retraso).
  const [control, setControlState] = useState(frame?.control === true)
  const changedAt = useRef(0)
  useEffect(() => {
    if (frame !== undefined && Date.now() - changedAt.current > 1500) setControlState(frame.control)
  }, [frame])
  const markControl = (active: boolean): void => {
    changedAt.current = Date.now()
    setControlState(active)
  }
  const resume = async (): Promise<void> => {
    markControl(false)
    try {
      if (localCtx !== undefined) unwrap(await localCtx.remote.session.localAgentBrowserControl({ active: false }))
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
      void localCtx.remote.session.localAgentBrowserViewport({ width: area.width, height: area.height, dpr: area.dpr }).catch(() => undefined)
    }
    push()
  }, [area.width, area.height, area.dpr, visible])
  useEffect(() => () => { clearTimeout(sizeTimer.current) }, [])
  // Si la imagen sigue sin cuadrar con el panel (se perdió un cambio de tamaño), se vuelve a pedir. Se mira cada poco:
  // una página quieta no manda fotogramas.
  const areaRef = useRef(area)
  areaRef.current = area
  useEffect(() => {
    if (!visible || !running) return
    const timer = setInterval(() => {
      const picture = image.current
      const now = areaRef.current
      if (picture === null || picture.naturalWidth === 0 || now.width < 50 || localCtx === undefined) return
      // Con los mismos límites que pone el Host (página de 320 × 240 como mínimo, densidad de 1 a 3).
      const dpr = Math.min(3, Math.max(1, now.dpr))
      const off = Math.abs(picture.naturalWidth / dpr - Math.max(320, now.width)) > 3 || Math.abs(picture.naturalHeight / dpr - Math.max(240, now.height)) > 3
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
      void localCtx.remote.session.localAgentBrowserViewport({ width: area.width, height: area.height, dpr: area.dpr }).catch(() => undefined)
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

  // Ratón: pulsar toma el control; con él, también se mueve el puntero y se arrastra.
  const pointer = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null)
  const moveFrame = useRef(0)
  const take = (): void => {
    if (!control) markControl(true)
    setError(null)
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    event.preventDefault()
    view.current?.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    take()
    send({
      kind: 'mouse', type: 'down', ...pointOn(event.currentTarget, event.clientX, event.clientY),
      button: BUTTONS[event.button] ?? 'left', buttons: event.buttons, clickCount: Math.max(1, event.detail), modifiers: modifiersOf(event),
    })
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (!control) return
    pointer.current = { ...pointOn(event.currentTarget, event.clientX, event.clientY), buttons: event.buttons, modifiers: modifiersOf(event) }
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
    send({
      kind: 'mouse', type: 'up', ...pointOn(event.currentTarget, event.clientX, event.clientY),
      button: BUTTONS[event.button] ?? 'left', buttons: event.buttons, clickCount: Math.max(1, event.detail), modifiers: modifiersOf(event),
    })
  }
  useEffect(() => () => { cancelAnimationFrame(moveFrame.current) }, [])

  // La rueda desplaza la página (no el panel), agrupada por fotograma de pantalla.
  const controlRef = useRef(control)
  controlRef.current = control
  useEffect(() => {
    const element = view.current
    if (element === null || !running) return
    const wheel = { dx: 0, dy: 0, x: 0, y: 0, modifiers: 0, frame: 0 }
    const onWheel = (event: WheelEvent): void => {
      const picture = image.current
      if (picture === null) return
      event.preventDefault()
      if (!controlRef.current) {
        changedAt.current = Date.now()
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

  // Teclado: el texto se agrupa (una llamada por ráfaga, no por letra); las demás teclas van una a una.
  const typed = useRef('')
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flush = (): void => {
    clearTimeout(flushTimer.current)
    if (typed.current === '') return
    const text = typed.current
    typed.current = ''
    send({ kind: 'text', text })
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!running || event.target !== event.currentTarget) return
    // Ctrl+V lo atiende el evento de pegar (con el texto del portapapeles).
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return
    event.preventDefault()
    take()
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typed.current += event.key
      clearTimeout(flushTimer.current)
      flushTimer.current = setTimeout(flush, 40)
      return
    }
    flush()
    send({ kind: 'key', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiersOf(event) })
  }

  const [stepsOpen, setStepsOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const shownUrl = address ?? frame?.url ?? ''
  const who = control ? 'you' : live?.running === true && steps.length > 0 ? 'agent' : undefined
  return (
    <div className={css.root} data-agent-browser data-control={control || undefined}>
      <div className={css.header}>
        <Tooltip label="Back" side="bottom" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Back" disabled={frame?.canGoBack !== true}
            onClick={() => { void navigate({ action: 'back' }) }}><IconChevronLeftOutlineRegular /></button>
        </Tooltip>
        <Tooltip label="Forward" side="bottom" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Forward" disabled={frame?.canGoForward !== true}
            onClick={() => { void navigate({ action: 'forward' }) }}><IconChevronRightOutlineRegular /></button>
        </Tooltip>
        <Tooltip label="Reload" side="bottom" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Reload" disabled={!running}
            onClick={() => { void navigate({ action: 'reload' }) }}><IconRefreshOutlineRegular /></button>
        </Tooltip>
        <Tooltip label="Fix the view" side="bottom" delayMs={500}>
          <button type="button" className={css.icon} aria-label="Fix the view" disabled={!running || repairing} data-browser-repair
            onClick={() => { void repair() }}><FitIcon /></button>
        </Tooltip>
        <form className={css.address} onSubmit={submit} data-who={who}>
          {who !== undefined && <span className={css.who} data-who={who}>{who === 'you' ? 'You' : 'Agent'}</span>}
          <input className={css.addressInput} value={shownUrl} placeholder="Search or type an address" aria-label="Address"
            spellCheck={false} autoComplete="off"
            onFocus={(event) => { event.currentTarget.select() }}
            onChange={(event) => { setAddress(event.target.value) }}
            onBlur={() => { setAddress(null) }}
            onKeyDown={(event) => { if (event.key === 'Escape') { setAddress(null); event.currentTarget.blur() } }} />
        </form>
        {steps.length > 0 && (
          <Tooltip label="The agent's steps" side="bottom" delayMs={500} disabled={stepsOpen}>
            <button type="button" className={css.icon} aria-label="The agent's steps" aria-expanded={stepsOpen} data-browser-steps
              onClick={() => { setStepsOpen(open => !open) }}>
              <IconChevronDownOutlineRegular className={css.chevron} />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Passwords and sign-ins" side="bottom" delayMs={500} disabled={keysOpen}>
          <button type="button" className={css.icon} aria-label="Passwords and sign-ins" aria-expanded={keysOpen} data-browser-keys
            onClick={() => { setKeysOpen(open => !open) }}><KeyIcon /></button>
        </Tooltip>
        {stepsOpen && steps.length > 0 && <StepsPopover sessionId={sessionId} onClose={() => { setStepsOpen(false) }} />}
        {keysOpen && <KeysPopover onClose={() => { setKeysOpen(false) }} />}
      </div>
      <div ref={(element) => { view.current = element; setViewElement(element) }} className={css.view}
        data-control={control || undefined} tabIndex={running ? 0 : -1}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          if (!running) return
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          take()
          flush()
          if (text !== '') send({ kind: 'text', text })
        }}>
        {running && frame?.image != null && frame.url !== 'about:blank'
          ? <img ref={image} className={css.image} src={`data:image/jpeg;base64,${frame.image}`} alt={frame.title} draggable={false}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onContextMenu={(event) => { event.preventDefault() }} />
          : (
            <p className={css.empty}>
              {running && frame?.url !== 'about:blank' ? 'Loading the page…' : 'Nothing open yet. Type an address above, or ask the agent to visit a site.'}
            </p>
          )}
        {control && running && (
          <div className={css.pill} role="status">
            <span className={css.pillDot} />
            <span>You're browsing — the agent waits</span>
            <button type="button" className={css.pillAction} onClick={() => { void resume() }}>
              <PlayIcon />Resume agent
            </button>
          </div>
        )}
        {error !== null && <p className={css.toast} role="alert" onClick={() => { setError(null) }}>{error}</p>}
      </div>
    </div>
  )
}

/** El paso a paso del agente en el navegador, bajo la barra (oculto hasta pulsar la flecha). */
function StepsPopover({ sessionId, onClose }: { sessionId: string; onClose: () => void }): ReactNode {
  const live = useSyncExternalStore(subscribeLive, () => liveSnapshot(sessionId))
  const steps = live?.browser ?? []
  const box = useRef<HTMLDivElement | null>(null)
  const list = useRef<HTMLOListElement | null>(null)
  usePopoverDismiss(box, onClose, '[data-browser-steps]')
  useLayoutEffect(() => {
    if (list.current !== null) list.current.scrollTop = list.current.scrollHeight
  }, [steps.length])
  return (
    <MenuSurface ref={box} className={css.popover} data-kind="steps" role="dialog" aria-label="The agent's steps in the browser">
      <div className={css.stepsHead}><span>Agent steps</span><span>{String(steps.length)}</span></div>
      <ol ref={list} className={css.steps}>
        {steps.map(step => (
          <li key={step.callId} className={css.step} data-status={step.status}>
            <span className={css.stepDot} />
            <span className={css.stepText}>{browserStepText(step)}</span>
          </li>
        ))}
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

/**
 * Contraseñas para el navegador, guardadas cifradas en este PC. Bloqueadas hasta confirmar la contraseña de Windows:
 * el agente puede usarlas por su nombre igualmente (escribe el nombre y el navegador pone el valor; nunca lo ve).
 */
function SavedPasswords(): ReactNode {
  const [state, setState] = useState<{ locked: boolean; count: number; secrets: readonly Secret[] } | null>(null)
  const [name, setName] = useState('')
  const [site, setSite] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const load = async (): Promise<void> => {
    if (localCtx === undefined) return
    try {
      setState(unwrap(await localCtx.remote.session.localAgentBrowserSecrets({})))
    } catch (reason) {
      setMessage({ kind: 'error', text: messageOf(reason) })
    }
  }
  useEffect(() => { void load() }, [])
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
    setMessage({ kind: 'ok', text: `Saved as ${saved.name}. New chats can use it.` })
    await load()
  })
  const remove = (secret: string): Promise<void> => run(async () => {
    if (localCtx === undefined) return
    unwrap(await localCtx.remote.session.localAgentBrowserRemoveSecret({ name: secret }))
    await load()
  })
  if (state === null) return <div className={css.section}><p className={css.hint}>{message?.text ?? 'Loading…'}</p></div>
  if (state.locked) {
    return (
      <div className={css.locked}>
        <LockIcon />
        <div className={css.lockedTitle}>Saved passwords are locked</div>
        <p className={css.hint}>
          Confirm it's you with your Windows password to see or change them. The agent can still use them by name.
          {state.count > 0 ? ` ${String(state.count)} saved.` : ''}
        </p>
        <button type="button" className={css.primary} disabled={busy} onClick={() => { void unlock() }} data-browser-unlock>
          <ShieldIcon />{busy ? 'Waiting for Windows…' : 'Unlock with Windows'}
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
              <span className={css.rowName}>{secret.name}{secret.site === '' ? '' : <span className={css.rowSite}> · {secret.site}</span>}</span>
              <button type="button" className={css.remove} disabled={busy} onClick={() => { void remove(secret.name) }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className={css.secretForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
        <input className={css.field} placeholder="Name (e.g. Work admin password)" value={name} onChange={(event) => { setName(event.target.value) }} aria-label="Password name" />
        <input className={css.field} placeholder="Site (e.g. example.com)" value={site} onChange={(event) => { setSite(event.target.value) }} aria-label="Site" />
        <input className={css.field} type="password" autoComplete="new-password" placeholder="Password" value={value} onChange={(event) => { setValue(event.target.value) }} aria-label="Password" />
        <button type="submit" className={css.primary} disabled={busy || name.trim() === '' || value === ''}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
      <p className={css.hint}>Encrypted on this PC; the agent types the name and the browser fills in the password. Locks again when you hide the window or after 5 minutes.</p>
      {message !== null && <p className={message.kind === 'error' ? css.error : css.okNote}>{message.text}</p>}
    </div>
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

function PlayIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M6 4.5v11l9-5.5z" /></svg>
  )
}

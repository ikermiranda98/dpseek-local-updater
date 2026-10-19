/**
 * Navegador del agente, lado del panel derecho (añadido por dpseek-local-updater).
 *
 * Pestaña «Agent browser»: la página que está usando el agente, en directo (imágenes del Edge del agente que da el
 * Host, local-agent-browser.ts), y debajo el paso a paso del turno (lo publica el chat, local-live-watch.tsx: abrir,
 * leer, pulsar, rellenar…; nunca lo que escribe en un campo). «Saved sign-ins» enseña las webs con sesión guardada
 * en el perfil del agente y deja borrar cada una. Se abre con «View browser» en la línea de estado del turno, o desde
 * la guía de la barra lateral.
 *
 * «Take control»: el usuario usa la página desde la imagen (clic, rueda, teclado y pegar) para iniciar sesión, meter
 * un código o resolver un captcha; mientras, las acciones del agente en el navegador esperan. Lo que se escribe va
 * directo a la página por el Host, nunca al chat ni al modelo.
 *
 * La imagen ocupa todo el sitio del panel (sin deformarse) y llega con sus píxeles justos (los del panel por la
 * densidad de la pantalla), así que se ve nítida al cambiar el tamaño de la ventana o de pantalla. El menú de tamaño
 * cambia la página: ajustada al panel, escritorio, pantalla ancha, tableta o móvil.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { IconGlobeOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { liveSnapshot, onBrowserOpen, subscribeLive, type LiveBrowserStep } from './local-live-store.ts'
import css from './local-agent-browser-tab.module.css'

/** Tipo de pestaña y su identidad en el sistema de pestañas. */
export const BROWSER_KIND = 'local-agent-browser'
const BROWSER_ID = 'dpseek-local-updater/agent-browser'
/** Imágenes por segundo mientras el navegador está en marcha (y si no, una comprobación cada dos segundos). */
const FRAME_MS = 400
const IDLE_MS = 2000
/** Con el usuario a los mandos, más seguidas para que se note lo que hace. */
const CONTROL_MS = 200

interface Frame {
  readonly running: boolean
  readonly url: string
  readonly title: string
  readonly image: string | null
  readonly control: boolean
  readonly viewport: { readonly width: number; readonly height: number }
  readonly mode: Mode
}

/** Tamaños de página que ofrece el menú. */
type Mode = 'fit' | 'desktop' | 'wide' | 'tablet' | 'mobile'
const MODES: readonly { readonly id: Mode; readonly label: string; readonly hint: string }[] = [
  { id: 'fit', label: 'Fit to panel', hint: 'The page takes the size of this panel' },
  { id: 'desktop', label: 'Desktop', hint: '1280 × 800' },
  { id: 'wide', label: 'Wide screen', hint: '1920 × 1080' },
  { id: 'tablet', label: 'Tablet', hint: '768 × 1024' },
  { id: 'mobile', label: 'Mobile', hint: '375 × 812, touch' },
]
const MODE_KEY = 'dpseek-local-updater.agent-browser.mode'
const readMode = (): Mode => {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    return MODES.some(mode => mode.id === saved) ? saved as Mode : 'desktop'
  } catch {
    return 'desktop'
  }
}

/** El sitio para la imagen, en píxeles CSS, y la densidad de la pantalla (cambia al moverla a otro monitor). */
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

/** Un gesto para la página (posiciones de 0 a 1 sobre la imagen), como lo espera el Host. */
type Gesture =
  | { readonly kind: 'click'; readonly x: number; readonly y: number; readonly button: 'left' | 'right' | 'middle'; readonly clickCount: number }
  | { readonly kind: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
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

/**
 * Registra la pestaña, su cuerpo y su apertura desde el chat.
 * @param ctx - contexto del plugin de entregables.
 */
export function setLocalAgentBrowser(ctx: Context): void {
  localCtx = ctx
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    // En la barra de pestañas cabe poco: «Browser»; en la guía, el nombre completo.
    title: () => 'Browser',
    guide: [{
      id: 'agent-browser', order: 16, icon: IconGlobeOutlineRegular,
      title: () => 'Agent browser',
      description: () => 'What the agent sees and does in its browser',
    }],
  }), 'local: agent browser type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: BROWSER_ID },
    AgentBrowserTab,
  )), 'local: agent browser body')
  ctx.effect(() => onBrowserOpen((sessionId) => {
    const right = ctx.sidebarRight as typeof ctx.sidebarRight & {
      openTabIn?: (sessionId: SessionId, kind: string) => void
    }
    try {
      if (right.openTabIn) right.openTabIn(sessionId as SessionId, BROWSER_KIND)
      else right.openTab(BROWSER_KIND)
    } catch (error) {
      console.warn('local agent browser:', error)
    }
  }), 'local: agent browser open')
}

const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Cómo se dice cada paso, en pocas palabras. */
function stepText(step: LiveBrowserStep): string {
  const on = step.detail === '' ? '' : ` ${step.detail}`
  switch (step.action) {
    case 'navigate': return `Opened${on}`
    case 'navigate_back': return 'Went back'
    case 'snapshot': return 'Read the page'
    case 'click': return `Clicked${on}`
    case 'hover': return `Hovered${on}`
    case 'type': return `Typed in${on}`
    case 'fill_form': return 'Filled in the form'
    case 'select_option': return `Chose an option in${on}`
    case 'press_key': return `Pressed${on}`
    case 'wait_for': return step.detail === '' ? 'Waited' : `Waited for «${step.detail}»`
    case 'take_screenshot': return 'Took a screenshot'
    case 'tabs': return `Tabs: ${step.detail}`
    case 'close': return 'Closed the page'
    case 'evaluate': case 'run_code_unsafe': return 'Ran a script on the page'
    case 'file_upload': return 'Uploaded a file'
    case 'find': return step.detail === '' ? 'Searched the page' : `Searched the page for «${step.detail}»`
    case 'network_requests': return 'Checked the network requests'
    case 'network_request': return 'Read a network request'
    case 'console_messages': return 'Read the console'
    case 'handle_dialog': return 'Answered a dialog'
    case 'drag': return `Dragged${on}`
    case 'resize': return 'Resized the window'
    default: return `${step.action.replace(/_/g, ' ')}${on}`
  }
}

/** La imagen en directo: se piden mientras la pestaña está a la vista. */
function useFrame(wanted: { width: number; height: number; dpr: number }): [Frame | undefined, () => void] {
  const [frame, setFrame] = useState<Frame | undefined>(undefined)
  const kick = useRef<() => void>(() => undefined)
  const size = useRef(wanted)
  size.current = wanted
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    kick.current = () => {
      clearTimeout(timer)
      void tick()
    }
    const tick = async (): Promise<void> => {
      let next: Frame | undefined
      try {
        if (localCtx !== undefined && document.visibilityState === 'visible') {
          // Los píxeles justos del sitio de la imagen (como mínimo los de una ventana pequeña, para que no salga borrosa).
          const { width, height, dpr } = size.current
          next = unwrap(await localCtx.remote.session.localAgentBrowserFrame({
            width: Math.max(320, Math.round(width * dpr)), height: Math.max(240, Math.round(height * dpr)),
          }))
          if (!stopped) setFrame(previous => next?.image === null && previous?.image != null && next.running ? { ...next, image: previous.image } : next)
        }
      } catch {
        // Sin Host o sin respuesta: se vuelve a intentar.
      }
      if (!stopped) {
        clearTimeout(timer)
        timer = setTimeout(() => { void tick() }, next?.control === true ? CONTROL_MS : next?.running === true ? FRAME_MS : IDLE_MS)
      }
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])
  return [frame, () => { kick.current() }]
}

/** Modificadores como los cuenta el protocolo de depuración: Alt 1, Ctrl 2, Meta 4, Mayús 8. */
const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

/** Teclado, ratón y pegar sobre la imagen, en orden y con el texto agrupado (una llamada por ráfaga, no por letra). */
function useGestures(onSent: () => void): {
  send: (gesture: Gesture) => void
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
} {
  const chain = useRef<Promise<void>>(Promise.resolve())
  const typed = useRef('')
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const send = (gesture: Gesture): void => {
    chain.current = chain.current
      .then(async () => {
        if (localCtx !== undefined) unwrap(await localCtx.remote.session.localAgentBrowserInput({ input: gesture }))
        onSent()
      })
      .catch((error: unknown) => { console.warn('local agent browser input:', error) })
  }
  const flush = (): void => {
    clearTimeout(flushTimer.current)
    if (typed.current === '') return
    const text = typed.current
    typed.current = ''
    send({ kind: 'text', text })
  }
  const position = (event: ReactMouseEvent<HTMLElement>): { x: number; y: number } => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }
  }
  return {
    send: (gesture) => {
      flush()
      send(gesture)
    },
    onMouseDown: (event) => {
      event.preventDefault()
      event.currentTarget.focus()
      flush()
      const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
      send({ kind: 'click', ...position(event), button, clickCount: Math.max(1, event.detail) })
    },
    onKeyDown: (event) => {
      // Ctrl+V lo atiende el evento de pegar (con el texto del portapapeles).
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
      event.preventDefault()
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typed.current += event.key
        clearTimeout(flushTimer.current)
        flushTimer.current = setTimeout(flush, 60)
        return
      }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
      flush()
      send({ kind: 'key', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiersOf(event) })
    },
  }
}

/** «Saved sign-ins»: webs con sesión guardada en el navegador del agente, para borrar la que ya no quieras. */
function SavedSignIns({ onClose }: { onClose: () => void }): ReactNode {
  const [sites, setSites] = useState<readonly Site[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const load = async (): Promise<void> => {
    if (localCtx === undefined) return
    try {
      setSites(unwrap(await localCtx.remote.session.localAgentBrowserSites({})).sites)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    const down = (event: MouseEvent): void => { if (box.current?.contains(event.target as Node) !== true) onClose() }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  const forget = async (domain: string): Promise<void> => {
    if (localCtx === undefined) return
    setBusy(domain)
    setError(null)
    try {
      unwrap(await localCtx.remote.session.localAgentBrowserForget({ domain }))
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div ref={box} className={css.popover} role="dialog" aria-label="Saved sign-ins">
      <div className={css.popoverTitle}>Saved sign-ins</div>
      <p className={css.popoverHint}>Sites where the agent's browser keeps you signed in. Remove one to sign it out.</p>
      {sites === null && error === null && <p className={css.popoverHint}>Loading…</p>}
      {sites !== null && sites.length === 0 && <p className={css.popoverHint}>None yet.</p>}
      {sites !== null && sites.length > 0 && (
        <ul className={css.sites}>
          {sites.map(site => (
            <li key={site.domain} className={css.site}>
              <span className={css.siteName}>{site.domain}</span>
              <button type="button" className={css.remove} disabled={busy !== null} onClick={() => { void forget(site.domain) }}>
                {busy === site.domain ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== null && <p className={css.error}>{error}</p>}
      <SavedPasswords />
    </div>
  )
}

/**
 * «Saved passwords»: contraseñas para el navegador del agente, guardadas cifradas en este PC. El agente escribe el
 * nombre y el navegador pone el valor: el modelo nunca la ve y no pasa por el chat.
 */
function SavedPasswords(): ReactNode {
  const [secrets, setSecrets] = useState<readonly Secret[] | null>(null)
  const [name, setName] = useState('')
  const [site, setSite] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const load = async (): Promise<void> => {
    if (localCtx === undefined) return
    try {
      setSecrets(unwrap(await localCtx.remote.session.localAgentBrowserSecrets({})).secrets)
    } catch (reason) {
      setMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) })
    }
  }
  useEffect(() => { void load() }, [])
  const save = async (): Promise<void> => {
    if (localCtx === undefined || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const saved = unwrap(await localCtx.remote.session.localAgentBrowserSaveSecret({ name, site, value }))
      setValue('')
      setName('')
      setSite('')
      setMessage({ kind: 'ok', text: `Saved as ${saved.name}. New chats can use it.` })
      await load()
    } catch (reason) {
      setMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setBusy(false)
    }
  }
  const remove = async (secret: string): Promise<void> => {
    if (localCtx === undefined) return
    try {
      unwrap(await localCtx.remote.session.localAgentBrowserRemoveSecret({ name: secret }))
      await load()
    } catch (reason) {
      setMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) })
    }
  }
  return (
    <div className={css.passwords}>
      <div className={css.popoverTitle}>Saved passwords</div>
      <p className={css.popoverHint}>Encrypted on this PC. The agent types the name and the browser fills in the password: it never reaches the chat or the model.</p>
      {secrets !== null && secrets.length > 0 && (
        <ul className={css.sites}>
          {secrets.map(secret => (
            <li key={secret.name} className={css.site}>
              <span className={css.siteName}>{secret.name}{secret.site === '' ? '' : <span className={css.secretSite}> · {secret.site}</span>}</span>
              <button type="button" className={css.remove} onClick={() => { void remove(secret.name) }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className={css.secretForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
        <input className={css.field} placeholder="Name (e.g. Work admin password)" value={name} onChange={(event) => { setName(event.target.value) }} aria-label="Password name" />
        <input className={css.field} placeholder="Site (e.g. example.com)" value={site} onChange={(event) => { setSite(event.target.value) }} aria-label="Site" />
        <input className={css.field} type="password" autoComplete="new-password" placeholder="Password" value={value} onChange={(event) => { setValue(event.target.value) }} aria-label="Password" />
        <button type="submit" className={css.save} disabled={busy || name.trim() === '' || value === ''}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
      {message !== null && <p className={message.kind === 'error' ? css.error : css.okNote}>{message.text}</p>}
    </div>
  )
}

/** Menú de tamaños de página. */
function ModeMenu({ mode, onChoose, onClose }: { mode: Mode; onChoose: (mode: Mode) => void; onClose: () => void }): ReactNode {
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const down = (event: MouseEvent): void => { if (box.current?.contains(event.target as Node) !== true) onClose() }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  return (
    <div ref={box} className={`${css.popover} ${css.modeMenu}`} role="menu" aria-label="Page size">
      {MODES.map(item => (
        <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === mode} className={css.modeItem}
          onClick={() => { onChoose(item.id) }}>
          <span className={css.modeCheck}>{item.id === mode ? '✓' : ''}</span>
          <span className={css.modeLabel}>{item.label}</span>
          <span className={css.modeHint}>{item.hint}</span>
        </button>
      ))}
    </div>
  )
}

function AgentBrowserTab({ sessionId }: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const view = useRef<HTMLDivElement | null>(null)
  const [viewElement, setViewElement] = useState<HTMLDivElement | null>(null)
  const area = useViewSize(viewElement)
  const [frame, refresh] = useFrame(area)
  const live = useSyncExternalStore(subscribeLive, () => liveSnapshot(sessionId))
  const control = frame?.control === true
  const [mode, setMode] = useState<Mode>(readMode)
  const [modeMenu, setModeMenu] = useState(false)
  // El modo (y, ajustada al panel, su tamaño) se le dice al Host; el tamaño, con un poco de espera al redimensionar.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (localCtx === undefined) return
      const fit = mode === 'fit' && area.width > 0 ? { width: area.width, height: area.height, dpr: area.dpr } : undefined
      void localCtx.remote.session.localAgentBrowserViewport({ mode, ...fit === undefined ? {} : { fit } })
        .then(() => { refresh() }).catch(() => undefined)
    }, mode === 'fit' ? 300 : 0)
    return () => { clearTimeout(timer) }
  }, [mode, mode === 'fit' ? area.width : 0, mode === 'fit' ? area.height : 0, mode === 'fit' ? area.dpr : 0])
  const chooseMode = (next: Mode): void => {
    setMode(next)
    setModeMenu(false)
    try { localStorage.setItem(MODE_KEY, next) } catch { /* sin almacenamiento: solo para esta vez */ }
  }
  // La imagen, lo más grande que quepa sin deformarse.
  const aspect = frame === undefined || frame.viewport.height === 0 ? 1280 / 800 : frame.viewport.width / frame.viewport.height
  const shown = area.width === 0 ? undefined : area.width / area.height > aspect
    ? { width: Math.round(area.height * aspect), height: area.height }
    : { width: area.width, height: Math.round(area.width / aspect) }
  const gestures = useGestures(refresh)
  const wheel = useRef<{ dx: number; dy: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | undefined }>({ dx: 0, dy: 0, x: 0, y: 0, timer: undefined })
  const setControl = async (active: boolean): Promise<void> => {
    try {
      if (localCtx !== undefined) unwrap(await localCtx.remote.session.localAgentBrowserControl({ active }))
    } catch (error) {
      console.warn('local agent browser control:', error)
    }
    refresh()
    if (active) view.current?.focus()
  }
  // La rueda se agrupa (una llamada cada ~80 ms) y no desplaza el panel.
  useEffect(() => {
    const element = view.current
    if (element === null || !control) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const image = element.querySelector('img')
      if (image === null) return
      const box = image.getBoundingClientRect()
      const state = wheel.current
      state.dx += event.deltaX
      state.dy += event.deltaY
      state.x = (event.clientX - box.left) / box.width
      state.y = (event.clientY - box.top) / box.height
      if (state.timer !== undefined) return
      state.timer = setTimeout(() => {
        gestures.send({ kind: 'wheel', x: state.x, y: state.y, deltaX: state.dx, deltaY: state.dy })
        state.dx = 0
        state.dy = 0
        state.timer = undefined
      }, 80)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [control, gestures])
  const steps = live?.browser ?? []
  const [saved, setSaved] = useState(false)
  const list = useRef<HTMLOListElement | null>(null)
  // El último paso, siempre a la vista.
  useEffect(() => {
    const element = list.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [steps.length])
  return (
    <div className={css.root} data-agent-browser>
      <div className={css.header}>
        <span className={css.dot} data-running={frame?.running === true || undefined} />
        <Tooltip label={frame?.url ?? ''} side="bottom" delayMs={500} disabled={frame?.url === undefined || frame.url === ''}>
          <span className={css.address}>{frame?.url !== undefined && frame.url !== '' ? frame.url : 'Agent browser'}</span>
        </Tooltip>
        <Tooltip label={control ? 'Let the agent use the browser again' : 'Use the page yourself (to sign in, enter a code or solve a captcha). The agent waits.'} side="bottom" delayMs={500}>
          <button type="button" className={css.tool} data-control={control || undefined} disabled={frame?.running !== true && !control}
            onClick={() => { void setControl(!control) }}>
            {control ? 'Give back to agent' : 'Take control'}
          </button>
        </Tooltip>
        <button type="button" className={css.tool} aria-expanded={modeMenu} aria-haspopup="menu" onClick={() => { setModeMenu(open => !open) }}>
          {MODES.find(item => item.id === mode)?.label ?? 'Desktop'}
          <svg className={css.chevron} viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
        </button>
        {modeMenu && <ModeMenu mode={mode} onChoose={chooseMode} onClose={() => { setModeMenu(false) }} />}
        <button type="button" className={css.tool} aria-expanded={saved} onClick={() => { setSaved(open => !open) }}>Saved sign-ins</button>
        {saved && <SavedSignIns onClose={() => { setSaved(false) }} />}
      </div>
      {control && (
        <p className={css.notice} role="status">
          You're in control and the agent is waiting. What you type goes straight to the page, never to the chat.
        </p>
      )}
      <div ref={(element) => { view.current = element; setViewElement(element) }} className={css.view} data-control={control || undefined} tabIndex={control ? 0 : -1}
        onKeyDown={control ? gestures.onKeyDown : undefined}
        onPaste={control ? (event) => {
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          if (text !== '') gestures.send({ kind: 'text', text })
        } : undefined}>
        {frame?.image != null
          ? <img className={css.image} src={`data:image/webp;base64,${frame.image}`} alt={frame.title} draggable={false}
            style={shown === undefined ? undefined : { width: shown.width, height: shown.height }}
            onMouseDown={control ? gestures.onMouseDown : undefined}
            onContextMenu={control ? (event) => { event.preventDefault() } : undefined} />
          : (
            <p className={css.empty}>
              {frame?.running === true ? 'Waiting for the page…' : "The agent hasn't opened the browser yet. Ask it to visit a site and you'll see it here."}
            </p>
          )}
      </div>
      {steps.length > 0 && (
        <ol ref={list} className={css.steps} aria-label="What the agent did in the browser">
          {steps.map(step => (
            <li key={step.callId} className={css.step} data-status={step.status}>
              <span className={css.stepDot} />
              <span className={css.stepText}>{stepText(step)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

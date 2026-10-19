/**
 * Navegador del agente, lado del panel derecho (añadido por dpseek-local-updater).
 *
 * Pestaña «Agent browser»: la página que está usando el agente, en directo (imágenes del Edge del agente que da el
 * Host, local-agent-browser.ts), y debajo el paso a paso del turno (lo publica el chat, local-live-watch.tsx: abrir,
 * leer, pulsar, rellenar…; nunca lo que escribe en un campo). «Saved sign-ins» enseña las webs con sesión guardada
 * en el perfil del agente y deja borrar cada una. Se abre con «View browser» en la línea de estado del turno, o desde
 * la guía de la barra lateral.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
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

interface Frame {
  readonly running: boolean
  readonly url: string
  readonly title: string
  readonly image: string | null
}

interface Site {
  readonly domain: string
  readonly cookies: number
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
function useFrame(): Frame | undefined {
  const [frame, setFrame] = useState<Frame | undefined>(undefined)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      let next: Frame | undefined
      try {
        if (localCtx !== undefined && document.visibilityState === 'visible') {
          next = unwrap(await localCtx.remote.session.localAgentBrowserFrame({}))
          if (!stopped) setFrame(previous => next?.image === null && previous?.image != null && next.running ? { ...next, image: previous.image } : next)
        }
      } catch {
        // Sin Host o sin respuesta: se vuelve a intentar.
      }
      if (!stopped) timer = setTimeout(() => { void tick() }, next?.running === true ? FRAME_MS : IDLE_MS)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])
  return frame
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
    </div>
  )
}

function AgentBrowserTab({ sessionId }: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const frame = useFrame()
  const live = useSyncExternalStore(subscribeLive, () => liveSnapshot(sessionId))
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
        <button type="button" className={css.tool} aria-expanded={saved} onClick={() => { setSaved(open => !open) }}>Saved sign-ins</button>
        {saved && <SavedSignIns onClose={() => { setSaved(false) }} />}
      </div>
      <div className={css.view}>
        {frame?.image != null
          ? <img className={css.image} src={`data:image/jpeg;base64,${frame.image}`} alt={frame.title} draggable={false} />
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

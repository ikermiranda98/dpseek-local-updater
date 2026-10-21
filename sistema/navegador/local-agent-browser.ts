/**
 * Navegador compartido del agente y del usuario, lado del Host (añadido por dpseek-local-updater).
 *
 * Un Edge sin ventana con su propio perfil, que arranca el proveedor de navegador (agent-browser-launcher.mjs) o, si el
 * usuario lo usa antes que el agente, este mismo módulo; los dos lo anotan en `<DSH_HOME>/storages/local-agent-browser.json`
 * (puerto de depuración y proceso). Desde aquí, por ese puerto:
 * - la página en directo para la pestaña «Browser» del panel derecho: Edge manda cada fotograma en cuanto lo pinta
 *   (Page.startScreencast) y la pestaña espera al siguiente, en vez de pedir capturas cada poco;
 * - el tamaño de la página: el del panel y la densidad de la pantalla, como una ventana de navegador;
 * - el usuario usa la página desde el panel (ratón, arrastrar, rueda, teclado, dirección, atrás, adelante, recargar). En
 *   cuanto la toca, las acciones del agente en el navegador esperan; lo que escribe va directo a la página, nunca al chat;
 * - las webs con sesión guardada en su perfil y borrar la de una web (cookies y datos guardados);
 * - contraseñas guardadas: cifradas con DPAPI de Windows y, en la app, bloqueadas hasta que el usuario confirma que es él
 *   con Windows Hello (o su contraseña de Windows si no lo tiene). El agente las usa por su nombre sin verlas, y solo en
 *   su web. Se pueden exportar e importar en un fichero cifrado con una frase de paso;
 * - pestañas: el panel enseña la que usa el agente (la de su última acción) y el usuario puede elegir otra, abrir y
 *   cerrar; copiar al portapapeles de Windows, buscar en la página, zoom, cursor y soltar ficheros sobre la página;
 * - modo «solo mirar» (el agente no escribe en webs reales) y el permiso con un botón para los clics que envían algo
 *   (los pide el proveedor del navegador, local-browser-context.ts);
 * - Adblock Plus y AdGuard en ese Edge (se descargan de la Chrome Web Store y se cargan al arrancarlo);
 * - al cerrar la app, se cierra ese Edge.
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { localAddressToUrl, openSecrets, sealSecrets, type PlainSecret } from './local-browser-rules.ts'

export { localAddressToUrl } from './local-browser-rules.ts'

interface AgentBrowserState {
  readonly port: number
  readonly pid: number
}

interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly url: string
  readonly title: string
  readonly webSocketDebuggerUrl?: string
}

interface CdpCookie {
  readonly name: string
  readonly domain: string
  readonly path: string
  readonly [key: string]: unknown
}

/** Lo que enseña el panel: la página del navegador (un fotograma JPEG en base64) y quién la maneja. */
export interface LocalAgentBrowserFrame {
  readonly running: boolean
  readonly url: string
  readonly title: string
  /** Número del fotograma; la pestaña pide el siguiente a este. */
  readonly seq: number
  /** El fotograma, o null si no hay uno más nuevo que el que ya tiene la pestaña. */
  readonly image: string | null
  /** El usuario tiene el control (el agente espera). */
  readonly control: boolean
  /** Tamaño de la página en píxeles CSS (el que cubre el fotograma). */
  readonly viewport: { readonly width: number; readonly height: number }
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** La pestaña que se ve y cuántas hay abiertas. */
  readonly tabId: string
  readonly tabCount: number
  /** El agente no puede escribir en webs reales. */
  readonly lookOnly: boolean
  /** Zoom de la página (1 = 100 %). */
  readonly zoom: number
  /** Un clic del agente que espera el permiso del usuario. */
  readonly confirm: LocalAgentBrowserConfirm | null
}

/** Un clic del agente que envía algo en una web real y espera el permiso del usuario. */
export interface LocalAgentBrowserConfirm {
  readonly id: string
  /** El texto del botón. */
  readonly label: string
  /** La web. */
  readonly site: string
}

/** Una pestaña del navegador compartido. */
export interface LocalAgentBrowserTab {
  readonly id: string
  readonly title: string
  readonly url: string
  /** La que se ve en el panel. */
  readonly shown: boolean
  /** La de la última acción del agente. */
  readonly agent: boolean
}

/** Un gesto del usuario en el panel; las posiciones van de 0 a 1 sobre la imagen. */
export type LocalAgentBrowserInput =
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

/** Lo que el usuario hace con la barra de dirección. */
export type LocalAgentBrowserNavigation =
  | { readonly action: 'url'; readonly url: string }
  | { readonly action: 'back' | 'forward' | 'reload' }

/** Edge desde esta versión: el modo sin ventana nuevo, las extensiones sin empaquetar y el protocolo que se usa aquí. */
const EDGE_MIN_MAJOR = 120

const home = (): string => process.env.DSH_HOME ?? join(homedir(), '.dsh')
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
/** Hasta que la pestaña dice su tamaño. */
const DESKTOP = { width: 1280, height: 800, dpr: 1 }
/** Calidad de los fotogramas: de sobra para leer texto, y ligeros para que vayan seguidos. */
const FRAME_QUALITY = 82
/** Cada cuánto se comprueba que Edge sigue con el tamaño pedido. */
const VERIFY_MS = 2000
/** Lo más que espera la pestaña a un fotograma nuevo antes de volver a preguntar (la página quieta no pinta). */
const FRAME_WAIT_MS = 800

interface ControlState {
  active: boolean
  timer?: ReturnType<typeof setTimeout>
  /** El tamaño del panel en píxeles CSS y la densidad de la pantalla. */
  fit?: { width: number; height: number; dpr: number }
  /** Modo «solo mirar»: el agente no escribe en webs reales (lo aplica local-browser-context.ts). */
  lookOnly?: boolean
  /** Zoom de la página (1 = 100 %). */
  zoom?: number
  /** La página de la última acción del agente y cuándo fue (la pone local-browser-context.ts). */
  agentUrl?: string
  agentAt?: number
  /** Clic del agente que espera el permiso del usuario (lo pone y lo espera local-browser-context.ts). */
  confirm?: { id: string; label: string; site: string; answer?: boolean }
  /** Webs donde el usuario ha dicho «permitir siempre» mientras la app siga abierta. */
  allowedSites?: Set<string>
}

/** Sin gestos durante este tiempo, el control vuelve solo al agente (para que no se quede esperando para siempre). */
const CONTROL_IDLE_MS = 2 * 60_000

// Compartido con el proveedor del navegador (local-browser-context.ts), que está en el mismo proceso del Host: sus
// acciones esperan mientras `active`. Al mandar un mensaje en el chat, la pestaña devuelve el control al agente.
const control = ((globalThis as Record<symbol, unknown>)[Symbol.for('dpseek-local-updater.agent-browser-control')] ??= { active: false }) as ControlState

/** Ajustes que se guardan entre arranques: el modo «solo mirar» y el zoom. */
const settingsFile = (): string => join(home(), 'storages', 'local-agent-browser-settings.json')
try {
  const saved = JSON.parse(readFileSync(settingsFile(), 'utf8')) as { lookOnly?: unknown; zoom?: unknown }
  if (typeof saved.lookOnly === 'boolean') control.lookOnly ??= saved.lookOnly
  if (typeof saved.zoom === 'number' && saved.zoom >= 0.25 && saved.zoom <= 3) control.zoom ??= saved.zoom
} catch {
  // Sin ajustes guardados.
}

/**
 * Ajustes del navegador: modo «solo mirar» y zoom. Sin nada, solo los devuelve.
 * @param change - lo que cambia.
 */
export async function localAgentBrowserSettings(
  change: { lookOnly?: boolean; zoom?: number },
): Promise<{ readonly lookOnly: boolean; readonly zoom: number }> {
  if (typeof change.lookOnly === 'boolean') control.lookOnly = change.lookOnly
  if (typeof change.zoom === 'number' && Number.isFinite(change.zoom)) control.zoom = Math.min(3, Math.max(0.25, Math.round(change.zoom * 100) / 100))
  if (change.lookOnly !== undefined || change.zoom !== undefined) {
    try {
      mkdirSync(join(settingsFile(), '..'), { recursive: true })
      writeFileSync(settingsFile(), JSON.stringify({ lookOnly: control.lookOnly === true, zoom: control.zoom ?? 1 }))
    } catch {
      // Si no se puede guardar, vale para esta vez.
    }
    const live = session
    if (change.zoom !== undefined && live?.alive === true) await prepare(live).catch(() => undefined)
  }
  return { lookOnly: control.lookOnly === true, zoom: control.zoom ?? 1 }
}

/**
 * El usuario responde al permiso que pide el agente para un clic que envía algo.
 * @param id - el permiso.
 * @param allow - si lo deja.
 * @param always - permitir siempre en esa web mientras la app siga abierta.
 */
export function localAgentBrowserConfirm(id: string, allow: boolean, always = false): { readonly answered: boolean } {
  const pending = control.confirm
  if (pending?.id !== id) return { answered: false }
  pending.answer = allow
  if (allow && always) (control.allowedSites ??= new Set()).add(pending.site)
  return { answered: true }
}

/** El clic del agente que espera permiso, si lo hay (la app lo mira para abrir el panel del navegador). */
export function localAgentBrowserPending(): { readonly confirm: LocalAgentBrowserConfirm | null } {
  const pending = control.confirm
  if (pending === undefined || pending.answer !== undefined) return { confirm: null }
  return { confirm: { id: pending.id, label: pending.label, site: pending.site } }
}

const takeControl = (): void => {
  control.active = true
  clearTimeout(control.timer)
  control.timer = setTimeout(() => { control.active = false }, CONTROL_IDLE_MS)
}

/**
 * El usuario toma o devuelve el control (tocar la página ya lo toma; esto es para «Resume agent»).
 * @param active - true para tomarlo.
 * @returns el estado resultante.
 */
export function localAgentBrowserControl(active: boolean): { readonly control: boolean } {
  if (active) takeControl()
  else {
    control.active = false
    clearTimeout(control.timer)
  }
  return { control: control.active }
}

/**
 * La página toma el tamaño del panel (en píxeles CSS) y la densidad de la pantalla, como una ventana de navegador.
 * @param fit - tamaño del panel y densidad.
 */
export async function localAgentBrowserViewport(fit: { width: number; height: number; dpr?: number }): Promise<{ readonly ok: true }> {
  control.fit = {
    width: Math.max(320, Math.round(fit.width)), height: Math.max(240, Math.round(fit.height)),
    dpr: Math.min(3, Math.max(1, fit.dpr ?? 1)),
  }
  const live = session
  if (live?.alive === true) {
    await prepare(live).catch(() => undefined)
    // Aunque el tamaño ya fuera ese, una captura nueva: la pestaña lo vuelve a pedir si la imagen no le cuadra.
    live.refine()
  }
  return { ok: true }
}

interface Shot {
  readonly data: string
  readonly seq: number
  readonly width: number
  readonly height: number
}

/** Número del último fotograma (sigue subiendo al cambiar de página, para que la pestaña no se líe). */
let frameSeq = 0

/**
 * Conexión persistente con la página que se ve. La emulación de tamaño, los fotogramas y los gestos van todos por ella:
 * con conexiones de un solo uso, cada captura deshacía el tamaño pedido por otra (la página se quedaba en 320 × 200) y,
 * al cerrar la de la emulación, Edge sin ventana no recuperaba su tamaño.
 */
class PageSession {
  private next = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private open = true
  private readonly waiters = new Set<() => void>()
  /** Lo último que se le pidió de tamaño y de fotogramas (para no repetirlo). */
  emulationKey = ''
  castKey = ''
  /** El último fotograma de la transmisión (para no tomar como cambio uno idéntico). */
  private lastCast = ''
  /** Cuándo se comprobó por última vez que Edge tiene el tamaño pedido. */
  verifiedAt = 0
  /** La fila de ajustes de tamaño y capturas: nunca a la vez (ver exclusive). */
  private lane: Promise<unknown> = Promise.resolve()
  /** El último fotograma que ha pintado. */
  shot: Shot | undefined
  /**
   * Tamaño de la ventana de la página en píxeles CSS, en el que van los gestos. Con la web en modo móvil puede ser más
   * grande que el panel (una página sin ajuste para móvil se dibuja a 980 px y se ve reducida).
   */
  layout: { width: number; height: number } | undefined
  /**
   * Con la pantalla a más del 100 %, los fotogramas del streaming llegan sin esa escala (borrosos): entonces solo avisan
   * de que la página ha cambiado y se toma una captura con todos sus píxeles.
   */
  sharp = false
  private refining = false
  private again = false

  private constructor(readonly url: string, private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
        method?: string
        params?: Record<string, unknown>
      }
      if (message.method === 'Page.screencastFrame' && message.params !== undefined) {
        this.onFrame(message.params as { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } })
        return
      }
      if (message.id === undefined) return
      const waiting = this.pending.get(message.id)
      if (waiting === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      this.open = false
      for (const waiting of this.pending.values()) waiting.reject(new Error('conexión cerrada'))
      this.pending.clear()
      this.wake()
    })
  }

  static connect(url: string): Promise<PageSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => { resolve(new PageSession(url, socket)) }, { once: true })
      socket.addEventListener('error', () => { reject(new Error('no se puede conectar con la página')) }, { once: true })
    })
  }

  get alive(): boolean { return this.open }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    if (!this.open) return Promise.reject(new Error('conexión cerrada'))
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: sin respuesta`)) }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Sin esperar respuesta (movimientos del ratón): el orden lo guarda la propia conexión. */
  send(method: string, params: Record<string, unknown> = {}): void {
    if (!this.open) return
    this.call(method, params).catch(() => undefined)
  }

  /** Espera a un fotograma posterior a `after`, como mucho `timeoutMs`. */
  async frameAfter(after: number, timeoutMs: number): Promise<Shot | undefined> {
    if (this.shot !== undefined && this.shot.seq > after) return this.shot
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.waiters.add(done)
    })
    return this.shot !== undefined && this.shot.seq > after ? this.shot : undefined
  }

  /** Mide la ventana de la página (píxeles CSS). */
  async measure(): Promise<{ width: number; height: number }> {
    const metrics = await this.call<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics')
    this.layout = { width: metrics.cssVisualViewport.clientWidth, height: metrics.cssVisualViewport.clientHeight }
    return this.layout
  }

  /**
   * De uno en uno: los cambios de tamaño y las capturas. Edge, al terminar una captura, vuelve a poner el tamaño que
   * tenía al empezarla: un cambio que llegaba en medio se perdía (y aquí se daba por puesto).
   */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lane.then(task)
    this.lane = run.catch(() => undefined)
    return run
  }

  /** Un fotograma a mano, con todos los píxeles de la pantalla (también si Edge aún no ha mandado ninguno). */
  capture(): Promise<void> {
    return this.exclusive(async () => {
      const layout = await this.measure()
      const shot = await this.call<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: FRAME_QUALITY })
      this.keep(shot.data, layout.width, layout.height)
    })
  }

  close(): void { this.socket.close() }

  private onFrame(params: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }): void {
    // Sin este acuse Edge no manda el siguiente.
    this.send('Page.screencastFrameAck', { sessionId: params.sessionId })
    if (this.castKey === '') return
    // Un fotograma igual al anterior no es un cambio: lo provoca la propia captura nítida (si no, se encadenaban sin fin).
    if (params.data === this.lastCast) return
    this.lastCast = params.data
    if (this.sharp) this.refine()
    else this.keep(params.data, this.layout?.width ?? params.metadata.deviceWidth, this.layout?.height ?? params.metadata.deviceHeight)
  }

  /** Una captura nítida por cada cambio, sin amontonarlas (si llegan más mientras se toma una, se toma otra al acabar). */
  refine(): void {
    if (this.refining) {
      this.again = true
      return
    }
    this.refining = true
    void this.capture().catch(() => undefined).finally(() => {
      this.refining = false
      if (this.again && this.open) {
        this.again = false
        this.refine()
      }
    })
  }

  private keep(data: string, width: number, height: number): void {
    this.shot = { data, seq: ++frameSeq, width: Math.round(width), height: Math.round(height) }
    this.wake()
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}

let session: PageSession | undefined
let opening: Promise<PageSession> | undefined

/** Sin peticiones de la pestaña durante este tiempo (oculta o cerrada), se deja de transmitir la página. */
const UNWATCHED_MS = 4000
/** Cuándo pidió la pestaña un fotograma por última vez. */
let watchedAt = 0
setInterval(() => {
  const live = session
  if (live?.alive !== true || live.castKey === '' || Date.now() - watchedAt < UNWATCHED_MS) return
  live.castKey = ''
  void live.call('Page.stopScreencast').catch(() => undefined)
}, 2000).unref()

/** La conexión con esa página (la misma mientras siga siendo la que se ve). */
async function sessionFor(url: string): Promise<PageSession> {
  if (session?.url === url && session.alive) return session
  if (opening !== undefined) {
    const pending = await opening.catch(() => undefined)
    if (pending?.url === url && pending.alive) return pending
  }
  session?.close()
  opening = PageSession.connect(url)
  try {
    session = await opening
    return session
  } finally {
    opening = undefined
  }
}

/** Lo que pide el panel ahora: tamaño en píxeles CSS, densidad y si la web debe ver un móvil (panel estrecho). */
function wanted(): { width: number; height: number; dpr: number; mobile: boolean } {
  const fit = control.fit ?? DESKTOP
  const zoom = control.zoom ?? 1
  const width = Math.max(200, Math.round(fit.width / zoom))
  return { width, height: Math.max(150, Math.round(fit.height / zoom)), dpr: Math.min(4, fit.dpr * zoom), mobile: width < 768 }
}

/**
 * Pone a la página el tamaño del panel y le pide fotogramas con sus píxeles justos (por su conexión persistente). En
 * la misma fila que las capturas y que otros ajustes: dos a la vez dejaban a Edge con el tamaño viejo mientras aquí se
 * daba el nuevo por puesto, y ya no se corregía.
 */
function prepare(page: PageSession): Promise<void> {
  return page.exclusive(() => applyPrepare(page))
}

async function applyPrepare(page: PageSession): Promise<void> {
  const spec = wanted()
  const key = JSON.stringify(spec)
  // De vez en cuando se comprueba que Edge tiene de verdad ese tamaño (si algo lo deshizo, se vuelve a poner).
  if (page.emulationKey === key && Date.now() - page.verifiedAt > VERIFY_MS) {
    page.verifiedAt = Date.now()
    const shown = await page.call<{ result: { value?: number[] } }>('Runtime.evaluate',
      { expression: '[outerWidth, outerHeight, devicePixelRatio]', returnByValue: true }, 1500).catch(() => undefined)
    const [width, height, dpr] = shown?.result.value ?? []
    if (width !== undefined && height !== undefined && dpr !== undefined
      && (Math.abs(width - spec.width) > 1 || Math.abs(height - spec.height) > 1 || Math.abs(dpr - spec.dpr) > 0.02)) page.emulationKey = ''
  }
  let changed = page.emulationKey !== key
  if (changed) {
    await page.call('Emulation.setDeviceMetricsOverride', { width: spec.width, height: spec.height, deviceScaleFactor: spec.dpr, mobile: spec.mobile })
    await page.call('Emulation.setTouchEmulationEnabled', { enabled: spec.mobile, ...spec.mobile ? { maxTouchPoints: 5 } : {} })
    await page.call('Emulation.setUserAgentOverride', spec.mobile ? { userAgent: MOBILE_UA, platform: 'Android' } : { userAgent: '' })
    page.emulationKey = key
    page.sharp = spec.dpr > 1.05
  }
  const cast = `${String(Math.round(spec.width * spec.dpr))}x${String(Math.round(spec.height * spec.dpr))}`
  if (page.castKey !== cast) {
    if (page.castKey !== '') await page.call('Page.stopScreencast').catch(() => undefined)
    await page.call('Page.startScreencast', {
      format: 'jpeg', quality: FRAME_QUALITY, everyNthFrame: 1,
      maxWidth: Math.round(spec.width * spec.dpr), maxHeight: Math.round(spec.height * spec.dpr),
    })
    page.castKey = cast
    changed = true
  }
  // Edge no siempre manda un fotograma al cambiar de tamaño o al reanudar (y, si lo manda, puede ser de antes de
  // recolocar la página): se toman dos capturas, al poco y cuando ya se ha recolocado.
  if (changed) for (const ms of [150, 500]) setTimeout(() => { if (page.alive) page.refine() }, ms)
}

/** Una web con sesión (cookies) guardada en el perfil del navegador. */
export interface LocalAgentBrowserSite {
  readonly domain: string
  readonly cookies: number
}


/** Fichero donde se anota el Edge compartido. */
export function localAgentBrowserStateFile(): string {
  return join(home(), 'storages', 'local-agent-browser.json')
}

/** Carpeta del perfil del Edge compartido (aquí se guardan las sesiones iniciadas). */
export function localAgentBrowserProfile(): string {
  return join(home(), 'storages', 'agent-browser')
}

function readState(): AgentBrowserState | undefined {
  try {
    const state = JSON.parse(readFileSync(localAgentBrowserStateFile(), 'utf8')) as Partial<AgentBrowserState>
    return Number.isInteger(state.port) && Number.isInteger(state.pid) ? state as AgentBrowserState : undefined
  } catch {
    return undefined
  }
}

/** Dónde puede estar Edge (el del sistema, el de 64 bits o el del usuario). */
function edgeCandidates(): string[] {
  const roots = [process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramFiles ?? 'C:\\Program Files', process.env.LOCALAPPDATA]
  return roots.filter((root): root is string => root !== undefined && root !== '').map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
}

/** El Edge instalado, o nada. */
export function localEdgePath(): string | undefined {
  return edgeCandidates().find(path => existsSync(path))
}

/** La versión de ese Edge: la carpeta con el número más alto junto a msedge.exe (sin abrirlo). */
function edgeVersion(path: string): string | undefined {
  try {
    const versions = readdirSync(join(path, '..')).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
    return versions.sort((a, b) => {
      const x = a.split('.').map(Number)
      const y = b.split('.').map(Number)
      for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
      return 0
    })[0]
  } catch {
    return undefined
  }
}

/** Si el navegador puede funcionar: Edge instalado y lo bastante nuevo. Lo enseña la pestaña si falla. */
export function localAgentBrowserCheck(): { readonly ok: boolean; readonly version?: string; readonly message?: string } {
  const path = localEdgePath()
  if (path === undefined) {
    return { ok: false, message: 'Microsoft Edge is not installed. The browser needs it: install it from microsoft.com/edge and open this tab again.' }
  }
  const version = edgeVersion(path)
  const major = Number(version?.split('.')[0] ?? Number.NaN)
  if (!Number.isNaN(major) && major < EDGE_MIN_MAJOR) {
    return { ok: false, ...version === undefined ? {} : { version }, message: `Microsoft Edge ${String(major)} is too old for the browser (it needs ${String(EDGE_MIN_MAJOR)} or newer). Update it from edge://settings/help.` }
  }
  return { ok: true, ...version === undefined ? {} : { version } }
}

/**
 * Bloqueadores de anuncios del navegador, de la Chrome Web Store (Edge acepta sus extensiones). Se descargan solos y se
 * cargan cada vez que arranca ese Edge, por el protocolo de depuración (Extensions.loadUnpacked: el Edge de marca ignora
 * --load-extension); cada semana se vuelve a mirar si hay versión nueva.
 */
const AD_BLOCKERS = [
  { id: 'cfhdojbkjhnklbpkdaibdccddilifddb', name: 'Adblock Plus' },
  { id: 'bgnkhhnnamicmpeenaelnjfhikgbkllg', name: 'AdGuard' },
] as const
const EXTENSIONS_REFRESH_MS = 7 * 24 * 60 * 60_000

/**
 * Carpeta de las extensiones (la misma que mira el lanzador del agente, agent-browser-launcher.mjs). De ruta corta: con
 * la carpeta de la app más larga, las reglas de los bloqueadores pasaban de 260 caracteres y Edge no las cargaba.
 */
export function localAgentBrowserExtensionsDir(): string {
  return join(process.env.LOCALAPPDATA ?? join(home(), 'storages'), 'dsh-ad-blockers')
}

/**
 * Las carpetas de una extensión, de la más nueva a la más vieja. Cada descarga va a una carpeta con nombre nuevo
 * (<id>-<marca>), nunca encima de otra: tras sustituir una carpeta por otra con el mismo nombre, Edge rechazaba esa ruta
 * («The provided path … is invalid») aunque los ficheros estuvieran bien, incluso con un perfil limpio.
 */
function extensionDirsOf(id: string): string[] {
  const root = localAgentBrowserExtensionsDir()
  try {
    return readdirSync(root).filter(name => (name === id || name.startsWith(`${id}-`)) && existsSync(join(root, name, 'manifest.json')))
      .map(name => join(root, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch {
    return []
  }
}

/** Las extensiones listas para cargar: la carpeta más nueva de cada una. */
function extensionDirs(): string[] {
  return AD_BLOCKERS.map(item => extensionDirsOf(item.id)[0]).filter((dir): dir is string => dir !== undefined)
}

/** Una carpeta nueva para una extensión (nunca un nombre ya usado). */
const freshExtensionDir = (id: string): string => join(localAgentBrowserExtensionsDir(), `${id}-${Date.now().toString(36)}`)

/** Un .crx (cabecera Cr24 con su firma) y, detrás, un .zip normal. */
function crxZip(crx: Buffer): Buffer {
  if (crx.subarray(0, 4).toString('latin1') !== 'Cr24') throw new Error('no es una extensión')
  const version = crx.readUInt32LE(4)
  const start = version === 3 ? 12 + crx.readUInt32LE(8) : 16 + crx.readUInt32LE(8) + crx.readUInt32LE(12)
  return crx.subarray(start)
}

async function downloadExtension(id: string, major: number): Promise<void> {
  const root = localAgentBrowserExtensionsDir()
  const stamp = join(root, `${id}.downloaded`)
  try {
    if (extensionDirsOf(id).length > 0 && Date.now() - statSync(stamp).mtimeMs < EXTENSIONS_REFRESH_MS) return
  } catch {
    // Sin la marca: se descarga.
  }
  mkdirSync(root, { recursive: true })
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${String(major)}.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`descarga: ${String(response.status)}`)
  const zip = crxZip(Buffer.from(await response.arrayBuffer()))
  const fresh = freshExtensionDir(id)
  const zipFile = `${fresh}.zip`
  mkdirSync(fresh, { recursive: true })
  writeFileSync(zipFile, zip)
  try {
    // tar de Windows (bsdtar) abre .zip.
    await new Promise<void>((resolve, reject) => {
      execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipFile, '-C', fresh],
        { windowsHide: true, timeout: 60_000 }, (error) => { if (error === null) resolve(); else reject(new Error(error.message)) })
    })
  } finally {
    rmSync(zipFile, { force: true })
  }
  if (!existsSync(join(fresh, 'manifest.json'))) {
    rmSync(fresh, { recursive: true, force: true })
    throw new Error('la extensión no trae manifest.json')
  }
  // Chrome no carga sin empaquetar las que traen _metadata (la firma de la tienda).
  rmSync(join(fresh, '_metadata'), { recursive: true, force: true })
  writeFileSync(stamp, new Date().toISOString())
  // Se quedan la nueva y la anterior (un Edge en marcha puede estar usándola); las demás sobran, y las de la forma
  // antigua (<id>, <id>.new, <id>.old) también.
  for (const old of extensionDirsOf(id).filter(dir => dir !== fresh).slice(1)) rmSync(old, { recursive: true, force: true })
  for (const legacy of [`${id}.new`, `${id}.old`, `${id}.zip`]) rmSync(join(root, legacy), { recursive: true, force: true })
}

/** Descarga (o actualiza) los bloqueadores; una vez por arranque de la app. Si falla, el navegador va sin ellos. */
let extensionsReady: Promise<void> | undefined
function prepareExtensions(): Promise<void> {
  extensionsReady ??= (async () => {
    const path = localEdgePath()
    const major = Number(path === undefined ? Number.NaN : edgeVersion(path)?.split('.')[0])
    for (const item of AD_BLOCKERS) {
      try {
        await downloadExtension(item.id, Number.isNaN(major) ? 140 : major)
      } catch (error) {
        console.warn(`local agent browser: no se ha podido preparar ${item.name}:`, error instanceof Error ? error.message : error)
      }
    }
    // Si el Edge ya estaba abierto (lo arrancó el agente o la pestaña antes de terminar la descarga), se cargan en él.
    const running = readState()
    if (running !== undefined && await json(running, '/json/version') !== undefined) await loadExtensions(running)
  })()
  return extensionsReady
}
if (process.env.DSH_LOCAL_NO_AD_BLOCKERS !== '1') setTimeout(() => { void prepareExtensions() }, 3000).unref()

/** El Edge (por su proceso) en el que ya se cargaron los bloqueadores. */
let extensionsLoadedIn: number | undefined

/** Carga las extensiones listas en ese Edge (no se guardan: hay que hacerlo en cada arranque), una vez por Edge. */
async function loadExtensions(state: AgentBrowserState): Promise<void> {
  const dirs = process.env.DSH_LOCAL_NO_AD_BLOCKERS === '1' ? [] : extensionDirs()
  if (dirs.length === 0 || extensionsLoadedIn === state.pid) return
  extensionsLoadedIn = state.pid
  const socket = await json<{ webSocketDebuggerUrl?: string }>(state, '/json/version')
  if (socket?.webSocketDebuggerUrl === undefined) return
  const browserSocket = socket.webSocketDebuggerUrl
  for (const path of dirs) {
    const load = (from: string): Promise<unknown> => cdp(browserSocket, 'Extensions.loadUnpacked', { path: from })
    await load(path).catch(async (error: unknown) => {
      // Si Edge rechaza esa carpeta (le pasa a veces con una ruta ya usada), una copia con nombre nuevo sí carga.
      if (!(error instanceof Error && error.message.includes('is invalid'))) throw error
      const copy = freshExtensionDir(basename(path).split('-')[0] ?? basename(path))
      cpSync(path, copy, { recursive: true })
      await load(copy)
    }).catch((error: unknown) => { console.warn('local agent browser: extensión sin cargar', path, error instanceof Error ? error.message : error) })
  }
  void closeWelcomePages(state, socket.webSocketDebuggerUrl)
}

/**
 * Al instalarse, AdGuard y Adblock Plus abren su página de bienvenida en una pestaña nueva, y el panel y el agente se
 * irían a ella: se cierra en cuanto aparece (llega un par de segundos después), sin hacer esperar al arranque.
 */
async function closeWelcomePages(state: AgentBrowserState, browserSocket: string): Promise<void> {
  for (let i = 0; i < 16; i++) {
    await sleep(500)
    const pages = await json<{ id: string; type: string; url: string }[]>(state, '/json/list') ?? []
    for (const page of pages.filter(target => target.type === 'page' && EXTENSION_WELCOME.test(target.url))) {
      await cdp(browserSocket, 'Target.closeTarget', { targetId: page.id }).catch(() => undefined)
    }
  }
}

/** Las páginas de bienvenida de los bloqueadores. */
const EXTENSION_WELCOME = /^https:\/\/([a-z0-9-]+\.)*(adguard\.com|adblockplus\.org)\/|^chrome-extension:\/\//i

async function json<T>(state: AgentBrowserState, path: string): Promise<T | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(state.port)}${path}`, { signal: AbortSignal.timeout(1500) })
    return response.ok ? await response.json() as T : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * El Edge compartido, en marcha: si el usuario abre una dirección antes de que el agente use el navegador, se arranca
 * aquí igual que en el lanzador del agente (mismo perfil, mismo candado y mismo fichero de estado, así que luego el
 * agente se conecta a este).
 */
async function ensureBrowser(): Promise<AgentBrowserState> {
  const running = readState()
  if (running !== undefined && await json(running, '/json/version') !== undefined) return running
  const stateFile = localAgentBrowserStateFile()
  const lock = `${stateFile}.lock`
  mkdirSync(join(stateFile, '..'), { recursive: true })
  let locked = false
  for (let i = 0; i < 200 && !locked; i++) {
    try {
      closeSync(openSync(lock, 'wx'))
      locked = true
    } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true }) } catch { /* ya no está */ }
      await sleep(100)
    }
  }
  try {
    const again = readState()
    if (again !== undefined && await json(again, '/json/version') !== undefined) return again
    const check = localAgentBrowserCheck()
    const edge = localEdgePath()
    if (!check.ok || edge === undefined) throw new Error(check.message ?? 'Microsoft Edge is not installed.')
    // Los bloqueadores de anuncios, si se están descargando ahora (la primera vez), se esperan un poco.
    if (process.env.DSH_LOCAL_NO_AD_BLOCKERS !== '1') {
      await Promise.race([prepareExtensions(), sleep(15_000)])
    }
    const profile = localAgentBrowserProfile()
    mkdirSync(profile, { recursive: true })
    rmSync(join(profile, 'DevToolsActivePort'), { force: true })
    const browser = spawn(edge, [
      '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2,msUndersideButton',
      // Permite cargar los bloqueadores por el protocolo (loadExtensions); el puerto solo escucha en 127.0.0.1.
      '--enable-unsafe-extension-debugging', '--window-size=1280,800', 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: true })
    browser.unref()
    let port: number | undefined
    for (let i = 0; i < 150 && port === undefined; i++) {
      await sleep(100)
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || undefined } catch { /* aún no */ }
    }
    if (port === undefined || browser.pid === undefined) throw new Error('The browser did not start.')
    const state = { port, pid: browser.pid }
    await loadExtensions(state)
    writeFileSync(stateFile, JSON.stringify({ ...state, startedAt: new Date().toISOString() }))
    return state
  } finally {
    if (locked) rmSync(lock, { force: true })
  }
}

/** Una orden por el protocolo de depuración de Edge, en una conexión de un solo uso. */
async function cdp<T>(url: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => { socket.close(); reject(new Error(`${method}: sin respuesta`)) }, 5000)
    socket.addEventListener('open', () => { socket.send(JSON.stringify({ id: 1, method, params })) })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result as T)
    })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${method}: no se puede conectar`)) })
  })
}

/** La pestaña elegida (por el usuario en el panel, o la del agente al actuar) y cuándo. */
let pinned: { id: string; at: number } | undefined

/** Las pestañas de verdad (con su conexión; sin las páginas internas de las extensiones). */
const pagesOf = (targets: readonly CdpTarget[]): CdpTarget[] =>
  targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl !== undefined && !/^(chrome|edge)-extension:/.test(target.url))

/** La misma dirección, sin la parte de después de # (Playwright y Edge no siempre la dan igual). */
const sameUrl = (a: string, b: string): boolean => a === b || a.split('#')[0] === b.split('#')[0]

/**
 * La página que conviene enseñar: la de la última acción del agente (si no se eligió otra después), la elegida en el
 * panel o, si no, la primera con contenido (Edge las lista de la más reciente a la más antigua).
 */
function currentPage(targets: readonly CdpTarget[], popups: ReadonlySet<string>): CdpTarget | undefined {
  const pages = pagesOf(targets)
  const agentAt = control.agentAt ?? 0
  const agentUrl = control.agentUrl
  if (agentUrl !== undefined && agentAt > (pinned?.at ?? 0)) {
    // Si hay varias con esa dirección, la que ya se veía.
    const matches = pages.filter(page => sameUrl(page.url, agentUrl))
    const match = matches.find(page => page.id === pinned?.id) ?? matches[0]
    if (match !== undefined) {
      pinned = { id: match.id, at: agentAt }
      return match
    }
  }
  const chosen = pinned === undefined ? undefined : pages.find(page => page.id === pinned?.id)
  if (chosen !== undefined) return chosen
  const content = pages.filter(page => !page.url.startsWith('about:blank') && !page.url.startsWith('edge://'))
  // Las ventanas que abre una web (a veces diminutas, de 360 × 50) no tapan a la página de verdad.
  return content.find(page => !popups.has(page.id)) ?? content[0] ?? pages[0]
}

/** @returns las pestañas abiertas, la que se ve y la del agente. */
export async function localAgentBrowserTabs(): Promise<{ readonly tabs: readonly LocalAgentBrowserTab[] }> {
  const state = readState()
  const targets = state === undefined ? undefined : await json<CdpTarget[]>(state, '/json/list')
  if (state === undefined || targets === undefined) return { tabs: [] }
  const shown = currentPage(targets, await popupIds(state))
  const agentUrl = control.agentUrl
  return {
    tabs: pagesOf(targets).map(page => ({
      id: page.id, title: page.title === '' ? page.url : page.title, url: page.url, shown: page.id === shown?.id,
      agent: agentUrl !== undefined && sameUrl(page.url, agentUrl),
    })),
  }
}

/**
 * Pestañas desde el panel: enseñar otra, abrir una nueva (con una dirección o en blanco) o cerrar una.
 * @param request - qué hacer.
 */
export async function localAgentBrowserTab(request: { action: 'show' | 'close'; id: string } | { action: 'new'; url?: string }): Promise<{ readonly id: string }> {
  takeControl()
  const state = await ensureBrowser()
  const socket = await browserSocket(state)
  if (socket === undefined) throw new Error('The browser is not responding.')
  seenPage = undefined
  if (request.action === 'new') {
    const url = request.url === undefined || request.url.trim() === '' ? 'about:blank' : localAddressToUrl(request.url)
    const { targetId } = await cdp<{ targetId: string }>(socket, 'Target.createTarget', { url })
    pinned = { id: targetId, at: Date.now() }
    return { id: targetId }
  }
  if (request.action === 'close') {
    await cdp(socket, 'Target.closeTarget', { targetId: request.id })
    if (pinned?.id === request.id) pinned = undefined
    return { id: request.id }
  }
  await cdp(socket, 'Target.activateTarget', { targetId: request.id }).catch(() => undefined)
  pinned = { id: request.id, at: Date.now() }
  return { id: request.id }
}

/** Ventanas emergentes: páginas abiertas por otra página (las pestañas normales no tienen quien las abra). */
let popupCache: { at: number; ids: ReadonlySet<string> } | undefined

async function popupIds(state: AgentBrowserState): Promise<ReadonlySet<string>> {
  if (popupCache !== undefined && Date.now() - popupCache.at < 2000) return popupCache.ids
  const ids = new Set<string>()
  const socket = await browserSocket(state)
  if (socket !== undefined) {
    try {
      const { targetInfos } = await cdp<{ targetInfos: readonly { targetId: string; type: string; openerId?: string }[] }>(socket, 'Target.getTargets')
      for (const target of targetInfos) if (target.type === 'page' && target.openerId !== undefined) ids.add(target.targetId)
    } catch {
      // Sin la lista, ninguna cuenta como emergente.
    }
  }
  popupCache = { at: Date.now(), ids }
  return ids
}

/** La última página vista: los gestos seguidos (mover el ratón) no preguntan a Edge cada vez cuál es. */
let seenPage: { at: number; page: CdpTarget } | undefined
/** Cuántas pestañas había la última vez que se miró. */
let tabCount = 0

/**
 * La página que se ve y su conexión (lista para fotogramas y gestos), o nada si el navegador no está en marcha.
 * @param fresh - preguntar a Edge aunque se haya visto hace nada (fotogramas y navegación).
 */
async function livePage(state = readState(), fresh = true): Promise<{ page: CdpTarget; live: PageSession } | undefined> {
  if (!fresh && seenPage !== undefined && Date.now() - seenPage.at < 1000 && session?.alive === true
    && session.url === seenPage.page.webSocketDebuggerUrl) {
    return { page: seenPage.page, live: session }
  }
  if (state === undefined) return undefined
  const targets = await json<CdpTarget[]>(state, '/json/list')
  tabCount = targets === undefined ? 0 : pagesOf(targets).length
  const page = targets === undefined ? undefined : currentPage(targets, await popupIds(state))
  if (page?.webSocketDebuggerUrl === undefined) return undefined
  const live = await sessionFor(page.webSocketDebuggerUrl)
  await prepare(live).catch(() => undefined)
  seenPage = { at: Date.now(), page }
  return { page, live }
}

/**
 * La página del navegador para el panel: espera (poco) a un fotograma más nuevo que el que ya tiene la pestaña.
 * @param after - número del último fotograma que tiene la pestaña (0 al empezar).
 * @returns dirección, título, fotograma y estado; `running: false` si el navegador no está en marcha.
 */
export async function localAgentBrowserFrame(after = 0): Promise<LocalAgentBrowserFrame> {
  const fit = control.fit ?? DESKTOP
  const pending = control.confirm
  const idle: LocalAgentBrowserFrame = {
    running: false, url: '', title: '', seq: after, image: null, control: control.active,
    viewport: { width: fit.width, height: fit.height }, canGoBack: false, canGoForward: false,
    tabId: '', tabCount: 0, lookOnly: control.lookOnly === true, zoom: control.zoom ?? 1,
    confirm: pending === undefined || pending.answer !== undefined ? null : { id: pending.id, label: pending.label, site: pending.site },
  }
  watchedAt = Date.now()
  const state = readState()
  if (state === undefined || await json(state, '/json/version') === undefined) return idle
  try {
    const current = await livePage(state)
    if (current === undefined) return { ...idle, running: true }
    const { page, live } = current
    // Edge solo manda fotogramas cuando la página cambia: el primero, si no llega, se toma a mano.
    let shot = await live.frameAfter(after, live.shot === undefined ? 400 : FRAME_WAIT_MS)
    await live.measure().catch(() => undefined)
    if (shot === undefined && live.shot === undefined) {
      await live.capture().catch(() => undefined)
      shot = live.shot
    }
    const history = await live.call<{ currentIndex: number; entries: readonly { url: string; title: string }[] }>('Page.getNavigationHistory')
      .catch(() => undefined)
    const entry = history?.entries[history.currentIndex]
    return {
      running: true,
      url: entry?.url ?? page.url,
      title: entry?.title ?? page.title,
      seq: shot?.seq ?? live.shot?.seq ?? after,
      image: shot?.data ?? null,
      control: control.active,
      viewport: live.layout === undefined
        ? idle.viewport
        : { width: Math.round(live.layout.width), height: Math.round(live.layout.height) },
      canGoBack: history !== undefined && history.currentIndex > 0,
      canGoForward: history !== undefined && history.currentIndex < history.entries.length - 1,
      tabId: page.id,
      tabCount: tabCount,
      lookOnly: idle.lookOnly,
      zoom: idle.zoom,
      confirm: idle.confirm,
    }
  } catch {
    return { ...idle, running: true }
  }
}

/** Teclas que además escriben algo (Intro envía formularios con su carácter, como en un navegador de verdad). */
const KEY_TEXT: Readonly<Record<string, string>> = { Enter: '\r' }

/**
 * Un gesto del usuario en el panel, llevado a la página que se ve. Pulsar, la rueda o el teclado toman el control (el
 * agente espera); mover el ratón sin pulsar solo llega a la página con el control ya tomado, para no molestar al agente.
 * @param input - el gesto.
 * @returns si se ha llevado a la página.
 */
/** Cada cuánto se pregunta a la página por el cursor mientras se mueve el ratón. */
const CURSOR_MS = 120
let cursorAskedAt = 0

/** El cursor que pondría la página en ese punto (mano en enlaces y botones, barra en el texto editable). */
async function pageCursor(live: PageSession, x: number, y: number): Promise<string | undefined> {
  const result = await live.call<{ result: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => { let e = document.elementFromPoint(${String(x)}, ${String(y)}); while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(${String(x)}, ${String(y)}); if (!inner || inner === e) break; e = inner }
      if (!e) return 'default'; const c = getComputedStyle(e).cursor; if (c !== 'auto') return c;
      return e.isContentEditable || e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(e.type)) ? 'text' : 'default' })()`,
    returnByValue: true,
  }, 1000).catch(() => undefined)
  const value = result?.result.value
  return typeof value === 'string' ? value : undefined
}

export async function localAgentBrowserInput(input: LocalAgentBrowserInput): Promise<{ readonly sent: boolean; readonly cursor?: string }> {
  if (input.kind === 'mouse' && input.type === 'move' && !control.active) return { sent: false }
  takeControl()
  const current = await livePage(readState(), false)
  if (current === undefined) return { sent: false }
  const { live } = current
  if (input.kind === 'text') {
    live.send('Input.insertText', { text: input.text })
    return { sent: true }
  }
  if (input.kind === 'key') {
    const text = KEY_TEXT[input.key]
    const base = {
      key: input.key, code: input.code, modifiers: input.modifiers,
      windowsVirtualKeyCode: input.keyCode, nativeVirtualKeyCode: input.keyCode,
    }
    live.send('Input.dispatchKeyEvent', { ...base, type: text === undefined ? 'rawKeyDown' : 'keyDown', ...text === undefined ? {} : { text, unmodifiedText: text } })
    live.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
    return { sent: true }
  }
  // Las posiciones del panel (0..1 sobre la imagen) pasan a píxeles CSS de la ventana de la página.
  const size = live.layout ?? await live.measure()
  const x = Math.round(Math.min(1, Math.max(0, input.x)) * size.width)
  const y = Math.round(Math.min(1, Math.max(0, input.y)) * size.height)
  if (input.kind === 'wheel') {
    live.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers })
    return { sent: true }
  }
  // Con el panel estrecho la web ve un móvil: el botón izquierdo es un dedo (tocar y arrastrar para desplazar).
  if (wanted().mobile && (input.button === 'left' || (input.type === 'move' && (input.buttons & 1) === 1))) {
    const type = input.type === 'down' ? 'touchStart' : input.type === 'up' ? 'touchEnd' : 'touchMove'
    live.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }], modifiers: input.modifiers })
    return { sent: true }
  }
  if (wanted().mobile && input.type === 'move') return { sent: true }
  const type = input.type === 'down' ? 'mousePressed' : input.type === 'up' ? 'mouseReleased' : 'mouseMoved'
  live.send('Input.dispatchMouseEvent', {
    type, x, y, button: input.button, buttons: input.buttons, clickCount: input.clickCount, modifiers: input.modifiers,
  })
  if (input.type === 'move' && input.buttons === 0 && Date.now() - cursorAskedAt > CURSOR_MS) {
    cursorAskedAt = Date.now()
    const cursor = await pageCursor(live, x, y)
    return cursor === undefined ? { sent: true } : { sent: true, cursor }
  }
  return { sent: true }
}

/**
 * Lo seleccionado en la página (o en el campo que tiene el foco), para el portapapeles de Windows: el Edge sin ventana
 * no siempre llega a él.
 * @returns el texto (vacío si no hay nada seleccionado; nunca el de un campo de contraseña).
 */
export async function localAgentBrowserCopy(): Promise<{ readonly text: string }> {
  const current = await livePage(readState(), false)
  if (current === undefined) return { text: '' }
  const result = await current.live.call<{ result: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => { const deep = (d) => { let a = d.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a };
      let doc = document, a = deep(doc);
      while (a && a.tagName === 'IFRAME') { try { doc = a.contentDocument; a = deep(doc) } catch { break } }
      if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'password')) && typeof a.selectionStart === 'number' && a.selectionStart !== a.selectionEnd) return a.value.slice(a.selectionStart, a.selectionEnd);
      return String((doc.getSelection && doc.getSelection()) || '') })()`,
    returnByValue: true,
  }).catch(() => undefined)
  const value = result?.result.value
  return { text: typeof value === 'string' ? value : '' }
}

/**
 * Buscar en la página: la siguiente (o la anterior) aparición del texto, que queda seleccionada y a la vista.
 * @returns si la ha encontrado.
 */
export async function localAgentBrowserFind(text: string, backwards = false): Promise<{ readonly found: boolean }> {
  const current = await livePage(readState(), false)
  if (current === undefined || text === '') return { found: false }
  const result = await current.live.call<{ result: { value?: unknown } }>('Runtime.evaluate', {
    expression: `window.find(${JSON.stringify(text)}, false, ${String(backwards)}, true, false, true, false)`, returnByValue: true,
  }).catch(() => undefined)
  return { found: result?.result.value === true }
}

/** Lo más que se puede soltar de una vez sobre la página. */
const DROP_MAX_BYTES = 64 * 1024 * 1024

/**
 * Ficheros soltados sobre la página desde el panel: se guardan en una carpeta temporal del perfil y se sueltan en ese
 * punto de la página como un arrastre de verdad (las zonas para subir ficheros y los campos de fichero los aceptan).
 * @param drop - punto (0..1 sobre la imagen) y ficheros (nombre y contenido en base64).
 */
export async function localAgentBrowserDrop(
  drop: { x: number; y: number; files: readonly { name: string; data: string }[] },
): Promise<{ readonly dropped: number }> {
  if (drop.files.length === 0) return { dropped: 0 }
  const bytes = drop.files.reduce((total, file) => total + Math.floor(file.data.length * 3 / 4), 0)
  if (bytes > DROP_MAX_BYTES) throw new Error('Those files are too big to drop here (64 MB at most).')
  takeControl()
  const current = await livePage(readState(), false)
  if (current === undefined) throw new Error('Open a page first.')
  const uploads = join(home(), 'storages', 'agent-browser-uploads')
  // Lo de días anteriores ya no hace falta.
  try {
    for (const name of readdirSync(uploads)) {
      const path = join(uploads, name)
      if (Date.now() - statSync(path).mtimeMs > 24 * 60 * 60_000) rmSync(path, { recursive: true, force: true })
    }
  } catch {
    // Aún no hay carpeta.
  }
  const folder = join(uploads, randomUUID())
  mkdirSync(folder, { recursive: true })
  const paths = drop.files.map((file, index) => {
    const name = basename(file.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || `file-${String(index + 1)}`
    const path = join(folder, name)
    writeFileSync(path, Buffer.from(file.data, 'base64'))
    return path
  })
  const { live } = current
  const size = live.layout ?? await live.measure()
  const x = Math.round(Math.min(1, Math.max(0, drop.x)) * size.width)
  const y = Math.round(Math.min(1, Math.max(0, drop.y)) * size.height)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await live.call('Input.dispatchDragEvent', { type, x, y, data, modifiers: 0 })
  return { dropped: paths.length }
}

/**
 * «Fix the view»: vuelve a elegir la página que se ve (no una ventana emergente), le quita y le vuelve a poner el
 * tamaño del panel con una conexión nueva y toma un fotograma nuevo.
 * @returns la dirección de la página que se ve ahora.
 */
export async function localAgentBrowserRepair(): Promise<{ readonly url: string }> {
  popupCache = undefined
  seenPage = undefined
  const old = session
  session = undefined
  old?.close()
  const current = await livePage(readState())
  if (current === undefined) return { url: '' }
  const { live, page } = current
  live.emulationKey = ''
  live.castKey = ''
  await live.call('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
  await prepare(live).catch(() => undefined)
  await live.capture().catch(() => undefined)
  return { url: page.url }
}

/**
 * La barra de dirección: abrir una dirección, atrás, adelante o recargar. Arranca el navegador si hace falta (los
 * enlaces del chat se abren aquí) y toma el control, como cualquier gesto del usuario.
 * @param navigation - lo pedido.
 */
export async function localAgentBrowserNavigate(navigation: LocalAgentBrowserNavigation): Promise<{ readonly url: string }> {
  takeControl()
  const url = navigation.action === 'url' ? localAddressToUrl(navigation.url) : ''
  if (navigation.action === 'url' && url === '') throw new Error('Type an address.')
  const state = await ensureBrowser()
  let current = await livePage(state)
  // Sin ninguna pestaña abierta (las cerró el agente o la web), se abre una.
  if (current === undefined) {
    const socket = await browserSocket(state)
    if (socket !== undefined) await cdp(socket, 'Target.createTarget', { url: 'about:blank' }).catch(() => undefined)
    popupCache = undefined
    current = await livePage(state)
  }
  if (current === undefined) throw new Error('The browser has no page open.')
  const { live } = current
  if (navigation.action === 'url') {
    await live.call('Page.navigate', { url })
    return { url }
  }
  if (navigation.action === 'reload') {
    await live.call('Page.reload')
    return { url: current.page.url }
  }
  const history = await live.call<{ currentIndex: number; entries: readonly { id: number; url: string }[] }>('Page.getNavigationHistory')
  const entry = history.entries[history.currentIndex + (navigation.action === 'back' ? -1 : 1)]
  if (entry !== undefined) await live.call('Page.navigateToHistoryEntry', { entryId: entry.id })
  return { url: entry?.url ?? current.page.url }
}

const plain = (domain: string): string => domain.replace(/^\./, '').toLowerCase()

async function browserSocket(state: AgentBrowserState): Promise<string | undefined> {
  return (await json<{ webSocketDebuggerUrl?: string }>(state, '/json/version'))?.webSocketDebuggerUrl
}

/**
 * Webs con sesión guardada en el perfil del navegador.
 * @returns una fila por web (sin el punto inicial de las cookies de dominio), de más a menos cookies.
 */
export async function localAgentBrowserSites(): Promise<{ readonly sites: readonly LocalAgentBrowserSite[] }> {
  const state = readState()
  const socket = state === undefined ? undefined : await browserSocket(state)
  if (socket === undefined) return { sites: [] }
  const { cookies } = await cdp<{ cookies: CdpCookie[] }>(socket, 'Storage.getCookies')
  const counts = new Map<string, number>()
  for (const cookie of cookies) counts.set(plain(cookie.domain), (counts.get(plain(cookie.domain)) ?? 0) + 1)
  const sites = [...counts].map(([domain, count]) => ({ domain, cookies: count }))
  return { sites: sites.sort((a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain)) }
}

/**
 * Olvida la sesión de una web: sus cookies (también las de sus subdominios) y lo que guardó en el navegador.
 * @param domain - la web, como la devuelve localAgentBrowserSites.
 * @returns cuántas cookies se han borrado.
 */
export async function localAgentBrowserForget(domain: string): Promise<{ readonly removed: number }> {
  const state = readState()
  const socket = state === undefined ? undefined : await browserSocket(state)
  if (state === undefined || socket === undefined) return { removed: 0 }
  const target = plain(domain)
  const matches = (cookie: CdpCookie): boolean => plain(cookie.domain) === target || plain(cookie.domain).endsWith(`.${target}`)
  const { cookies } = await cdp<{ cookies: CdpCookie[] }>(socket, 'Storage.getCookies')
  const gone = cookies.filter(matches)
  // Cookie a cookie, por una pestaña (Network.deleteCookies): las de las demás webs no se tocan. Antes se vaciaban
  // todas y se volvían a poner las otras, y si Edge rechazaba alguna se cerraba la sesión de todas las webs.
  const page = (await json<CdpTarget[]>(state, '/json/list'))?.find(item => item.type === 'page' && item.webSocketDebuggerUrl !== undefined)
  if (page?.webSocketDebuggerUrl === undefined) throw new Error('Open a page in the browser first.')
  await cdpMany(page.webSocketDebuggerUrl, gone.map(cookie => ({
    method: 'Network.deleteCookies', params: { name: cookie.name, domain: cookie.domain, path: cookie.path },
  })))
  for (const origin of [`https://${target}`, `http://${target}`]) {
    await cdp(socket, 'Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => undefined)
  }
  const left = (await cdp<{ cookies: CdpCookie[] }>(socket, 'Storage.getCookies')).cookies.filter(matches).length
  return { removed: gone.length - left }
}

/** Varias órdenes seguidas por la misma conexión de un solo uso (sin abrir una por cookie). */
function cdpMany(url: string, commands: readonly { method: string; params: Record<string, unknown> }[]): Promise<void> {
  if (commands.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let answered = 0
    const timer = setTimeout(() => { socket.close(); reject(new Error('sin respuesta')) }, 10_000)
    socket.addEventListener('open', () => {
      commands.forEach((command, index) => {
        socket.send(JSON.stringify({ id: index + 1, method: command.method, params: command.params }))
      })
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number }
      if (message.id === undefined || ++answered < commands.length) return
      clearTimeout(timer)
      socket.close()
      resolve()
    })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('no se puede conectar')) })
  })
}

/** Una contraseña guardada: su nombre (el que usa el agente), la web y el valor cifrado. */
interface StoredSecret {
  readonly name: string
  readonly site: string
  readonly value: string
}

/** Lo que se enseña de una contraseña guardada (nunca el valor). */
export interface LocalAgentBrowserSecret {
  readonly name: string
  readonly site: string
}

/** Fichero de contraseñas guardadas (valores cifrados con DPAPI). */
export function localAgentBrowserSecretsFile(): string {
  return join(home(), 'storages', 'local-secrets.json')
}

function readSecrets(): StoredSecret[] {
  try {
    const list = JSON.parse(readFileSync(localAgentBrowserSecretsFile(), 'utf8')) as unknown
    return Array.isArray(list) ? list.filter((item: unknown): item is StoredSecret => typeof (item as StoredSecret | null)?.name === 'string' && typeof (item as StoredSecret).value === 'string') : []
  } catch {
    return []
  }
}

function writeSecrets(list: readonly StoredSecret[]): void {
  const file = localAgentBrowserSecretsFile()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 2))
  renameSync(`${file}.tmp`, file)
}

const powershell = (script: string, input: string, timeout: number): Promise<string> => new Promise((resolve, reject) => {
  // Codificada: el guion tiene varias líneas y un bloque de C#, que por la línea de órdenes no llegarían enteros.
  const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout }, (error, stdout) => {
      if (error !== null) reject(new Error(error.message))
      else resolve(stdout.trim())
    })
  child.stdin?.end(input)
})

/** Cifra con DPAPI (usuario actual de Windows). El valor va por la entrada estándar, nunca en la línea de órdenes. */
function protect(value: string): Promise<string> {
  return powershell('[Console]::InputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Security; $v = [Console]::In.ReadToEnd(); '
    + "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v), $null, 'CurrentUser'))", value, 20_000)
}

/** Cifra (protect) o descifra (unprotect) varios valores con DPAPI de una vez; van y vuelven en JSON por la entrada estándar. */
async function dpapiMany(direction: 'protect' | 'unprotect', values: readonly string[]): Promise<string[]> {
  if (values.length === 0) return []
  const step = direction === 'protect'
    ? "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v), $null, 'CurrentUser'))"
    : "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v), $null, 'CurrentUser'))"
  const out = await powershell('[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + 'Add-Type -AssemblyName System.Security; $items = [Console]::In.ReadToEnd() | ConvertFrom-Json; '
    + `$out = foreach ($v in $items) { ${step} }; ConvertTo-Json -InputObject @($out) -Compress`, JSON.stringify(values), 60_000)
  const list = JSON.parse(out === '' ? '[]' : out) as unknown
  if (!Array.isArray(list) || list.length !== values.length) throw new Error("Windows couldn't read the saved passwords.")
  return list.map(String)
}

/** Las contraseñas se desbloquean en la app durante este tiempo (y se bloquean antes al ocultar la ventana). */
const UNLOCK_MS = 5 * 60_000
let unlockedUntil = 0
let unlocking: Promise<{ readonly unlocked: boolean; readonly message?: string }> | undefined

const isUnlocked = (): boolean =>
  Date.now() < unlockedUntil || process.env.DSH_LOCAL_PASSWORDS_NO_LOCK === '1'

const requireUnlocked = (): void => {
  if (!isUnlocked()) throw new Error('Saved passwords are locked. Unlock them first.')
}

/**
 * Comprueba que es el usuario de Windows: con Windows Hello si lo tiene configurado y, si no, con la ventana oficial
 * «Seguridad de Windows» (CredUIPromptForWindowsCredentials), validando la contraseña con LogonUser. La contraseña se
 * queda dentro de ese proceso de PowerShell: aquí solo llega OK, CANCEL o FAIL.
 */
const VERIFY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$caption = 'DeepSeek Harness'
$message = 'Confirm it is you to see and change the passwords saved for the browser.'
try {
  [void][Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' } | Select-Object -First 1
  function Await($operation, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation)); [void]$task.Wait(-1); $task.Result }
  $availability = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
  if ($availability -eq [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]::Available) {
    $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($message)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
    if ($result -eq [Windows.Security.Credentials.UI.UserConsentVerificationResult]::Verified) { 'OK' } elseif ($result -eq [Windows.Security.Credentials.UI.UserConsentVerificationResult]::Canceled) { 'CANCEL' } else { 'FAIL' }
    exit 0
  }
} catch { }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LocalVerify {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDUI_INFO { public int cbSize; public IntPtr hwndParent; public string pszMessageText; public string pszCaptionText; public IntPtr hbmBanner; }
  [DllImport("credui.dll", CharSet = CharSet.Unicode)]
  static extern int CredUIPromptForWindowsCredentials(ref CREDUI_INFO info, int authError, ref uint package, IntPtr inBuffer, uint inSize, out IntPtr outBuffer, out uint outSize, ref bool save, int flags);
  [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredUnPackAuthenticationBuffer(int flags, IntPtr buffer, uint size, StringBuilder user, ref int userLength, StringBuilder domain, ref int domainLength, StringBuilder password, ref int passwordLength);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  const int ENUMERATE_CURRENT_USER = 0x200;
  const int ERROR_CANCELLED = 1223;
  const int ERROR_LOGON_FAILURE = 1326;
  public static string Run(IntPtr parent, string caption, string message) {
    var info = new CREDUI_INFO { hwndParent = parent, pszCaptionText = caption, pszMessageText = message };
    info.cbSize = Marshal.SizeOf(info);
    if (parent != IntPtr.Zero) SetForegroundWindow(parent);
    int error = 0;
    for (int attempt = 0; attempt < 5; attempt++) {
      uint package = 0; IntPtr buffer; uint size; bool save = false;
      int result = CredUIPromptForWindowsCredentials(ref info, error, ref package, IntPtr.Zero, 0, out buffer, out size, ref save, ENUMERATE_CURRENT_USER);
      if (result == ERROR_CANCELLED) return "CANCEL";
      if (result != 0) return "FAIL";
      var user = new StringBuilder(256); var domain = new StringBuilder(256); var password = new StringBuilder(256);
      int userLength = 256, domainLength = 256, passwordLength = 256;
      bool unpacked = CredUnPackAuthenticationBuffer(1, buffer, size, user, ref userLength, domain, ref domainLength, password, ref passwordLength)
        || CredUnPackAuthenticationBuffer(0, buffer, size, user, ref userLength, domain, ref domainLength, password, ref passwordLength);
      Marshal.Copy(new byte[size], 0, buffer, (int)size);
      Marshal.FreeCoTaskMem(buffer);
      if (!unpacked) return "FAIL";
      string name = user.ToString(), where = domain.ToString();
      int slash = name.IndexOf('\\');
      if (where.Length == 0 && slash >= 0) { where = name.Substring(0, slash); name = name.Substring(slash + 1); }
      if (where.Length == 0 && name.IndexOf('@') < 0) where = ".";
      bool same = string.Equals(name, Environment.UserName, StringComparison.OrdinalIgnoreCase) || name.IndexOf('@') >= 0;
      IntPtr token = IntPtr.Zero;
      bool ok = false;
      // Inicio de sesión interactivo y, si la directiva no lo deja, de red: los dos solo comprueban la contraseña.
      if (same) ok = LogonUser(name, where, password.ToString(), 2, 0, out token);
      if (same && !ok) ok = LogonUser(name, where, password.ToString(), 3, 0, out token);
      password.Clear();
      if (ok) { CloseHandle(token); return "OK"; }
      error = ERROR_LOGON_FAILURE;
    }
    return "FAIL";
  }
}
'@
$parent = [IntPtr]::Zero
$id = $PID
for ($i = 0; $i -lt 6 -and $parent -eq [IntPtr]::Zero; $i++) {
  $id = (Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue).ParentProcessId
  if ($null -eq $id -or $id -eq 0) { break }
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($null -ne $process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { $parent = $process.MainWindowHandle }
}
[LocalVerify]::Run($parent, $caption, $message)
`

/**
 * Desbloquea las contraseñas guardadas en la app tras confirmar que es el usuario de Windows.
 * @returns si quedan desbloqueadas (y por qué no, si no).
 */
export async function localAgentBrowserUnlock(): Promise<{ readonly unlocked: boolean; readonly message?: string }> {
  if (isUnlocked()) return { unlocked: true }
  unlocking ??= powershell(VERIFY_SCRIPT, '', 10 * 60_000)
    .then((answer) => {
      const last = answer.split(/\r?\n/).at(-1)?.trim()
      if (last === 'OK') {
        unlockedUntil = Date.now() + UNLOCK_MS
        return { unlocked: true }
      }
      return last === 'CANCEL' ? { unlocked: false } : { unlocked: false, message: "Windows couldn't confirm it's you." }
    })
    .catch(() => ({ unlocked: false, message: "Windows couldn't show the sign-in window." }))
    .finally(() => { unlocking = undefined })
  return unlocking
}

/** Si Windows Hello está configurado (huella, cara o PIN); se mira una vez por arranque, sin pedir nada. */
let helloAvailable: Promise<boolean> | undefined
const HELLO_CHECK = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [void][Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' } | Select-Object -First 1
  $task = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()))
  [void]$task.Wait(-1)
  if ($task.Result -eq [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]::Available) { 'HELLO' } else { 'PASSWORD' }
} catch { 'PASSWORD' }
`

/** @returns cómo se desbloquean las contraseñas en este PC: con Windows Hello o con la contraseña de Windows. */
export async function localAgentBrowserUnlockMethod(): Promise<{ readonly method: 'hello' | 'password' }> {
  helloAvailable ??= powershell(HELLO_CHECK, '', 20_000).then(answer => answer.split(/\r?\n/).at(-1)?.trim() === 'HELLO').catch(() => false)
  return { method: await helloAvailable ? 'hello' : 'password' }
}

/**
 * Copia de seguridad de las contraseñas guardadas, cifrada con una frase de paso (para otro PC o para no perderlas).
 * @param passphrase - la frase (8 caracteres o más); sin ella no se puede abrir.
 * @returns el fichero y cuántas lleva.
 */
export async function localAgentBrowserExportSecrets(passphrase: string): Promise<{ readonly file: string; readonly count: number }> {
  requireUnlocked()
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.')
  const list = readSecrets()
  if (list.length === 0) throw new Error('There are no saved passwords to export.')
  const values = await dpapiMany('unprotect', list.map(item => item.value))
  const plain: PlainSecret[] = list.map((item, index) => ({ name: item.name, site: item.site, value: values[index] ?? '' }))
  return { file: sealSecrets(plain, passphrase), count: plain.length }
}

/**
 * Importa una copia de seguridad: las contraseñas se vuelven a cifrar con DPAPI en este PC; las que tienen el mismo
 * nombre se sustituyen.
 * @param file - el contenido del fichero exportado.
 * @param passphrase - su frase de paso.
 * @returns cuántas se han importado.
 */
export async function localAgentBrowserImportSecrets(file: string, passphrase: string): Promise<{ readonly count: number }> {
  requireUnlocked()
  const incoming = openSecrets(file, passphrase)
    .map(item => ({ ...item, name: localSecretName(item.name) }))
    .filter(item => item.name !== '' && item.value !== '')
  if (incoming.length === 0) throw new Error('The backup has no passwords.')
  const encrypted = await dpapiMany('protect', incoming.map(item => item.value))
  const names = new Set(incoming.map(item => item.name))
  writeSecrets([
    ...readSecrets().filter(item => !names.has(item.name)),
    ...incoming.map((item, index) => ({ name: item.name, site: item.site.trim().slice(0, 200), value: encrypted[index] ?? '' })),
  ].sort((a, b) => a.name.localeCompare(b.name)))
  return { count: incoming.length }
}

/** Vuelve a bloquear las contraseñas (al ocultar o cerrar la ventana). */
export function localAgentBrowserLock(): { readonly locked: true } {
  unlockedUntil = 0
  return { locked: true }
}

/** Nombre válido para el agente y para el fichero de secretos: MAYÚSCULAS, cifras y _. */
export function localSecretName(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
}

/** @returns si están bloqueadas y, si no, las contraseñas guardadas (sin sus valores). */
export function localAgentBrowserSecrets(): {
  readonly locked: boolean
  readonly count: number
  readonly secrets: readonly LocalAgentBrowserSecret[]
} {
  const list = readSecrets()
  if (!isUnlocked()) return { locked: true, count: list.length, secrets: [] }
  return { locked: false, count: list.length, secrets: list.map(({ name, site }) => ({ name, site })) }
}

/**
 * Guarda (o cambia) una contraseña. Vale para los chats que empiecen a usar el navegador después.
 * @param name - nombre para el agente (se normaliza a MAYÚSCULAS_CON_GUIONES).
 * @param site - web donde se usa: el agente solo la puede escribir allí.
 * @param value - la contraseña; se guarda cifrada.
 * @returns el nombre con el que queda guardada.
 */
export async function localAgentBrowserSaveSecret(name: string, site: string, value: string): Promise<{ readonly name: string }> {
  requireUnlocked()
  const key = localSecretName(name)
  if (key === '') throw new Error('Give the password a name (letters or numbers).')
  if (value === '') throw new Error('The password is empty.')
  // El agente solo la puede escribir en esa web (local-browser-context.ts lo comprueba).
  if (site.trim() === '') throw new Error('Add the site where this password is used (e.g. example.com).')
  const encrypted = await protect(value)
  writeSecrets([...readSecrets().filter(item => item.name !== key), { name: key, site: site.trim().slice(0, 200), value: encrypted }]
    .sort((a, b) => a.name.localeCompare(b.name)))
  return { name: key }
}

/** Borra una contraseña guardada. */
export function localAgentBrowserRemoveSecret(name: string): { readonly removed: boolean } {
  requireUnlocked()
  const list = readSecrets()
  const next = list.filter(item => item.name !== name)
  writeSecrets(next)
  return { removed: next.length !== list.length }
}

// Al cerrar la app se cierra el Edge compartido (se vuelve a abrir al usarlo; las sesiones quedan en su perfil).
process.once('exit', () => {
  const state = readState()
  if (state === undefined) return
  try { process.kill(state.pid) } catch { /* ya estaba cerrado */ }
})

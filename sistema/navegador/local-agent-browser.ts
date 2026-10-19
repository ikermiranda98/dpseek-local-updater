/**
 * Navegador del agente, lado del Host (añadido por dpseek-local-updater).
 *
 * El agente usa un Edge compartido que arranca el proveedor de navegador (agent-browser-launcher.mjs) y anota en
 * `<DSH_HOME>/storages/local-agent-browser.json` (puerto de depuración y proceso). Desde aquí, por ese puerto:
 * - la imagen de la página que está usando, para la pestaña «Agent browser» de la barra lateral, al tamaño exacto en
 *   píxeles del panel (nítida a cualquier tamaño y en cualquier pantalla);
 * - el tamaño de la página: ajustada al panel, escritorio, pantalla ancha, tableta o móvil;
 * - las webs con sesión guardada en su perfil y borrar la de una web (cookies y datos guardados);
 * - «Take control»: el usuario usa ese Edge desde el panel (ratón, rueda y teclado) mientras las acciones del agente
 *   en el navegador esperan; lo que escribe va directo a la página, nunca al chat;
 * - contraseñas guardadas («Saved passwords»): cifradas con DPAPI de Windows (solo este usuario de Windows las
 *   descifra); el navegador del agente las escribe en las páginas por su nombre y el modelo nunca ve el valor;
 * - al cerrar la app, se cierra ese Edge.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface AgentBrowserState {
  readonly port: number
  readonly pid: number
}

interface CdpTarget {
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

/** Lo que enseña la barra lateral: la página que usa el agente, como imagen JPEG en base64. */
export interface LocalAgentBrowserFrame {
  readonly running: boolean
  readonly url: string
  readonly title: string
  readonly image: string | null
  /** El usuario tiene el control (el agente espera). */
  readonly control: boolean
  /** Tamaño de la página en píxeles CSS (el de la imagen, sin escalar). */
  readonly viewport: { readonly width: number; readonly height: number }
  /** Modo de tamaño elegido. */
  readonly mode: LocalAgentBrowserMode
}

/** Tamaños de página: como el panel, o los fijos de escritorio, pantalla ancha, tableta y móvil. */
export type LocalAgentBrowserMode = 'fit' | 'desktop' | 'wide' | 'tablet' | 'mobile'

/** Qué se pide para cada modo (ancho y alto en píxeles CSS, densidad, si es un dispositivo móvil). */
const MODES: Record<Exclude<LocalAgentBrowserMode, 'fit'>, { width: number; height: number; scale: number; mobile: boolean }> = {
  // Escritorio también se fija: al cerrar una emulación, Edge sin ventana no vuelve a su tamaño (se quedaba en 320 × 180).
  desktop: { width: 1280, height: 800, scale: 1, mobile: false },
  wide: { width: 1920, height: 1080, scale: 1, mobile: false },
  tablet: { width: 768, height: 1024, scale: 2, mobile: false },
  mobile: { width: 375, height: 812, scale: 3, mobile: true },
}
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'

/** Un gesto del usuario en el panel; las posiciones van de 0 a 1 sobre la imagen. */
export type LocalAgentBrowserInput =
  | { readonly kind: 'click'; readonly x: number; readonly y: number; readonly button: 'left' | 'right' | 'middle'; readonly clickCount: number }
  | { readonly kind: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly key: string; readonly code: string; readonly keyCode: number; readonly modifiers: number }

interface ControlState {
  active: boolean
  timer?: ReturnType<typeof setTimeout>
  mode?: LocalAgentBrowserMode
  /** Ajustada al panel: su tamaño en píxeles CSS. */
  fit?: { width: number; height: number }
}

/**
 * La emulación de tamaño vive mientras dura la conexión que la pidió: se guarda una abierta por página. Siempre hay una
 * (también en escritorio): al cerrarla, Edge sin ventana no recupera su tamaño.
 */
interface Emulation {
  readonly targetUrl: string
  readonly key: string
  readonly socket: WebSocket
}
let emulation: Emulation | undefined

/** Sin gestos durante este tiempo, el control vuelve solo al agente (para que no se quede esperando para siempre). */
const CONTROL_IDLE_MS = 5 * 60_000

// Compartido con el proveedor del navegador (local-browser-context.ts), que está en el mismo proceso del Host.
const control = ((globalThis as Record<symbol, unknown>)[Symbol.for('dpseek-local-updater.agent-browser-control')] ??= { active: false }) as ControlState

const armIdle = (): void => {
  clearTimeout(control.timer)
  if (control.active) control.timer = setTimeout(() => { control.active = false }, CONTROL_IDLE_MS)
}

/**
 * El usuario toma o devuelve el control del navegador del agente.
 * @param active - true para tomarlo.
 * @returns el estado resultante.
 */
export function localAgentBrowserViewport(mode: LocalAgentBrowserMode, fit?: { width: number; height: number }): { readonly mode: LocalAgentBrowserMode } {
  control.mode = mode
  if (fit !== undefined) control.fit = { width: Math.max(320, Math.round(fit.width)), height: Math.max(240, Math.round(fit.height)) }
  return { mode }
}

/** Pone a la página el tamaño del modo elegido (o se lo quita, en escritorio). */
async function applyEmulation(targetUrl: string): Promise<void> {
  const mode = control.mode ?? 'desktop'
  const spec = mode === 'fit'
    ? control.fit === undefined ? MODES.desktop : { ...control.fit, scale: 1, mobile: control.fit.width < 768 }
    : MODES[mode]
  const key = spec === undefined ? '' : JSON.stringify(spec)
  if (emulation?.targetUrl === targetUrl && emulation.key === key) return
  emulation?.socket.close()
  emulation = undefined
  if (spec === undefined) return
  const socket = new WebSocket(targetUrl)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => { resolve() }, { once: true })
    socket.addEventListener('error', () => { reject(new Error('emulación: no se puede conectar')) }, { once: true })
  })
  let id = 0
  const send = (method: string, params: Record<string, unknown>): void => { socket.send(JSON.stringify({ id: ++id, method, params })) }
  send('Emulation.setDeviceMetricsOverride', { width: spec.width, height: spec.height, deviceScaleFactor: spec.scale, mobile: spec.mobile })
  send('Emulation.setTouchEmulationEnabled', { enabled: spec.mobile, maxTouchPoints: spec.mobile ? 5 : 1 })
  if (spec.mobile) send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'Android' })
  emulation = { targetUrl, key, socket }
  socket.addEventListener('close', () => { if (emulation?.socket === socket) emulation = undefined })
}

export function localAgentBrowserControl(active: boolean): { readonly control: boolean } {
  control.active = active
  armIdle()
  return { control: control.active }
}

/** Una web con sesión (cookies) guardada en el perfil del Edge del agente. */
export interface LocalAgentBrowserSite {
  readonly domain: string
  readonly cookies: number
}

const home = (): string => process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Fichero donde el lanzador anota el Edge del agente. */
export function localAgentBrowserStateFile(): string {
  return join(home(), 'storages', 'local-agent-browser.json')
}

/** Carpeta del perfil del Edge del agente (aquí se guardan las sesiones iniciadas). */
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

async function json<T>(state: AgentBrowserState, path: string): Promise<T | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(state.port)}${path}`, { signal: AbortSignal.timeout(1500) })
    return response.ok ? await response.json() as T : undefined
  } catch {
    return undefined
  }
}

/** Una orden por el protocolo de depuración de Edge, en una conexión de un solo uso. */
async function cdp<T>(url: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await cdpSequence(url, [{ method, params }]))[0] as T
}

/** Varias órdenes seguidas y en orden por la misma conexión (pulsar y soltar, por ejemplo). */
function cdpSequence(url: string, commands: readonly { method: string; params?: Record<string, unknown> }[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const results: unknown[] = []
    const name = commands.map(command => command.method).join(', ')
    const timer = setTimeout(() => { socket.close(); reject(new Error(`${name}: sin respuesta`)) }, 5000)
    const send = (index: number): void => {
      const command = commands[index]
      if (command === undefined) {
        clearTimeout(timer)
        socket.close()
        resolve(results)
        return
      }
      socket.send(JSON.stringify({ id: index + 1, method: command.method, params: command.params ?? {} }))
    }
    socket.addEventListener('open', () => { send(0) })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (message.id === undefined || message.id !== results.length + 1) return
      if (message.error !== undefined) {
        clearTimeout(timer)
        socket.close()
        reject(new Error(`${commands[message.id - 1]?.method ?? name}: ${message.error.message}`))
        return
      }
      results.push(message.result)
      send(results.length)
    })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${name}: no se puede conectar`)) })
  })
}

/** La página que conviene enseñar: la primera con contenido (Edge las lista de la más reciente a la más antigua). */
function currentPage(targets: readonly CdpTarget[]): CdpTarget | undefined {
  const pages = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl !== undefined)
  return pages.find(page => !page.url.startsWith('about:blank') && !page.url.startsWith('edge://')) ?? pages[0]
}

/**
 * La página que está usando el agente, para la barra lateral.
 * @returns su dirección, título e imagen; `running: false` si el Edge del agente no está en marcha.
 */
export async function localAgentBrowserFrame(size?: { width: number; height: number }): Promise<LocalAgentBrowserFrame> {
  const idle = { running: false, url: '', title: '', image: null, control: control.active, viewport: { width: 1280, height: 800 }, mode: control.mode ?? 'desktop' }
  const state = readState()
  if (state === undefined) return idle
  const targets = await json<CdpTarget[]>(state, '/json/list')
  if (targets === undefined) return idle
  const page = currentPage(targets)
  if (page?.webSocketDebuggerUrl === undefined) return { ...idle, running: true }
  const base = { ...idle, running: true, url: page.url, title: page.title }
  try {
    await applyEmulation(page.webSocketDebuggerUrl).catch(() => undefined)
    const metrics = await cdp<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>(
      page.webSocketDebuggerUrl, 'Page.getLayoutMetrics')
    const view = metrics.cssVisualViewport
    const viewport = { width: Math.round(view.clientWidth), height: Math.round(view.clientHeight) }
    // Escala para que la imagen tenga justo los píxeles del panel (sin pasar de 3× ni bajar de 0,2×).
    const wanted = size === undefined ? 1 : Math.min(size.width / view.clientWidth, size.height / view.clientHeight)
    const scale = Math.min(3, Math.max(0.2, Number.isFinite(wanted) && wanted > 0 ? wanted : 1))
    const shot = await cdp<{ data: string }>(page.webSocketDebuggerUrl, 'Page.captureScreenshot', {
      format: 'webp', quality: 90, captureBeyondViewport: false,
      clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale },
    })
    return { ...base, image: shot.data, viewport }
  } catch {
    return base
  }
}

/**
 * Un gesto del usuario en el panel, llevado a la página que se ve (la misma de la imagen).
 * Solo con el control tomado: así el panel no puede mover la página por un clic sin querer.
 * @param input - el gesto.
 * @returns si se ha llevado a la página.
 */
export async function localAgentBrowserInput(input: LocalAgentBrowserInput): Promise<{ readonly sent: boolean }> {
  if (!control.active) return { sent: false }
  armIdle()
  const state = readState()
  const targets = state === undefined ? undefined : await json<CdpTarget[]>(state, '/json/list')
  const url = targets === undefined ? undefined : currentPage(targets)?.webSocketDebuggerUrl
  if (url === undefined) return { sent: false }
  if (input.kind === 'text') {
    await cdp(url, 'Input.insertText', { text: input.text })
    return { sent: true }
  }
  if (input.kind === 'key') {
    const base = { key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode, nativeVirtualKeyCode: input.keyCode, modifiers: input.modifiers }
    await cdpSequence(url, [
      { method: 'Input.dispatchKeyEvent', params: { ...base, type: 'rawKeyDown' } },
      { method: 'Input.dispatchKeyEvent', params: { ...base, type: 'keyUp' } },
    ])
    return { sent: true }
  }
  // Las posiciones del panel (0..1 sobre la imagen) pasan a píxeles CSS de la ventana de la página.
  const metrics = await cdp<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(url, 'Page.getLayoutMetrics')
  const x = Math.round(Math.min(1, Math.max(0, input.x)) * metrics.cssVisualViewport.clientWidth)
  const y = Math.round(Math.min(1, Math.max(0, input.y)) * metrics.cssVisualViewport.clientHeight)
  if (input.kind === 'wheel') {
    await cdp(url, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: input.deltaX, deltaY: input.deltaY })
    return { sent: true }
  }
  if ((control.mode === 'mobile' || (control.mode === 'fit' && (control.fit?.width ?? 1000) < 768)) && input.button === 'left') {
    await cdpSequence(url, [
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchStart', touchPoints: [{ x, y }] } },
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchEnd', touchPoints: [] } },
    ])
    return { sent: true }
  }
  const click = { x, y, button: input.button, clickCount: input.clickCount }
  await cdpSequence(url, [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } },
    { method: 'Input.dispatchMouseEvent', params: { ...click, type: 'mousePressed' } },
    { method: 'Input.dispatchMouseEvent', params: { ...click, type: 'mouseReleased' } },
  ])
  return { sent: true }
}

const plain = (domain: string): string => domain.replace(/^\./, '').toLowerCase()

async function browserSocket(state: AgentBrowserState): Promise<string | undefined> {
  return (await json<{ webSocketDebuggerUrl?: string }>(state, '/json/version'))?.webSocketDebuggerUrl
}

/**
 * Webs con sesión guardada en el perfil del Edge del agente.
 * @returns una fila por web (sin el punto inicial de las cookies de dominio), de más a menos cookies.
 */
export async function localAgentBrowserSites(): Promise<{ readonly sites: readonly LocalAgentBrowserSite[] }> {
  const state = readState()
  const socket = state === undefined ? undefined : await browserSocket(state)
  if (socket === undefined) return { sites: [] }
  const { cookies } = await cdp<{ cookies: CdpCookie[] }>(socket, 'Storage.getCookies')
  const counts = new Map<string, number>()
  for (const cookie of cookies) counts.set(plain(cookie.domain), (counts.get(plain(cookie.domain)) ?? 0) + 1)
  return { sites: [...counts].map(([domain, count]) => ({ domain, cookies: count })).sort((a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain)) }
}

/**
 * Olvida la sesión de una web: sus cookies (también las de sus subdominios) y lo que guardó en el navegador.
 * @param domain - la web, como la devuelve localAgentBrowserSites.
 * @returns cuántas cookies se han borrado.
 */
export async function localAgentBrowserForget(domain: string): Promise<{ readonly removed: number }> {
  const state = readState()
  const socket = state === undefined ? undefined : await browserSocket(state)
  if (socket === undefined) return { removed: 0 }
  const target = plain(domain)
  const matches = (cookie: CdpCookie): boolean => plain(cookie.domain) === target || plain(cookie.domain).endsWith(`.${target}`)
  const { cookies } = await cdp<{ cookies: CdpCookie[] }>(socket, 'Storage.getCookies')
  const keep = cookies.filter(cookie => !matches(cookie))
  // Edge no borra cookies sueltas desde el navegador entero: se vacían y se vuelven a poner las de las demás webs.
  await cdp(socket, 'Storage.clearCookies')
  if (keep.length > 0) await cdp(socket, 'Storage.setCookies', { cookies: keep })
  for (const origin of [`https://${target}`, `http://${target}`]) {
    await cdp(socket, 'Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => undefined)
  }
  return { removed: cookies.length - keep.length }
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
    return Array.isArray(list) ? list.filter((item): item is StoredSecret => typeof item?.name === 'string' && typeof item.value === 'string') : []
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

/** Cifra con DPAPI (usuario actual de Windows). El valor va por la entrada estándar, nunca en la línea de órdenes. */
function protect(value: string): Promise<string> {
  const script = 'Add-Type -AssemblyName System.Security; $v = [Console]::In.ReadToEnd(); '
    + "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v), $null, 'CurrentUser'))"
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 },
      (error, stdout) => { if (error !== null) reject(error); else resolve(stdout.trim()) })
    child.stdin?.end(value)
  })
}

/** Nombre válido para el agente y para el fichero de secretos: MAYÚSCULAS, cifras y _. */
export function localSecretName(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
}

/** @returns las contraseñas guardadas, sin sus valores. */
export function localAgentBrowserSecrets(): { readonly secrets: readonly LocalAgentBrowserSecret[] } {
  return { secrets: readSecrets().map(({ name, site }) => ({ name, site })) }
}

/**
 * Guarda (o cambia) una contraseña. Vale para los chats que empiecen a usar el navegador después.
 * @param name - nombre para el agente (se normaliza a MAYÚSCULAS_CON_GUIONES).
 * @param site - web donde se usa (solo para que el agente y tú lo sepáis).
 * @param value - la contraseña; se guarda cifrada.
 * @returns el nombre con el que queda guardada.
 */
export async function localAgentBrowserSaveSecret(name: string, site: string, value: string): Promise<{ readonly name: string }> {
  const key = localSecretName(name)
  if (key === '') throw new Error('Give the password a name (letters or numbers).')
  if (value === '') throw new Error('The password is empty.')
  const encrypted = await protect(value)
  writeSecrets([...readSecrets().filter(item => item.name !== key), { name: key, site: site.trim().slice(0, 200), value: encrypted }]
    .sort((a, b) => a.name.localeCompare(b.name)))
  return { name: key }
}

/** Borra una contraseña guardada. */
export function localAgentBrowserRemoveSecret(name: string): { readonly removed: boolean } {
  const list = readSecrets()
  const next = list.filter(item => item.name !== name)
  writeSecrets(next)
  return { removed: next.length !== list.length }
}

// Al cerrar la app se cierra el Edge del agente (se vuelve a abrir al usarlo; las sesiones quedan en su perfil).
process.once('exit', () => {
  const state = readState()
  if (state === undefined) return
  try { process.kill(state.pid) } catch { /* ya estaba cerrado */ }
})

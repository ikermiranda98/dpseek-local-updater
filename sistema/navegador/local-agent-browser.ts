/**
 * Navegador del agente, lado del Host (añadido por dpseek-local-updater).
 *
 * El agente usa un Edge compartido que arranca el proveedor de navegador (agent-browser-launcher.mjs) y anota en
 * `<DSH_HOME>/storages/local-agent-browser.json` (puerto de depuración y proceso). Desde aquí, por ese puerto:
 * - la imagen de la página que está usando, para la pestaña «Agent browser» de la barra lateral;
 * - las webs con sesión guardada en su perfil y borrar la de una web (cookies y datos guardados);
 * - al cerrar la app, se cierra ese Edge.
 */

import { readFileSync } from 'node:fs'
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
function cdp<T>(url: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => { socket.close(); reject(new Error(`${method}: sin respuesta`)) }, 5000)
    socket.addEventListener('open', () => { socket.send(JSON.stringify({ id: 1, method, params })) })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: T; error?: { message: string } }
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result as T)
    })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${method}: no se puede conectar`)) })
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
export async function localAgentBrowserFrame(): Promise<LocalAgentBrowserFrame> {
  const idle = { running: false, url: '', title: '', image: null }
  const state = readState()
  if (state === undefined) return idle
  const targets = await json<CdpTarget[]>(state, '/json/list')
  if (targets === undefined) return idle
  const page = currentPage(targets)
  if (page?.webSocketDebuggerUrl === undefined) return { running: true, url: '', title: '', image: null }
  try {
    const shot = await cdp<{ data: string }>(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'jpeg', quality: 72 })
    return { running: true, url: page.url, title: page.title, image: shot.data }
  } catch {
    return { running: true, url: page.url, title: page.title, image: null }
  }
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

// Al cerrar la app se cierra el Edge del agente (se vuelve a abrir al usarlo; las sesiones quedan en su perfil).
process.once('exit', () => {
  const state = readState()
  if (state === undefined) return
  try { process.kill(state.pid) } catch { /* ya estaba cerrado */ }
})

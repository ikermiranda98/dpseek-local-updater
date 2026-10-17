/**
 * Actualizar Ollama desde la app (añadido por dpseek-local-updater).
 *
 * Compara la versión de Ollama instalada con la última publicada en GitHub y, si
 * se pide, la instala igual que el propio Ollama: descarga `OllamaSetup.exe` y lo
 * ejecuta en silencio con los mismos parámetros que su actualizador. Antes espera a
 * que terminen las respuestas en marcha (el instalador cierra Ollama) y después
 * vuelve a listar los modelos y a medir el modelo por defecto para la versión nueva
 * (los demás se miden solos al abrir la app, como siempre que cambia Ollama).
 * Solo Windows, que es donde se instala esta versión.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { localOptimizeModel, localRefreshModels } from './local-optimize.ts'

/** Por dónde va la actualización. */
export interface LocalOllamaUpdateState {
  readonly phase: 'idle' | 'waiting' | 'downloading' | 'installing' | 'starting' | 'done' | 'error'
  /** Descarga, 0–100. */
  readonly percent?: number
  /** Respuestas en marcha que se esperan antes de instalar. */
  readonly waitingFor?: number
  readonly message?: string
  readonly version?: string
}

/** Lo que el selector enseña: versiones, novedades y la actualización en curso. */
export interface LocalOllamaUpdateInfo {
  readonly installed: string | null
  readonly latest: string | null
  readonly available: boolean
  /** Novedades de la versión nueva, una por línea, sin enlaces ni formato. */
  readonly highlights: readonly string[]
  readonly url: string | null
  readonly state: LocalOllamaUpdateState
}

interface Release {
  readonly version: string
  readonly highlights: readonly string[]
  readonly url: string
  readonly installer: string | null
  readonly checkedAt: number
}

/** GitHub limita las consultas sin cuenta: como mucho una cada 6 horas (o al pedirlo). */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const RELEASES = 'https://api.github.com/repos/ollama/ollama/releases/latest'

let state: LocalOllamaUpdateState = { phase: 'idle' }
let release: Release | undefined

const storages = (): string => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages')
const cacheFile = (): string => join(storages(), 'local-ollama-update.json')

function settings(): { ollama: string; defaultModel?: string } {
  try {
    const parsed = JSON.parse(readFileSync(join(storages(), 'local-arranque.json'), 'utf8')) as { ollama?: unknown; defaultModel?: unknown }
    return {
      ollama: typeof parsed.ollama === 'string' ? parsed.ollama : 'http://127.0.0.1:11434',
      ...typeof parsed.defaultModel === 'string' ? { defaultModel: parsed.defaultModel } : {},
    }
  } catch {
    return { ollama: 'http://127.0.0.1:11434' }
  }
}

/** Versión numérica comparable: «v0.40.5» → [0, 40, 5]. */
function parts(version: string): number[] {
  return version.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
}

function newer(latest: string, installed: string): boolean {
  const [a, b] = [parts(latest), parts(installed)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

async function installedVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${settings().ollama}/api/version`, { signal: AbortSignal.timeout(4000) })
    const body = await response.json() as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/** Las novedades del Release, en frases: viñetas sin enlaces, menciones ni formato. */
function highlightsOf(body: string): string[] {
  return body.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*] /.test(line))
    .map((line) => line.replace(/^[-*] /, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+by @\S+.*$/, '')
      .replace(/\s+in https?:\/\/\S+$/, '')
      .replace(/[`*_]/g, '')
      .trim())
    .filter((line) => line.length > 0 && !/^(new contributors|full changelog)|made their first contribution/i.test(line))
    .slice(0, 8)
}

async function latestRelease(force: boolean): Promise<Release | undefined> {
  if (release === undefined) {
    try { release = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Release } catch { /* sin caché */ }
  }
  if (!force && release !== undefined && Date.now() - release.checkedAt < CHECK_EVERY_MS) return release
  try {
    const response = await fetch(RELEASES, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dpseek-local-updater' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return release
    const body = await response.json() as {
      tag_name?: unknown; body?: unknown; html_url?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[]
    }
    if (typeof body.tag_name !== 'string') return release
    const installer = body.assets?.find((asset) => asset.name === 'OllamaSetup.exe')?.browser_download_url
    release = {
      version: body.tag_name.replace(/^v/, ''),
      highlights: highlightsOf(typeof body.body === 'string' ? body.body : ''),
      url: typeof body.html_url === 'string' ? body.html_url : `https://github.com/ollama/ollama/releases/tag/${body.tag_name}`,
      installer: typeof installer === 'string' ? installer : null,
      checkedAt: Date.now(),
    }
    try {
      mkdirSync(storages(), { recursive: true })
      writeFileSync(cacheFile(), JSON.stringify(release))
    } catch { /* la caché es opcional */ }
  } catch {
    // Sin conexión: se usa lo último que se supo.
  }
  return release
}

/**
 * @param force - consultar GitHub aunque se haya hecho hace poco.
 * @returns versiones, novedades y estado de la actualización.
 */
export async function localOllamaUpdateInfo(force = false): Promise<LocalOllamaUpdateInfo> {
  const [installed, latest] = await Promise.all([installedVersion(), latestRelease(force)])
  return {
    installed,
    latest: latest?.version ?? null,
    available: process.platform === 'win32' && installed !== null && latest !== undefined
      && latest.installer !== null && newer(latest.version, installed),
    highlights: latest?.highlights ?? [],
    url: latest?.url ?? null,
    state,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) })
  if (!response.ok || response.body === null) throw new Error(`could not download the installer (HTTP ${String(response.status)})`)
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) state = { ...state, percent: Math.floor(received / total * 100) }
  })
  await pipeline(body, createWriteStream(file))
}

function install(file: string, log: string): Promise<number> {
  // Los mismos parámetros que usa el actualizador de Ollama para Windows.
  const args = ['/CLOSEAPPLICATIONS', `/LOG=${log}`, '/FORCECLOSEAPPLICATIONS', '/SP', '/NOCANCEL', '/SILENT']
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => { resolve(code ?? 1) })
  })
}

/** Ollama tras instalar: el instalador lo vuelve a abrir; si no, se abre aquí. */
async function waitForOllama(version: string): Promise<void> {
  const app = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama app.exe')
  for (let i = 0; i < 90; i++) {
    const now = await installedVersion()
    if (now !== null && !newer(version, now)) return
    if (i === 15 && existsSync(app)) spawn(app, [], { detached: true, stdio: 'ignore' }).unref()
    await sleep(2000)
  }
  throw new Error('Ollama did not start again after installing; open it from the Start menu')
}

/**
 * Empieza la actualización en segundo plano.
 * @param running - respuestas en marcha ahora (se espera a que sean cero).
 * @returns si ha empezado (no, si ya hay una en curso o no hay nada que instalar).
 */
export function localOllamaUpdateStart(running: () => number): { readonly started: boolean } {
  if (!['idle', 'done', 'error'].includes(state.phase)) return { started: false }
  const target = release
  if (process.platform !== 'win32' || target?.installer == null) return { started: false }
  const installer = target.installer
  state = { phase: 'waiting', version: target.version, waitingFor: running() }
  void (async () => {
    try {
      // El instalador cierra Ollama: con respuestas en marcha, se cortarían.
      while (running() > 0) {
        state = { ...state, phase: 'waiting', waitingFor: running() }
        await sleep(2000)
      }
      const dir = join(storages(), 'ollama-update')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `OllamaSetup-${target.version}.exe`)
      state = { phase: 'downloading', version: target.version, percent: 0 }
      await download(installer, file)
      state = { phase: 'installing', version: target.version }
      const code = await install(file, join(dir, 'install.log'))
      if (code !== 0) throw new Error(`the Ollama installer ended with code ${String(code)} (see ${join(dir, 'install.log')})`)
      state = { phase: 'starting', version: target.version }
      await waitForOllama(target.version)
      rmSync(file, { force: true })
      await localRefreshModels().catch(() => undefined)
      // El modelo por defecto se mide ya (con su anillo en el selector); los demás, al abrir la app.
      const model = settings().defaultModel
      if (model !== undefined) localOptimizeModel(model)
      state = { phase: 'done', version: target.version, ...model === undefined ? {} : { message: `Re-measuring ${model} for this version.` } }
    } catch (error) {
      state = { phase: 'error', version: target.version, message: error instanceof Error ? error.message : String(error) }
    }
  })()
  return { started: true }
}

/** Lo que cambia la versión nueva de la app para las funciones locales (`local-update-info.json` de su Release). */
export interface LocalAppUpdateNotes {
  readonly version: string
  readonly level: 'green' | 'amber' | 'red'
  readonly headline: string
  readonly detail: string
}

/** Dirección de los Releases, la misma que usa el actualizador de la app (el Host corre con el ejecutable de Electron). */
function appFeedUrl(): string | undefined {
  if (process.env.DSH_LOCAL_INFORME_URL) return process.env.DSH_LOCAL_INFORME_URL.replace(/\/+$/, '')
  const resources = (process as { resourcesPath?: string }).resourcesPath ?? join(dirname(process.execPath), 'resources')
  try {
    const yml = readFileSync(join(resources, 'app-update.yml'), 'utf8')
    return /^url:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1]?.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/**
 * @param version - versión nueva de la app.
 * @returns sus novedades para las funciones locales, o `null` si no se pueden leer o son de otra versión.
 */
export async function localAppUpdateNotes(version: string): Promise<LocalAppUpdateNotes | null> {
  const url = appFeedUrl()
  if (url === undefined || version === '') return null
  try {
    const response = await fetch(`${url}/local-update-info.json`, { signal: AbortSignal.timeout(8000), cache: 'no-store' })
    if (!response.ok) return null
    const report = await response.json() as Partial<Record<keyof LocalAppUpdateNotes, unknown>>
    if (report.version !== version || typeof report.headline !== 'string' || typeof report.detail !== 'string'
      || (report.level !== 'green' && report.level !== 'amber' && report.level !== 'red')) return null
    return { version, level: report.level, headline: report.headline, detail: report.detail }
  } catch {
    return null
  }
}

/** Dónde instala Ollama su aplicación en Windows. */
const ollamaApp = (): string => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama app.exe')

/** Si Ollama responde y si su aplicación está instalada (para el aviso de encima del cuadro de texto). */
export interface LocalOllamaStatus {
  readonly running: boolean
  readonly installed: boolean
}

/** @returns si Ollama responde ahora y si se puede abrir desde aquí. */
export async function localOllamaStatus(): Promise<LocalOllamaStatus> {
  return { running: (await installedVersion()) !== null, installed: process.platform === 'win32' && existsSync(ollamaApp()) }
}

/** @returns si se ha lanzado la aplicación de Ollama (sigue arrancando por su cuenta). */
export function localOllamaOpen(): { readonly opened: boolean } {
  const app = ollamaApp()
  if (process.platform !== 'win32' || !existsSync(app)) return { opened: false }
  spawn(app, [], { detached: true, stdio: 'ignore' }).unref()
  return { opened: true }
}

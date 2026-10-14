/**
 * Botón «Optimizar» del selector de modelo (añadido por dpseek-local-updater).
 *
 * Vuelve a medir un modelo en este equipo (contexto recomendado y, en los modelos
 * densos, cuántas capas caben en la gráfica) con el mismo medidor que se usa al
 * abrir la app (sistema/contexto/calibrar.cjs). Al arrancar, arranque.cjs deja en
 * `<DSH_HOME>/storages/local-optimizar.json` lo necesario para medir cada modelo.
 * La medición va en un proceso aparte; las variantes del modelo se actualizan al
 * terminar y el nuevo recomendado se ve en la barra al volver a abrir la app.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Lo que deja arranque.cjs para poder medir cada modelo. */
interface OptimizeSpec {
  readonly calibrator: string
  readonly job: Readonly<Record<string, unknown>> & { readonly cacheFile: string }
  readonly models: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

const VARIANT = /^(.*):(?:(.+)-)?dsh-ctx-(?:auto|\d+)$/

/** Modelo de Ollama del que sale una variante de la app (o el propio id). */
function baseModel(id: string): string {
  const match = VARIANT.exec(id)
  return match === null ? id : `${match[1] ?? ''}:${match[2] ?? 'latest'}`
}

function storages(): string {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages')
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Lanza el medidor sin que herede nada de la app (en Windows, con Start-Process):
 * así no la retiene al cerrarla.
 */
function launch(file: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (process.platform === 'win32') {
    const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`
    const list = args.map(arg => quote(`"${arg}"`)).join(',')
    const command = `Start-Process -FilePath ${quote(file)} -ArgumentList ${list} -WindowStyle Hidden`
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
      env, stdio: 'ignore', windowsHide: true,
    }).on('error', () => undefined)
    return
  }
  const child = spawn(file, [...args], { env, detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

/** Estado de la medición: qué modelo se mide (null si ninguno) y cuánto lleva (0 a 1). */
export interface LocalOptimizeStatus {
  readonly running: string | null
  readonly progress: number | null
  /** Si la limpieza automática de variantes está activada. */
  readonly cleanup: boolean
}

/** Resultado del botón: si ha empezado y qué modelo se está midiendo. */
export interface LocalOptimizeResult {
  readonly started: boolean
  readonly running: string | null
}

/**
 * Qué modelo se está midiendo ahora (cadena vacía si se mide pero no se sabe
 * cuál; null si no se mide nada) y qué parte lleva hecha.
 */
export function localOptimizeStatus(): LocalOptimizeStatus {
  return { ...measureStatus(), cleanup: localCleanupEnabled() }
}

function measureStatus(): Omit<LocalOptimizeStatus, 'cleanup'> {
  const dir = storages()
  try {
    const pid = Number(readFileSync(join(dir, 'local-contexto.lock'), 'utf8').trim().split(':')[0])
    if (!alive(pid)) return { running: null, progress: null }
  } catch {
    return { running: null, progress: null }
  }
  try {
    const state = JSON.parse(readFileSync(join(dir, 'local-contexto.estado.json'), 'utf8')) as {
      model?: unknown, hechos?: unknown, total?: unknown
    }
    const done = Number(state.hechos)
    const total = Number(state.total)
    return {
      running: typeof state.model === 'string' ? state.model : '',
      progress: total > 0 && done >= 0 ? Math.min(1, done / total) : null,
    }
  } catch {
    return { running: '', progress: null }
  }
}

/**
 * Vuelve a medir un modelo ahora: descarga los modelos cargados (el usuario lo
 * ha pedido), borra su medición anterior y lanza el medidor solo para él.
 * @param modelId - id del modelo o de una de sus variantes de la app.
 */
export function localOptimizeModel(modelId: string): LocalOptimizeResult {
  const status = localOptimizeStatus()
  if (status.running !== null) return { started: false, running: status.running }
  let spec: OptimizeSpec
  try {
    spec = JSON.parse(readFileSync(join(storages(), 'local-optimizar.json'), 'utf8')) as OptimizeSpec
  } catch {
    throw new RemoteError('gateway/internal', 'No hay datos para medir: abre la app con Ollama en marcha y vuelve a intentarlo.', {})
  }
  const model = baseModel(modelId)
  const item = spec.models[model]
  if (item === undefined) {
    throw new RemoteError('gateway/internal', `Ollama no tenía el modelo ${model} al abrir la app; reiníciala y vuelve a intentarlo.`, {})
  }
  try {
    const cache = JSON.parse(readFileSync(spec.job.cacheFile, 'utf8')) as Record<string, unknown>
    if (model in cache) {
      const { [model]: _old, ...rest } = cache
      writeFileSync(spec.job.cacheFile, JSON.stringify(rest, null, 2))
    }
  } catch {
    // Sin mediciones previas.
  }
  // Este proceso es el Host: si se cierra la app, el medidor lo deja (ver calibrar.cjs).
  const job = { ...spec.job, force: true, hostPid: process.pid, models: [item] }
  launch(process.execPath, [spec.calibrator], {
    ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX_JOB: JSON.stringify(job),
  })
  return { started: true, running: model }
}

// ── Limpieza de variantes y modelos sin usar ──────────────────────────────────
// Con la limpieza activada (local-ajustes.json → limpiezaVariantes, activada por
// defecto), en Ollama solo queda la variante recomendada de cada modelo: las de
// otros tamaños se crean aquí justo antes de usarlas y arranque.cjs las borra tras
// 7 días sin uso. precarga.cjs anota cada minuto qué variantes están en uso
// (local-variantes-uso.json); con eso se sabe también qué modelos llevan 30 días
// sin usarse, para ofrecer borrarlos del disco.

const UNUSED_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function readSpec(): OptimizeSpec | undefined {
  return readJson<OptimizeSpec | undefined>(join(storages(), 'local-optimizar.json'), undefined)
}

function ollamaUrl(): string {
  const url = readSpec()?.job.ollama
  return typeof url === 'string' ? url : 'http://127.0.0.1:11434'
}

async function ollama(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Response> {
  return fetch(ollamaUrl() + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
}

/** Si la limpieza automática de variantes está activada (lo está por defecto). */
export function localCleanupEnabled(): boolean {
  return readJson<{ limpiezaVariantes?: unknown }>(join(storages(), 'local-ajustes.json'), {}).limpiezaVariantes !== false
}

/** Activa o desactiva la limpieza automática de variantes. */
export function localSetCleanup(enabled: boolean): { readonly cleanup: boolean } {
  const file = join(storages(), 'local-ajustes.json')
  writeFileSync(file, JSON.stringify({ ...readJson<Record<string, unknown>>(file, {}), limpiezaVariantes: enabled }, null, 1))
  return { cleanup: enabled }
}

/** Desde cuándo se anotan los usos (local-ajustes.json → usoDesde; se fija la primera vez). */
function trackingSince(now: number): number {
  const file = join(storages(), 'local-ajustes.json')
  const settings = readJson<Record<string, unknown>>(file, {})
  const since = typeof settings.usoDesde === 'string' ? Date.parse(settings.usoDesde) : Number.NaN
  if (Number.isFinite(since)) return since
  try {
    writeFileSync(file, JSON.stringify({ ...settings, usoDesde: new Date(now).toISOString() }, null, 1))
  } catch {
    // Sin poder guardarlo, se cuenta desde ahora en cada consulta: nada sale como «sin usar».
  }
  return now
}

function recordUse(name: string): void {
  const file = join(storages(), 'local-variantes-uso.json')
  try {
    writeFileSync(file, JSON.stringify({ ...readJson<Record<string, string>>(file, {}), [name]: new Date().toISOString() }))
  } catch {
    // Solo sirve para la limpieza: si no se puede anotar, se sigue.
  }
}

/**
 * Crea la variante de contexto de una selección si falta (con la limpieza
 * activada, las que no se usan se borran). Se llama antes de cada mensaje.
 */
export async function ensureLocalVariant(selection: { readonly provider: string; readonly model: string }): Promise<void> {
  if (selection.provider !== 'ollama') return
  const match = /^(.*):(?:(.+)-)?dsh-ctx-(auto|\d+)$/.exec(selection.model)
  if (match === null) return
  recordUse(selection.model)
  const shown = await ollama('/api/show', { model: selection.model })
  if (shown.ok) return
  const base = `${match[1] ?? ''}:${match[2] ?? 'latest'}`
  const spec = readSpec()
  const cache = spec === undefined ? {} : readJson<Record<string, { optimo?: number, capas?: Record<string, number> }>>(spec.job.cacheFile, {})
  const declared = Number(spec?.models[base]?.declared)
  const ctx = match[3] === 'auto' ? (cache[base]?.optimo ?? (declared > 0 ? declared : 65536)) : Number(match[3])
  const layers = cache[base]?.capas?.[String(ctx)]
  const parameters = layers === undefined ? { num_ctx: ctx } : { num_ctx: ctx, num_gpu: layers }
  await ollama('/api/create', { model: selection.model, from: base, parameters, stream: false })
}

/** Un modelo de Ollama visto desde el selector: lo que ocupa y si lleva tiempo sin usarse. */
export interface LocalModelInfo {
  readonly id: string
  readonly sizeBytes: number
  readonly lastUsed: string | null
  readonly idleDays: number
  readonly unused: boolean
}

/** Modelos de Ollama (sin variantes) con su tamaño y su último uso. */
export async function localModelsInfo(): Promise<{ readonly models: readonly LocalModelInfo[] }> {
  const response = await ollama('/api/tags')
  if (!response.ok) return { models: [] }
  const tags = ((await response.json()) as { models?: { name: string, size: number, modified_at: string }[] }).models ?? []
  const usage = readJson<Record<string, string>>(join(storages(), 'local-variantes-uso.json'), {})
  const now = Date.now()
  const tracking = trackingSince(now)
  return {
    models: tags.filter(tag => !VARIANT.test(tag.name)).map((tag) => {
      const uses = Object.entries(usage)
        .filter(([name]) => name === tag.name || baseModel(name) === tag.name)
        .map(([, date]) => Date.parse(date))
        .filter(Number.isFinite)
      const lastUse = uses.length === 0 ? undefined : Math.max(...uses)
      // Sin usos anotados, cuenta desde que se descargó o, si es anterior, desde
      // que la app empezó a anotarlos: antes de eso no se sabe si se usaba.
      const since = lastUse ?? Math.max(Date.parse(tag.modified_at) || 0, tracking)
      const idleDays = Number.isFinite(since) ? Math.floor((now - since) / DAY_MS) : 0
      return {
        id: tag.name,
        sizeBytes: tag.size,
        lastUsed: lastUse === undefined ? null : new Date(lastUse).toISOString(),
        idleDays,
        unused: idleDays >= UNUSED_DAYS,
      }
    }),
  }
}

/** Borra del disco un modelo de Ollama y todas sus variantes de la app. */
export async function localDeleteModel(modelId: string): Promise<{ readonly deleted: readonly string[] }> {
  const base = baseModel(modelId)
  const response = await ollama('/api/tags')
  if (!response.ok) throw new RemoteError('gateway/internal', 'Ollama no responde; no se ha borrado nada.', {})
  const tags = ((await response.json()) as { models?: { name: string }[] }).models ?? []
  const names = tags.map(tag => tag.name).filter(name => name === base || (VARIANT.test(name) && baseModel(name) === base))
  if (!names.includes(base)) throw new RemoteError('gateway/internal', `Ollama no tiene el modelo ${base}.`, {})
  const deleted: string[] = []
  // Primero las variantes y al final el modelo, que es el que libera el disco.
  for (const name of [...names.filter(name => name !== base), base]) {
    const result = await ollama('/api/delete', { model: name }, 'DELETE')
    if (result.ok) deleted.push(name)
  }
  if (!deleted.includes(base)) throw new RemoteError('gateway/internal', `Ollama no ha podido borrar ${base}.`, {})
  const spec = readSpec()
  if (spec !== undefined) {
    const cache = readJson<Record<string, unknown>>(spec.job.cacheFile, {})
    if (base in cache) {
      const { [base]: _old, ...rest } = cache
      writeFileSync(spec.job.cacheFile, JSON.stringify(rest, null, 2))
    }
  }
  return { deleted }
}

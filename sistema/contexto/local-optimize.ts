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

/** Resultado del botón: si ha empezado y qué modelo se está midiendo. */
export interface LocalOptimizeResult {
  readonly started: boolean
  readonly running: string | null
}

/**
 * Qué modelo se está midiendo ahora (cadena vacía si se mide pero no se sabe
 * cuál; null si no se mide nada).
 */
export function localOptimizeStatus(): { readonly running: string | null } {
  const dir = storages()
  try {
    const pid = Number(readFileSync(join(dir, 'local-contexto.lock'), 'utf8').trim().split(':')[0])
    if (!alive(pid)) return { running: null }
  } catch {
    return { running: null }
  }
  try {
    const state = JSON.parse(readFileSync(join(dir, 'local-contexto.estado.json'), 'utf8')) as { model?: unknown }
    return { running: typeof state.model === 'string' ? state.model : '' }
  } catch {
    return { running: '' }
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
  const job = { ...spec.job, force: true, models: [item] }
  launch(process.execPath, [spec.calibrator], {
    ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX_JOB: JSON.stringify(job),
  })
  return { started: true, running: model }
}

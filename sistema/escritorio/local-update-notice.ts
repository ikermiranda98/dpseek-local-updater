/**
 * Aviso antes de instalar una actualización (añadido por dpseek-local-updater).
 *
 * Cada Release publica `local-update-info.json`, preparado al compilar: compara
 * los ficheros oficiales que tocan nuestras funciones entre la versión anterior y
 * la nueva y resume lo que cambia. La confirmación de «Install and Restart» lo
 * muestra como un semáforo y ofrece saltar esa versión.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import type { UpdateDialogOptions } from './update-dialog.ts'

/** Lo que publica la compilación junto al instalador. */
interface LocalUpdateReport {
  readonly version: string
  readonly level: 'green' | 'amber' | 'red'
  readonly headline: string
  readonly detail: string
  readonly technical: string
}

const DOTS = { green: '🟢', amber: '🟡', red: '🔴' } as const

/** Índice del botón «Skip this version» en la confirmación. */
export const LOCAL_SKIP_RESPONSE = 2

const home = (): string => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

/** Dirección de los Releases, la misma que usa el sistema de actualizaciones. */
function feedUrl(): string | undefined {
  if (process.env.DSH_LOCAL_INFORME_URL) return process.env.DSH_LOCAL_INFORME_URL.replace(/\/+$/, '')
  try {
    const yml = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
    return /^url:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1]?.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

function isReport(value: unknown): value is LocalUpdateReport {
  if (typeof value !== 'object' || value === null) return false
  const report = value as Record<string, unknown>
  return typeof report.version === 'string' && ['green', 'amber', 'red'].includes(report.level as string)
    && typeof report.headline === 'string' && typeof report.detail === 'string' && typeof report.technical === 'string'
}

/**
 * @param version - versión descargada que se va a instalar.
 * @returns el informe de esa versión, o `undefined` si no se puede leer (sin red, Release antiguo…).
 */
export async function localUpdateReport(version: string): Promise<LocalUpdateReport | undefined> {
  const url = feedUrl()
  if (url === undefined || version === '') return undefined
  try {
    const response = await net.fetch(`${url}/local-update-info.json`, { signal: AbortSignal.timeout(8000), cache: 'no-store' })
    if (!response.ok) return undefined
    const report: unknown = await response.json()
    // «latest» puede haber avanzado desde la descarga: un informe de otra versión no vale.
    return isReport(report) && report.version === version ? report : undefined
  } catch {
    return undefined
  }
}

/**
 * Añade a la confirmación oficial el semáforo, el resumen, los detalles y «Skip this version».
 * @param confirmation - confirmación oficial (con o sin tareas en marcha).
 * @param report - informe de la versión, si se pudo leer.
 * @param later - texto del botón para dejarlo para más tarde.
 */
export function localUpdateConfirmation(confirmation: UpdateDialogOptions, report: LocalUpdateReport | undefined,
  later: string): UpdateDialogOptions {
  const [install = ''] = confirmation.buttons ?? []
  const buttons = [install, later, 'Skip this version']
  if (report === undefined) {
    return { ...confirmation, buttons, defaultId: 1, cancelId: 1,
      detail: `${confirmation.detail ?? ''}\n\n⚪ Couldn't read what this version changes for your local features. `
        + 'If you depend on them, check the release notes on GitHub first.' }
  }
  // El aviso de tareas en marcha es lo más urgente: se mantiene como título y el semáforo va debajo.
  const tasks = confirmation.type === 'warning'
  const headline = `${DOTS[report.level]} ${report.headline}`
  return {
    ...confirmation,
    type: report.level === 'green' && !tasks ? 'info' : 'warning',
    message: tasks ? confirmation.message : headline,
    detail: [tasks ? headline : '', report.detail, confirmation.detail ?? ''].filter((part) => part !== '').join('\n\n'),
    technicalDetails: report.technical,
    buttons, defaultId: report.level === 'green' ? 0 : 1, cancelId: 1,
  }
}

/** La versión no se vuelve a ofrecer (lo mismo que hace volver-a-version-anterior.ps1). */
export function localSkipVersion(version: string): void {
  if (version === '') return
  const dir = join(home(), 'storages')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'local-saltar-version.txt'), version)
  } catch (error) {
    console.error(error)
  }
}

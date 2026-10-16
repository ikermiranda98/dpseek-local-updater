/**
 * Deshacer los cambios de un turno en un fichero (añadido por dpseek-local-updater).
 *
 * La revisión de cambios del turno (workspace-changes) guarda la comparación del
 * fichero al empezar y al terminar el turno. Si el fichero sigue como lo dejó el
 * turno, se reconstruye cómo estaba al empezar y se escribe; si alguien lo ha
 * tocado después, no se toca y se avisa.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** Lo que hace falta de la comparación de workspace-changes. */
export interface LocalTurnDiff {
  readonly kind: string
  readonly before?: boolean
  readonly after?: boolean
  readonly hunks?: readonly {
    readonly newStart: number
    readonly newLines: number
    readonly lines: readonly string[]
  }[]
}

/** Lo que hace falta del servicio workspace-changes. */
export interface LocalWorkspaceChanges {
  summary(sessionId: string, seq: number): { cwd: string; files: { path: string; display: string }[] } | undefined
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<LocalTurnDiff | undefined>
}

/** Qué se ha hecho con el fichero. */
export type LocalUndoOutcome = 'restored' | 'deleted' | 'recreated'

/** Líneas como las cuenta la comparación: separadas por \n, sin la línea vacía final. */
function lines(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

class Changed extends Error {}

/**
 * Reconstruye el texto de antes del turno a partir del actual y las diferencias.
 * @param current - texto actual del fichero.
 * @param hunks - diferencias del turno (inicio → final).
 * @returns el texto de antes del turno.
 * @throws Changed si el fichero ya no coincide con como lo dejó el turno.
 */
function revert(current: string, hunks: NonNullable<LocalTurnDiff['hunks']>): string {
  const now = lines(current)
  const out: string[] = []
  let at = 0
  for (const hunk of hunks) {
    // Con 3 líneas de contexto, un lado sin líneas solo puede ser un fichero vacío.
    const start = hunk.newLines === 0 ? 0 : hunk.newStart - 1
    if (start < at || start > now.length) throw new Changed()
    out.push(...now.slice(at, start))
    at = start
    for (const line of hunk.lines) {
      const sign = line[0]
      if (sign === '\\') continue
      const text = line.slice(1)
      if (sign === '+' || sign === ' ') {
        if (now[at] !== text) throw new Changed()
        at++
      }
      if (sign === '-' || sign === ' ') out.push(text)
    }
  }
  out.push(...now.slice(at))
  if (out.length === 0) return ''
  // El final de línea del fichero se respeta: con salto final si lo tenía.
  return out.join('\n') + (current === '' || current.endsWith('\n') ? '\n' : '')
}

/**
 * Deja un fichero del resumen de un turno como estaba al empezarlo.
 * @param changes - servicio workspace-changes del Host.
 * @param sessionId - chat.
 * @param seq - evento `workspace/changes` del turno.
 * @param index - fichero dentro del resumen.
 * @param signal - cancelación.
 * @returns qué se ha hecho.
 */
export async function localUndoTurnFile(changes: LocalWorkspaceChanges, sessionId: string, seq: number, index: number,
  signal: AbortSignal): Promise<LocalUndoOutcome> {
  const summary = changes.summary(sessionId, seq)
  const file = summary?.files[index]
  if (summary === undefined || file === undefined) {
    throw new Error('The changes of that turn are no longer available (the app was restarted since).')
  }
  const diff = await changes.diff(sessionId, seq, index, signal)
  if (diff === undefined) throw new Error('The changes of that turn are no longer available.')
  if (diff.kind !== 'text' || diff.hunks === undefined) throw new Error('Binary or very large files cannot be undone here.')
  const absolute = isAbsolute(file.path) ? file.path : join(summary.cwd, file.path)
  let current: string | null
  try {
    current = await readFile(absolute, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    current = null
  }
  const changedSince = new Error(`${file.display} has changed since that turn; it was left as it is.`)
  try {
    if (diff.after === false) {
      // El turno lo borró: se vuelve a crear, si nadie lo ha creado de nuevo.
      if (current !== null) throw new Changed()
      await writeFile(absolute, revert('', diff.hunks), 'utf8')
      return 'recreated'
    }
    if (current === null) throw new Changed()
    const before = revert(current, diff.hunks)
    if (diff.before === false) {
      // El turno lo creó: deshacer es quitarlo.
      await rm(absolute)
      return 'deleted'
    }
    await writeFile(absolute, before, 'utf8')
    return 'restored'
  } catch (error) {
    if (error instanceof Changed) throw changedSince
    throw error
  }
}

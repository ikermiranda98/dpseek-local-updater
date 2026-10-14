/**
 * Borrado definitivo de chats (añadido por dpseek-local-updater).
 *
 * La versión oficial solo archiva. Aquí se borra la carpeta del chat en
 * `<DSH_HOME>/sessions/<proyecto>/<id>/`, la de sus subagentes y su caché de
 * proyecciones. Antes se archiva con «detener actividad»: así el chat deja de
 * trabajar y desaparece de la lista aunque el borrado tenga que esperar.
 *
 * Un chat que sigue cargado en memoria (abierto en esta ejecución) podría volver
 * a escribir en su carpeta, así que no se toca: queda en una lista de pendientes
 * (`storages/local-borrados-pendientes.json`), se oculta de la lista y se borra
 * en el siguiente arranque de la app.
 */

import { readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Solo se aceptan ids que ya son un nombre de carpeta válido (session-<uuid>). */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export interface LocalDeleteResult {
  /** Chats borrados ya del disco. */
  readonly deletedSessionIds: readonly SessionId[]
  /** Chats cargados en memoria: ocultos y archivados, se borran al reiniciar. */
  readonly pendingSessionIds: readonly SessionId[]
}

export class LocalSessionDeleter {
  private pending: Set<SessionId> | undefined
  private purged = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly ctx: Context) {}

  /** Ids ocultos hasta el próximo arranque (para filtrar la lista). */
  async hidden(): Promise<ReadonlySet<SessionId>> {
    // La lista de chats nunca debe fallar por esto: ante cualquier error se
    // muestra todo y queda un aviso en el registro.
    try {
      await this.serial(() => this.purgeOnce())
    } catch (error) {
      this.ctx.logger.warn(`local-delete: ${String(error)}`)
    }
    return this.pending ?? new Set()
  }

  /** Borra un chat y sus subagentes. */
  delete(sessionId: SessionId): Promise<LocalDeleteResult> {
    return this.serial(async () => {
      await this.purgeOnce()
      const root = this.root()
      if (!SAFE_ID.test(sessionId)) {
        throw new RemoteError('session/not-found', `invalid session id: ${sessionId}`, { sessionId })
      }
      const records = await this.ctx.sessionQuery.listSessions()
      const known = records.some(record => record.header.id === sessionId) || this.ctx.sessions.get(sessionId) !== undefined
      if (!known) throw new RemoteError('session/not-found', `session ${sessionId} does not exist`, { sessionId })

      // Archivar detiene el trabajo en curso (turnos, subagentes, tareas) y
      // bloquea nuevos pasos del modelo; si ya estaba archivada no hace nada.
      await this.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })

      const family = [sessionId, ...descendants(records, sessionId)]
      const deleted: SessionId[] = []
      const pendingIds: SessionId[] = []
      for (const id of family) {
        if (this.ctx.sessions.get(id) !== undefined) {
          pendingIds.push(id)
          continue
        }
        await removeSessionFiles(root, id)
        deleted.push(id)
      }
      if (pendingIds.length > 0) {
        const pending = await this.loadPending()
        for (const id of pendingIds) pending.add(id)
        await this.savePending()
      }
      // Ya no existe: sale del conjunto de archivadas (las pendientes siguen
      // archivadas, y ocultas, hasta que se borren al arrancar).
      for (const id of deleted) await this.ctx.workspaceRegistry.unarchiveSession(id)
      this.ctx.logger.info(`local-delete: borradas ${deleted.length}, pendientes de reinicio ${pendingIds.length} (${sessionId})`)
      return { deletedSessionIds: deleted, pendingSessionIds: pendingIds }
    })
  }

  /** Borra, una vez por ejecución, lo que quedó pendiente del arranque anterior. */
  private async purgeOnce(): Promise<void> {
    if (this.purged) return
    this.purged = true
    const pending = await this.loadPending()
    if (pending.size === 0) return
    const root = this.root()
    for (const id of [...pending]) {
      if (this.ctx.sessions.get(id) !== undefined) continue
      try {
        await removeSessionFiles(root, id)
        await this.ctx.workspaceRegistry.unarchiveSession(id)
        pending.delete(id)
      } catch (error) {
        this.ctx.logger.warn(`local-delete: no se pudo borrar ${id}: ${String(error)}`)
      }
    }
    await this.savePending()
  }

  private root(): string {
    const persistence = this.ctx.get('sessionPersistence') as { config?: { root?: unknown } } | undefined
    const root = persistence?.config?.root
    if (typeof root !== 'string' || root.length === 0) {
      throw new RemoteError('gateway/internal', 'deleting sessions requires the JSONL storage', {})
    }
    return root
  }

  private pendingFile(): string {
    return join(dirname(this.root()), 'storages', 'local-borrados-pendientes.json')
  }

  private async loadPending(): Promise<Set<SessionId>> {
    if (this.pending !== undefined) return this.pending
    let ids: SessionId[] = []
    try {
      const parsed: unknown = JSON.parse(await readFile(this.pendingFile(), 'utf8'))
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is SessionId => typeof id === 'string' && SAFE_ID.test(id))
    } catch {
      // Sin fichero (lo normal) o ilegible: no hay pendientes.
    }
    this.pending = new Set(ids)
    return this.pending
  }

  private async savePending(): Promise<void> {
    const file = this.pendingFile()
    const ids = [...(this.pending ?? [])]
    if (ids.length === 0) {
      await rm(file, { force: true })
      return
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(ids), 'utf8')
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.catch(() => undefined)
    return run
  }
}

/** Subagentes (y los suyos) creados desde un chat. */
function descendants(
  records: readonly { readonly header: { readonly id: SessionId; readonly parentSession?: SessionId } }[],
  sessionId: SessionId,
): SessionId[] {
  const found: SessionId[] = []
  const queue = [sessionId]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const record of records) {
      const id = record.header.id
      if (record.header.parentSession === parent && id !== sessionId && !found.includes(id)) {
        found.push(id)
        queue.push(id)
      }
    }
  }
  return found
}

/**
 * Borra `<root>/<proyecto>/<id>` en cualquier proyecto y la caché de
 * proyecciones `<home>/storages/session_projcache/sessions/<id>.json`.
 */
async function removeSessionFiles(root: string, id: SessionId): Promise<void> {
  if (!SAFE_ID.test(id)) return
  let projects: string[] = []
  try {
    projects = await readdir(root)
  } catch {
    return
  }
  for (const project of projects) {
    const dir = join(root, project, id)
    const info = await stat(dir).catch(() => undefined)
    if (info?.isDirectory() === true) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  await rm(join(dirname(root), 'storages', 'session_projcache', 'sessions', `${id}.json`), { force: true })
}

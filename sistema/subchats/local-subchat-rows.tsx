/**
 * Subchats, lado de la barra lateral (añadido por dpseek-local-updater).
 *
 * Debajo de cada chat, sus subchats (local-subchat-store.ts) con un punto de
 * estado: azul latiendo mientras trabaja, verde cuando ha terminado. Un clic
 * abre el subchat en el centro, como el catálogo oficial de subagentes.
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ISessions, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconTreeCornerRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { subchatsSnapshot, subscribeSubchats } from './local-subchat-store.ts'
import css from './local-subchat-rows.module.css'

let sessions: ISessions | undefined
let openSession: ((target: SessionTarget) => void) | undefined

/**
 * @param list - sesiones de la app (incluye las de los subagentes).
 * @param open - abrir una sesión en el centro.
 */
export function setLocalSubchats(list: ISessions, open: (target: SessionTarget) => void): void {
  sessions = list
  openSession = open
}

const noSessions = (): (() => void) => () => {}

/**
 * Subchats de un chat, anidados bajo su fila.
 * @param props - chat principal y chat abierto ahora.
 * @returns las filas, o nada si no tiene.
 */
export function LocalSubchatRows({ parentId, currentId }: { parentId: string; currentId: string | undefined }): ReactNode {
  const all = useSyncExternalStore(subscribeSubchats, subchatsSnapshot)
  const list = useSyncExternalStore(sessions?.list.subscribe ?? noSessions, () => sessions?.list.getSnapshot())
  const mine = all.filter((entry) => entry.parentId === parentId)
  if (mine.length === 0 || list === undefined) return null
  // Con la lista ya cargada, un subchat que no aparece se ha borrado con su chat.
  const visible = list.phase === 'ready' ? mine.filter((entry) => list.byId[entry.childId as SessionId] !== undefined) : mine
  if (visible.length === 0) return null
  return (
    <div className={css.group} role="group">
      {visible.map((entry) => {
        const running = list.byId[entry.childId as SessionId]?.running === true
        return (
          <div key={entry.childId} className={css.row} role="treeitem" data-row-key={`subchat:${entry.childId}`}
            aria-selected={entry.childId === currentId} title={entry.label}
            onClick={() => {
              openSession?.({ parentSessionId: parentId as SessionId, childSessionId: entry.childId as SessionId, mode: 'continuable' })
            }}>
            <IconTreeCornerRegular className={css.corner} />
            <span className={css.dot} data-running={running || undefined} aria-label={running ? 'Working' : 'Done'} />
            <span className={css.label}>{entry.label}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Subchats, lado de la barra lateral (añadido por dpseek-local-updater).
 *
 * - Debajo de cada chat, sus subchats (local-subchat-store.ts), en un grupo que se
 *   pliega y despliega («▾ 3 subchats»).
 * - Un punto por subchat: azul latiendo mientras trabaja, ámbar si espera una
 *   respuesta o un permiso tuyo, rojo si se paró o falló, violeta si tiene un
 *   resultado esperando tu revisión, verde si ha terminado. Al pasar el ratón: el
 *   estado, el tiempo y los tokens, y si comparte el modelo con otro chat en marcha.
 * - Clic: lo abre en el centro. Clic derecho: Open, Open beside, Stop, Send result to
 *   main chat, Rename, Remove from sidebar y Delete.
 * - Aviso de Windows cuando un subchat termina y no lo estás viendo.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, IconChevronDownOutlineRegular, IconTreeCornerRegular, Menu, Modal, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { deliverLocalSubchat, openSubchatAside } from './local-subchat-start.ts'
import {
  collapsedSnapshot, forgetSubchat, setSubchatsCollapsed, subchatsSnapshot, subscribeSubchats, updateSubchat,
  type LocalSubchat,
} from './local-subchat-store.ts'
import css from './local-subchat-rows.module.css'

interface StatusLike { readonly running?: boolean; readonly pendingInteraction?: { readonly kind?: string } }
interface StatusSource { getSnapshot(): ReadonlyMap<string, StatusLike>; subscribe(listener: () => void): () => void }
interface SummaryLike {
  readonly running?: boolean
  readonly retainedBy?: { readonly mainView?: number }
  readonly projectionValues?: {
    readonly subagentTiming?: { readonly settledMs: number; readonly active?: { readonly since: number }; readonly lastTurnCompleted?: boolean }
    readonly tokenUsage?: { readonly uncachedInputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number }
  }
}

let localCtx: Context | undefined
let sessions: ISessions | undefined
let openSession: ((target: SessionTarget) => void) | undefined

const noStatuses: StatusSource = { getSnapshot: () => new Map(), subscribe: () => () => {} }
const statusSource = (): StatusSource =>
  (localCtx?.get('uiSession') as { sessionStatus?: StatusSource } | undefined)?.sessionStatus ?? noStatuses
const byIdOf = (): Record<string, SummaryLike | undefined> =>
  (sessions?.list.getSnapshot().byId ?? {}) as unknown as Record<string, SummaryLike | undefined>

type Kind = 'running' | 'waiting' | 'failed' | 'review' | 'done'

function kindOf(entry: LocalSubchat, summary: SummaryLike | undefined, status: StatusLike | undefined): Kind {
  if (status?.pendingInteraction?.kind !== undefined) return 'waiting'
  if ((status?.running ?? summary?.running) === true) return 'running'
  if (summary?.projectionValues?.subagentTiming?.lastTurnCompleted === false) return 'failed'
  if (entry.review === true && entry.delivered !== true) return 'review'
  return 'done'
}

const KIND_TEXT: Record<Kind, string> = {
  running: 'Working',
  waiting: 'Waiting for your answer or approval',
  failed: 'Stopped or failed',
  review: 'Result ready to review: send it from the subchat',
  done: 'Finished',
}

function minutes(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${String(seconds)} s` : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`
}

function tooltip(entry: LocalSubchat, kind: Kind, summary: SummaryLike | undefined, sharing: boolean): string {
  const timing = summary?.projectionValues?.subagentTiming
  const usage = summary?.projectionValues?.tokenUsage
  const ms = timing === undefined ? undefined : timing.settledMs + (timing.active === undefined ? 0 : Date.now() - timing.active.since)
  const tokens = usage === undefined ? undefined : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return [
    entry.label,
    KIND_TEXT[kind],
    [ms === undefined ? '' : minutes(ms), tokens === undefined ? '' : `${String(Math.round(tokens / 1000))}K tokens`].filter(Boolean).join(' · '),
    kind === 'running' && sharing ? 'Another chat is also running: they share the model, so this one may wait its turn.' : '',
  ].filter(Boolean).join('\n')
}

/** El chat que se ve en el centro. */
function mainViewId(): string | undefined {
  return Object.entries(byIdOf()).find(([, summary]) => (summary?.retainedBy?.mainView ?? 0) > 0)?.[0]
}

/** Aviso de Windows cuando un subchat termina y no lo estás viendo. */
function installNotifications(list: ISessions, open: (target: SessionTarget) => void): () => void {
  if (typeof Notification === 'undefined') return () => undefined
  let running = new Set<string>()
  const check = (): void => {
    const byId = byIdOf()
    // Los subagentes se marcan «en marcha» en el estado de sesión, no siempre en la lista.
    const statuses = statusSource().getSnapshot()
    const isRunning = (id: string): boolean => (statuses.get(id)?.running ?? byId[id]?.running) === true
    const now = new Set(subchatsSnapshot().filter((entry) => isRunning(entry.childId)).map((entry) => entry.childId))
    const away = document.visibilityState !== 'visible' || !document.hasFocus()
    for (const childId of running) {
      const entry = subchatsSnapshot().find((candidate) => candidate.childId === childId)
      if (now.has(childId) || entry === undefined || Notification.permission === 'denied') continue
      const viewing = mainViewId()
      if (!away && (viewing === entry.parentId || viewing === childId)) continue
      const review = entry.review === true && entry.delivered !== true
      const notification = new Notification(entry.label, { body: review ? 'Subchat finished: ready to review' : 'Subchat finished' })
      notification.onclick = () => {
        window.focus()
        open(review
          ? { parentSessionId: entry.parentId as SessionId, childSessionId: childId as SessionId, mode: 'continuable' }
          : entry.parentId as SessionId)
        notification.close()
      }
    }
    running = now
  }
  check()
  const stopList = list.list.subscribe(check)
  const stopStatus = statusSource().subscribe(check)
  // Por si el estado de sesión aún no estaba cuando se instaló el vigilante.
  const timer = setInterval(check, 2000)
  return () => { stopList(); stopStatus(); clearInterval(timer) }
}

/**
 * @param ctx - contexto de ui-workspace (llamadas al Host y paneles).
 * @param list - sesiones de la app (incluye las de los subagentes).
 * @param open - abrir una sesión en el centro.
 * @returns cómo dejar de avisar.
 */
export function setLocalSubchats(ctx: Context, list: ISessions, open: (target: SessionTarget) => void): () => void {
  localCtx = ctx
  sessions = list
  openSession = open
  // Subchats borrados desde la selección (Supr / «Delete N»): fuera de la barra lateral.
  const onDeleted = (event: Event): void => {
    const ids = (event as CustomEvent<readonly string[]>).detail
    if (Array.isArray(ids)) for (const id of ids) forgetSubchat(id)
  }
  window.addEventListener('dpseek-local-deleted', onDeleted)
  const stop = installNotifications(list, open)
  return () => {
    window.removeEventListener('dpseek-local-deleted', onDeleted)
    stop()
  }
}

// Funciones estables para useSyncExternalStore (los servicios pueden llegar después).
const subscribeList = (listener: () => void): (() => void) => sessions?.list.subscribe(listener) ?? (() => {})
const listSnapshot = (): ReturnType<ISessions['list']['getSnapshot']> | undefined => sessions?.list.getSnapshot()
const subscribeStatus = (listener: () => void): (() => void) => statusSource().subscribe(listener)
const statusSnapshot = (): ReadonlyMap<string, StatusLike> => statusSource().getSnapshot()

/**
 * Subchats de un chat, anidados bajo su fila.
 * @param props - chat principal y chat abierto ahora.
 * @returns el grupo, o nada si no tiene.
 */
export function LocalSubchatRows({ parentId, currentId }: { parentId: string; currentId: string | undefined }): ReactNode {
  const all = useSyncExternalStore(subscribeSubchats, subchatsSnapshot)
  const collapsed = useSyncExternalStore(subscribeSubchats, collapsedSnapshot).has(parentId)
  const list = useSyncExternalStore(subscribeList, listSnapshot)
  const statuses = useSyncExternalStore(subscribeStatus, statusSnapshot)
  const [menu, setMenu] = useState<{ entry: LocalSubchat; rect: DOMRect } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<LocalSubchat | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (list === undefined) return null
  const byId = list.byId as unknown as Record<string, SummaryLike | undefined>
  // Con la lista ya cargada, un subchat que no aparece se ha borrado con su chat.
  const mine = all.filter((entry) => entry.parentId === parentId && (list.phase !== 'ready' || byId[entry.childId] !== undefined))
  if (mine.length === 0) return null
  const anyOtherRunning = (childId: string): boolean => Object.entries(byId).some(([id, summary]) => id !== childId && summary?.running === true)
  const kinds = mine.map((entry) => kindOf(entry, byId[entry.childId], statuses.get(entry.childId)))
  const working = kinds.filter((kind) => kind === 'running').length
  const attention = kinds.some((kind) => kind === 'waiting' || kind === 'review')
  const target = (entry: LocalSubchat): SessionTarget =>
    ({ parentSessionId: parentId as SessionId, childSessionId: entry.childId as SessionId, mode: 'continuable' })
  const run = (action: Promise<unknown>): void => { action.catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }
  const menuItems = (entry: LocalSubchat, kind: Kind): MenuEntry[] => [
    { id: 'open', label: 'Open' },
    { id: 'aside', label: 'Open beside' },
    ...kind === 'running' || kind === 'waiting' ? [{ id: 'stop', label: 'Stop' }] : [],
    ...kind === 'running' ? [] : [{ id: 'send', label: entry.delivered === true || entry.review !== true ? 'Send result to main chat again' : 'Send result to main chat' }],
    { type: 'separator' as const, id: 'separator' },
    { id: 'rename', label: 'Rename' },
    { id: 'forget', label: 'Remove from sidebar' },
    { id: 'delete', label: 'Delete', danger: true },
  ]
  const choose = (entry: LocalSubchat, id: string): void => {
    setMenu(null)
    const ctx = localCtx
    if (ctx === undefined) return
    switch (id) {
      case 'open': openSession?.(target(entry)); break
      case 'aside': openSubchatAside(ctx, parentId, entry.childId); break
      case 'stop':
        run(ctx.remote.session.localSubchatStop({ sessionId: parentId as SessionId, childSessionId: entry.childId as SessionId })
          .then((result) => { if (!result.ok) throw new Error(result.error.message) }))
        break
      case 'send': run(deliverLocalSubchat(ctx, entry.childId)); break
      case 'rename': setRenaming(entry.childId); break
      case 'forget': forgetSubchat(entry.childId); break
      case 'delete': setDeleting(entry); break
      default: break
    }
  }
  return (
    <div className={css.group} role="group" data-local-subchats={parentId}>
      <button type="button" className={css.toggle} aria-expanded={!collapsed}
        onClick={() => { setSubchatsCollapsed(parentId, !collapsed) }}>
        <IconChevronDownOutlineRegular size={11} className={collapsed ? css.closed : undefined} />
        <span>{mine.length} {mine.length === 1 ? 'subchat' : 'subchats'}</span>
        {collapsed && working > 0 && <span className={css.dot} data-kind="running" />}
        {collapsed && attention && <span className={css.dot} data-kind="waiting" />}
      </button>
      {!collapsed && mine.map((entry, index) => {
        const kind = kinds[index] ?? 'done'
        const summary = byId[entry.childId]
        return (
          <Tooltip key={entry.childId} label={() => tooltip(entry, kind, summary, anyOtherRunning(entry.childId))} side="right" delayMs={600} maxWidth={320}>
          <div className={css.row} role="treeitem" data-row-key={`subchat:${entry.childId}`}
            aria-selected={entry.childId === currentId}
            onClick={() => { if (renaming !== entry.childId) openSession?.(target(entry)) }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenu({ entry, rect: new DOMRect(event.clientX, event.clientY, 0, 0) })
            }}>
            <IconTreeCornerRegular className={css.corner} />
            <span className={css.dot} data-kind={kind} aria-label={KIND_TEXT[kind]} />
            {renaming === entry.childId
              ? <RenameBox label={entry.label} onDone={(label) => {
                setRenaming(null)
                if (label !== undefined && label.trim() !== '') updateSubchat(entry.childId, { label: label.trim() })
              }} />
              : <span className={css.label}>{entry.label}</span>}
          </div>
          </Tooltip>
        )
      })}
      {menu !== null && (
        <Menu open portal dense autoFocus anchor={<span className={css.menuAnchor} />} listClassName={css.menuList}
          getAnchorRect={() => menu.rect}
          items={menuItems(menu.entry, kindOf(menu.entry, byId[menu.entry.childId], statuses.get(menu.entry.childId)))}
          onSelect={(id) => { choose(menu.entry, String(id)) }}
          onClose={() => { setMenu(null) }} />
      )}
      {deleting !== null && (
        <Modal open onClose={() => { setDeleting(null) }} closeLabel="Close" title="Delete subchat"
          description={`"${deleting.label}" and its conversation are deleted from disk. This cannot be undone; what it already sent to the main chat stays there.`}
          footer={(
            <>
              <Button variant="outline" onClick={() => { setDeleting(null) }}>Cancel</Button>
              <Button variant="outline" className={css.danger} onClick={() => {
                const ctx = localCtx
                const entry = deleting
                setDeleting(null)
                if (ctx === undefined) return
                run(ctx.remote.session.deletePermanently({ sessionId: entry.childId as SessionId }).then((result) => {
                  if (!result.ok) throw new Error(result.error.message)
                  forgetSubchat(entry.childId)
                }))
              }}>Delete</Button>
            </>
          )} />
      )}
      {error !== null && <div className={css.error} role="alert" onClick={() => { setError(null) }}>{error}</div>}
    </div>
  )
}

/** Cambiar el nombre en la propia fila: Enter guarda, Esc cancela. */
function RenameBox({ label, onDone }: { label: string; onDone: (label?: string) => void }) {
  const [value, setValue] = useState(label)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  return (
    <input ref={input} className={css.rename} value={value} aria-label="Subchat name"
      onClick={(event) => { event.stopPropagation() }}
      onChange={(event) => { setValue(event.target.value) }}
      onBlur={() => { onDone(value) }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') onDone(value)
        if (event.key === 'Escape') onDone(undefined)
      }} />
  )
}

/**
 * Chats de la barra lateral que se seleccionan y se manejan como archivos en el
 * Explorador de Windows (añadido por dpseek-local-updater).
 *
 *   - Clic abre el chat; Ctrl+clic añade o quita; Mayús+clic selecciona un rango
 *     (Ctrl+Mayús lo añade). Pulsar en un hueco de la barra y arrastrar dibuja un
 *     recuadro que selecciona los chats que toca. Un clic en un hueco o Esc limpia.
 *   - Los seleccionados se rellenan con el azul del tema, sin bordes.
 *   - Botón derecho sobre un chat: si no estaba seleccionado, pasa a ser la
 *     selección; el menú (el de la app, en el puntero) actúa sobre todos: Open,
 *     Rename, Pin/Unpin, Archive, Move to project ▸ (chats de «Ungrouped», a un
 *     proyecto de su misma carpeta o a uno nuevo para ella) y Delete (Supr).
 *   - Los de «Ungrouped» también se arrastran sobre un proyecto compatible.
 *
 * Es un componente de la capa superior (shell.overlay) que escucha los eventos de
 * la barra lateral y marca las filas (`data-row-key="session:<id>"`) con un
 * atributo; no cambia el código de las filas oficiales.
 */
import { useEffect, useRef, useState } from 'react'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  Button, IconArchiveOutlineRegular, IconBranchOutlineRegular, IconCopyOutlineRegular, IconEditOutlineRegular, IconPinOutlineRegular, IconRightUpOutlineRegular,
  IconTrashOutlineRegular, IconWorkspaceTreeOutlineRegular, Menu, Modal, type MenuEntry, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import browserCss from '../rows/WorkspaceBrowser.module.css'
import css from './LocalSelection.module.css'

/** Proyecto al que se pueden mover unos chats. */
export interface LocalMoveTarget {
  readonly workspaceId: string
  readonly title: string
}

/** Adónde se pueden mover unos chats: proyectos compatibles o uno nuevo para su carpeta. */
export interface LocalMoveOptions {
  readonly targets: readonly LocalMoveTarget[]
  /** Carpeta común de los chats, para crear un proyecto nuevo (si no hay uno ya). */
  readonly newFolder?: string
}

/** Lo que recibe el componente de index.ts. */
export interface LocalSelectionInjected {
  hooks: { selection: HostObservable<readonly SessionId[]> }
  setSelection: (ids: readonly SessionId[]) => void
  /** Si un chat se puede seleccionar (visible, no subagente, no en blanco). */
  isSelectable: (id: SessionId) => boolean
  titlesOf: (ids: readonly SessionId[]) => string[]
  openSession: (id: SessionId) => void
  /** El cuadro oficial de renombrar. */
  renameSession: (id: SessionId) => void
  /** La bifurcación oficial (Branch) del chat. */
  forkSession: (id: SessionId) => void
  /** Copia el ID del chat, como la fila oficial. */
  copySessionId: (id: SessionId) => void
  /** El archivado oficial de un chat (pregunta si está trabajando y ofrece deshacer). */
  archiveOne: (id: SessionId) => void
  isPinned: (id: SessionId) => boolean
  /** Fija o suelta los chats; devuelve los títulos que fallaron. */
  pinMany: (ids: readonly SessionId[], pinned: boolean) => Promise<string[]>
  /** Archiva los chats (no los que están trabajando); devuelve los títulos que fallaron. */
  archiveMany: (ids: readonly SessionId[]) => Promise<string[]>
  /** Borra los chats y avisa del avance; devuelve los títulos que fallaron. */
  deleteMany: (ids: readonly SessionId[], progress: (done: number) => void) => Promise<string[]>
  /** Opciones para mover estos chats, o null si alguno no es de «Ungrouped». */
  moveOptions: (ids: readonly SessionId[]) => LocalMoveOptions | null
  /** Mueve los chats a un proyecto (o a uno nuevo para su carpeta); devuelve los que fallaron. */
  moveMany: (ids: readonly SessionId[], target: { workspaceId: string } | { newFolder: string }) => Promise<string[]>
}

type Props = PropsRuntime<'shell.overlay'> & PropsLocale<'workspace'>
  & Omit<LocalSelectionInjected, 'hooks'> & PropsHooks<LocalSelectionInjected['hooks']>

// Los subchats anidados (sección 20) se seleccionan y borran igual que los chats.
const SESSION = '[data-row-key^="session:"], [data-row-key^="subchat:"]'
const WORKSPACE = '[data-row-key^="workspace:"]'
const SELECTED_ATTR = 'data-local-selected'
const DROP_ATTR = 'data-local-drop'
// Como el Explorador: relleno con el azul de acento del tema (claro u oscuro), sin bordes.
const STYLE = `
[data-row-key][${SELECTED_ATTR}] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent) !important;
}
[data-row-key][${SELECTED_ATTR}]:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 25%, transparent) !important;
}
[data-row-key][${DROP_ATTR}] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 25%, transparent) !important;
}
[data-row-key^="session:"], [data-row-key^="session:"] *, [data-row-key^="workspace:"], [data-row-key^="workspace:"] * { cursor: default !important; }
body[data-local-marquee], body[data-local-marquee] * { user-select: none !important; cursor: default !important; }
`

const idOf = (row: Element): SessionId => row.getAttribute('data-row-key')!.replace(/^(session|subchat):/, '') as SessionId

/** Si la sesión es un subchat que se ve en la barra lateral (fila «subchat:»). */
const isSubchat = (id: string): boolean => document.querySelector(`[data-row-key="subchat:${CSS.escape(id)}"]`) !== null

/**
 * Columna de la barra lateral (donde empieza el recuadro): el contenedor más alto
 * de la lista de chats que sigue teniendo el ancho de la barra; por encima ya
 * entraría el chat.
 */
function sidebarArea(): HTMLElement | null {
  const tree = document.querySelector<HTMLElement>('[role="tree"]')
  if (tree === null) return null
  const width = tree.getBoundingClientRect().width
  let area: HTMLElement = tree
  for (let el = tree.parentElement; el !== null && el !== document.body; el = el.parentElement) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0) continue
    if (rect.width > width + 48) break
    area = el
  }
  return area
}

function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SESSION)].filter(row => row.getClientRects().length > 0)
}

const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [role="treeitem"], [role="menuitem"], [role="menu"], [contenteditable="true"], [data-row-key]'

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return el !== null && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

/**
 * Selección de chats, recuadro, menú contextual y arrastre a proyectos.
 * @param props - selección compartida y acciones inyectadas.
 * @returns el menú contextual, el recuadro y la confirmación de borrado.
 */
export function LocalSelection({
  useSelection, setSelection, isSelectable, titlesOf, openSession, renameSession, forkSession, copySessionId,
  archiveOne, isPinned, pinMany, archiveMany, deleteMany, moveOptions, moveMany, t,
}: Props) {
  const selection = useSelection(state => state)
  // Un subchat no es un chat de la lista oficial, pero se selecciona (para borrarlo) igual.
  const canSelect = (id: SessionId): boolean => isSelectable(id) || isSubchat(id)
  const live = useRef({ selection, setSelection, isSelectable: canSelect, moveOptions, moveMany, renameSession })
  live.current = { selection, setSelection, isSelectable: canSelect, moveOptions, moveMany, renameSession }
  const anchor = useRef<SessionId | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [menu, setMenu] = useState<{ rect: DOMRect; ids: readonly SessionId[] } | null>(null)
  const [confirming, setConfirming] = useState<readonly SessionId[] | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Marca las filas seleccionadas, también las que la lista vuelve a crear.
  useEffect(() => {
    const ids = new Set(selection)
    const paint = () => {
      for (const row of document.querySelectorAll(SESSION)) {
        if (ids.has(idOf(row))) row.setAttribute(SELECTED_ATTR, '')
        else row.removeAttribute(SELECTED_ATTR)
      }
    }
    paint()
    if (ids.size === 0) return
    const observer = new MutationObserver(paint)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [selection])

  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = STYLE
    document.head.append(style)
    return () => {
      style.remove()
      for (const row of document.querySelectorAll(`[${SELECTED_ATTR}], [${DROP_ATTR}]`)) {
        row.removeAttribute(SELECTED_ATTR)
        row.removeAttribute(DROP_ATTR)
      }
    }
  }, [])

  // Clic, Ctrl+clic y Mayús+clic sobre un chat.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const { selection: current, setSelection: set, isSelectable: selectable } = live.current
      const row = (event.target as Element | null)?.closest(SESSION)
      if (row === null || row === undefined) return
      // «⋯» de la fila: el mismo menú que el botón derecho, bajo los puntos.
      const trigger = (event.target as Element).closest('button')
      const strip = trigger?.closest('[class*="_rowActions"]')
      if (trigger !== null && trigger !== undefined && strip !== null && strip !== undefined && strip.querySelector('button') === trigger) {
        const id = idOf(row)
        if (!selectable(id)) return
        event.preventDefault()
        event.stopPropagation()
        const ids = current.includes(id) ? current : [id]
        if (!current.includes(id)) set([id])
        anchor.current = id
        setMenu({ rect: trigger.getBoundingClientRect(), ids })
        return
      }
      if ((event.target as Element).closest('button, a, input, [role="menuitem"]') !== null) return
      const id = idOf(row)
      const toggle = event.ctrlKey || event.metaKey
      if (!toggle && !event.shiftKey) {
        // Clic normal: abre el chat (lo hace la fila) y la selección queda en él.
        anchor.current = id
        if (current.length > 0) set([])
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (!selectable(id)) return
      if (event.shiftKey && anchor.current !== null) {
        const order = visibleRows().map(idOf)
        const from = order.indexOf(anchor.current)
        const to = order.indexOf(id)
        if (from !== -1 && to !== -1) {
          const range = order.slice(Math.min(from, to), Math.max(from, to) + 1).filter(selectable)
          set(toggle ? [...new Set([...current, ...range])] : range)
          return
        }
      }
      anchor.current = id
      set(current.includes(id) ? current.filter(other => other !== id) : [...current, id])
    }
    document.addEventListener('click', onClick, true)
    return () => { document.removeEventListener('click', onClick, true) }
  }, [])

  // Botón derecho sobre un chat: el menú de la selección (o de ese chat solo).
  useEffect(() => {
    const onContext = (event: MouseEvent) => {
      const row = (event.target as Element | null)?.closest(SESSION)
      if (row === null || row === undefined) return
      const id = idOf(row)
      const { selection: current, setSelection: set, isSelectable: selectable } = live.current
      if (!selectable(id)) return
      // Un subchat solo tiene su propio menú (Stop, Send result, Rename…); con varios seleccionados, el de la selección.
      if (isSubchat(id) && !(current.includes(id) && current.length > 1)) return
      event.preventDefault()
      event.stopPropagation()
      const ids = current.includes(id) ? current : [id]
      if (!current.includes(id)) set([id])
      anchor.current = id
      setMenu({ rect: new DOMRect(event.clientX, event.clientY, 0, 0), ids })
    }
    document.addEventListener('contextmenu', onContext, true)
    return () => { document.removeEventListener('contextmenu', onContext, true) }
  }, [])

  // Recuadro: pulsar en un hueco de la barra lateral y arrastrar.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const area = sidebarArea()
      const target = event.target as HTMLElement | null
      if (area === null || target === null || !area.contains(target) || target.closest(INTERACTIVE) !== null) return
      const startX = event.clientX
      const startY = event.clientY
      const base = event.ctrlKey || event.metaKey ? live.current.selection : []
      let started = false
      const onMove = (move: PointerEvent) => {
        const x = Math.min(startX, move.clientX)
        const y = Math.min(startY, move.clientY)
        const w = Math.abs(move.clientX - startX)
        const h = Math.abs(move.clientY - startY)
        if (!started && w < 4 && h < 4) return
        if (!started) {
          started = true
          document.body.setAttribute('data-local-marquee', '')
        }
        setBox({ x, y, w, h })
        const hit = visibleRows().filter((row) => {
          const r = row.getBoundingClientRect()
          return r.right >= x && r.left <= x + w && r.bottom >= y && r.top <= y + h
        }).map(idOf).filter(live.current.isSelectable)
        live.current.setSelection([...new Set([...base, ...hit])])
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.removeAttribute('data-local-marquee')
        setBox(null)
        // Un clic sin arrastrar en un hueco limpia la selección.
        if (!started && base.length === 0 && live.current.selection.length > 0) live.current.setSelection([])
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => { document.removeEventListener('pointerdown', onDown, true) }
  }, [])

  // Esc limpia; Supr pide borrar (fuera de los campos de texto).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (live.current.selection.length === 0 || typing(event.target)) return
      if (event.key === 'Escape') {
        live.current.setSelection([])
      } else if (event.key === 'F2' && live.current.selection.length === 1 && !isSubchat(live.current.selection[0]!)) {
        event.preventDefault()
        live.current.renameSession(live.current.selection[0]!)
      } else if (event.key === 'Delete') {
        event.preventDefault()
        setConfirming(live.current.selection)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [])

  // Arrastrar chats de «Ungrouped» sobre un proyecto compatible.
  useEffect(() => {
    let dragged: readonly SessionId[] | null = null
    let over: Element | null = null
    const clearOver = () => {
      over?.removeAttribute(DROP_ATTR)
      over = null
    }
    const targetOf = (event: DragEvent): { row: Element; workspaceId: string } | null => {
      const row = (event.target as Element | null)?.closest(WORKSPACE)
      if (row === null || row === undefined || dragged === null) return null
      const workspaceId = row.getAttribute('data-row-key')!.slice('workspace:'.length)
      if (workspaceId === '') return null
      const options = live.current.moveOptions(dragged)
      return options?.targets.some(target => target.workspaceId === workspaceId) === true ? { row, workspaceId } : null
    }
    const onStart = (event: DragEvent) => {
      const row = (event.target as Element | null)?.closest(SESSION)
      if (row === null || row === undefined) return
      const id = idOf(row)
      const current = live.current.selection
      dragged = current.includes(id) ? current : [id]
    }
    const onOver = (event: DragEvent) => {
      const target = targetOf(event)
      if (target === null) {
        if (over !== null && !(event.target as Element | null)?.closest(WORKSPACE)) clearOver()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
      if (over !== target.row) {
        clearOver()
        over = target.row
        over.setAttribute(DROP_ATTR, '')
      }
    }
    const onDrop = (event: DragEvent) => {
      const target = targetOf(event)
      if (target === null || dragged === null) return
      event.preventDefault()
      event.stopPropagation()
      const ids = dragged
      clearOver()
      void live.current.moveMany(ids, { workspaceId: target.workspaceId }).then((failed) => {
        if (failed.length > 0) setError(t('local.sel.moveFailed', { titles: failed.join(', ') }))
        else live.current.setSelection([])
      })
    }
    const onEnd = () => {
      dragged = null
      clearOver()
    }
    document.addEventListener('dragstart', onStart, true)
    document.addEventListener('dragover', onOver, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('dragend', onEnd, true)
    return () => {
      document.removeEventListener('dragstart', onStart, true)
      document.removeEventListener('dragover', onOver, true)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('dragend', onEnd, true)
    }
  }, [t])

  const report = (failed: readonly string[], key: 'local.sel.moveFailed' | 'local.sel.actionFailed') => {
    if (failed.length > 0) setError(t(key, { titles: failed.join(', ') }))
  }

  // Menú contextual: las mismas filas y el mismo aspecto que el resto de menús de la app.
  const items = (ids: readonly SessionId[]): MenuEntry[] => {
    // Con subchats en la selección, solo lo que vale para ellos: borrar.
    if (ids.some(isSubchat)) {
      return [{
        id: 'delete', danger: true, icon: <IconTrashOutlineRegular size={14} />,
        label: ids.length === 1 ? t('local.deleteSession.action') : t('local.sel.deleteMany', { n: ids.length }),
        shortcut: { keys: ['Del'], aria: 'Delete' },
      }]
    }
    const single = ids.length === 1
    const allPinned = ids.every(isPinned)
    const options = moveOptions(ids)
    const entries: MenuEntry[] = []
    // Las mismas filas que el menú «⋯» oficial (Pin, Rename, Branch, Archive, Copy
    // session ID) más Open, Move to project y Delete: es el menú de los dos sitios.
    if (single) entries.push({ id: 'open', label: t('local.sel.open'), icon: <IconRightUpOutlineRegular size={14} /> })
    entries.push({ id: allPinned ? 'unpin' : 'pin', label: t(allPinned ? 'local.sel.unpin' : 'local.sel.pin'), icon: <IconPinOutlineRegular size={14} /> })
    if (single) {
      entries.push({ id: 'rename', label: t('local.sel.rename'), icon: <IconEditOutlineRegular size={14} />, shortcut: { keys: ['F2'], aria: 'F2' } })
      entries.push({ id: 'fork', label: t('local.sel.fork'), icon: <IconBranchOutlineRegular size={14} /> })
    }
    entries.push({ id: 'archive', label: single ? t('local.sel.archive') : t('local.sel.archiveMany', { n: ids.length }), icon: <IconArchiveOutlineRegular size={14} /> })
    if (options !== null) {
      const submenu: MenuItem[] = options.targets.map(target => ({ id: `move:${target.workspaceId}`, label: target.title }))
      if (options.newFolder !== undefined) submenu.push({ id: 'move-new', label: t('local.sel.newProject', { folder: options.newFolder }) })
      if (submenu.length === 0) submenu.push({ id: 'move-none', label: t('local.sel.noTarget'), disabled: true })
      entries.push({ id: 'move', label: t('local.sel.move'), icon: <IconWorkspaceTreeOutlineRegular size={14} />, submenu })
    }
    if (single) entries.push({ id: 'copy-id', label: t('local.sel.copyId'), icon: <IconCopyOutlineRegular size={14} /> })
    entries.push({ type: 'separator', id: 'sep-delete' })
    entries.push({
      id: 'delete', danger: true, icon: <IconTrashOutlineRegular size={14} />,
      label: single ? t('local.deleteSession.action') : t('local.sel.deleteMany', { n: ids.length }),
      shortcut: { keys: ['Del'], aria: 'Delete' },
    })
    return entries
  }

  const choose = (choice: string) => {
    const ids = menu?.ids ?? []
    setMenu(null)
    setError(null)
    if (ids.length === 0) return
    if (choice === 'open') {
      openSession(ids[0]!)
    } else if (choice === 'rename') {
      renameSession(ids[0]!)
    } else if (choice === 'fork') {
      forkSession(ids[0]!)
    } else if (choice === 'copy-id') {
      copySessionId(ids[0]!)
    } else if (choice === 'pin' || choice === 'unpin') {
      void pinMany(ids, choice === 'pin').then(failed => { report(failed, 'local.sel.actionFailed') })
    } else if (choice === 'archive' && ids.length === 1) {
      archiveOne(ids[0]!)
      setSelection([])
    } else if (choice === 'archive') {
      void archiveMany(ids).then((failed) => {
        report(failed, 'local.sel.actionFailed')
        setSelection([])
      })
    } else if (choice === 'delete') {
      setConfirming(ids)
    } else if (choice === 'move-new' || choice.startsWith('move:')) {
      const options = moveOptions(ids)
      const target = choice === 'move-new' && options?.newFolder !== undefined
        ? { newFolder: options.newFolder }
        : { workspaceId: choice.slice('move:'.length) }
      void moveMany(ids, target).then((failed) => {
        report(failed, 'local.sel.moveFailed')
        if (failed.length === 0) setSelection([])
      })
    }
  }

  const remove = () => {
    const ids = confirming ?? []
    setProgress(0)
    setError(null)
    deleteMany(ids, setProgress).then((failed) => {
      setProgress(null)
      // Quien guarde algo de estas sesiones (p. ej. los subchats de la barra lateral) se entera.
      window.dispatchEvent(new CustomEvent('dpseek-local-deleted', { detail: ids }))
      if (failed.length > 0) {
        setError(t('local.bulk.failed', { titles: failed.join(', ') }))
        return
      }
      setConfirming(null)
      setSelection([])
    }, (reason: unknown) => {
      setProgress(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const busy = progress !== null
  const count = confirming?.length ?? 0
  // Un subchat hereda el título de su chat: en el aviso va el nombre que se ve en su fila.
  const titles = confirming === null ? [] : confirming.map((id) => isSubchat(id)
    ? document.querySelector(`[data-row-key="subchat:${CSS.escape(id)}"]`)?.textContent?.trim() ?? id
    : titlesOf([id])[0] ?? id)

  return (
    <>
      {box !== null && (
        <div className={css.marquee} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-hidden="true" />
      )}
      {menu !== null && (
        <Menu
          open
          portal
          dense
          autoFocus
          anchor={<span className={css.menuAnchor} />}
          listClassName={css.menuList}
          getAnchorRect={() => menu.rect}
          items={items(menu.ids)}
          onSelect={choose}
          onClose={() => { setMenu(null) }}
        />
      )}
      {error !== null && confirming === null && (
        <div className={css.toast} role="alert" onClick={() => { setError(null) }}>{error}</div>
      )}
      {confirming !== null && (
        <Modal
          open
          onClose={() => { if (!busy) setConfirming(null) }}
          closeLabel={t('close')}
          title={count === 1 ? t('local.deleteSession.title') : t('local.bulk.title', { n: count })}
          description={count === 1 ? t('local.deleteSession.desc', { title: titles[0] ?? '' }) : t('local.bulk.desc')}
          footer={(
            <>
              <Button variant="outline" disabled={busy} onClick={() => { setConfirming(null) }}>{t('cancel')}</Button>
              <Button variant="outline" className={browserCss.deleteAction} disabled={busy} onClick={remove}>
                {count === 1 ? t('local.deleteSession.action') : t('local.bulk.confirm', { n: count })}
              </Button>
            </>
          )}
        >
          {count > 1 && (
            <ul className={css.titles}>
              {titles.slice(0, 8).map((title, i) => <li key={`${String(i)}-${title}`}>{title}</li>)}
              {titles.length > 8 && <li>{t('local.bulk.more', { n: titles.length - 8 })}</li>}
            </ul>
          )}
          {busy && (
            <div className={browserCss.deleteStatus} role="status">
              {t('local.bulk.progress', { done: progress, n: count })}
            </div>
          )}
          {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
        </Modal>
      )}
    </>
  )
}

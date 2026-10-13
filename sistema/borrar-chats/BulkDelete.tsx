/**
 * Eliminar varios chats a la vez (añadido por dpseek-local-updater).
 *
 * «Seleccionar varios» en el menú de un chat activa el modo selección: cada
 * chat de la barra lateral muestra una casilla en su celda inicial
 * (`sidebar.session.row.leading`) y aparece una barra flotante (`shell.overlay`)
 * con el recuento, «Todos», «Eliminar» y «Cancelar». Eliminar pide confirmación
 * y borra uno a uno con el mismo método que «Eliminar sesión».
 */
import { useState } from 'react'
import type { HostObservable, InjectFace, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, IconCheckOutlineRegular, IconChecklistOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionMenuItemProps } from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'
import css from './BulkDelete.module.css'

/** Estado del modo selección. */
export interface BulkSelection {
  readonly active: boolean
  readonly ids: readonly SessionId[]
}

/** Lo que reciben la fila del menú y las casillas. */
export interface BulkSelectInjected {
  hooks: { selection: HostObservable<BulkSelection> }
  /** Entra en modo selección con este chat marcado. */
  startSelection: (sessionId: SessionId) => void
  /** Marca o desmarca un chat. */
  toggleSelected: (sessionId: SessionId) => void
}

/** Lo que recibe la barra flotante. */
export interface BulkDeleteBarInjected {
  hooks: { selection: HostObservable<BulkSelection> }
  /** Marca todos los chats visibles (o los desmarca si ya lo están). */
  toggleAll: () => void
  /** Sale del modo selección. */
  cancelSelection: () => void
  /** Títulos de los chats, para la confirmación. */
  titlesOf: (ids: readonly SessionId[]) => string[]
  /** Borra los chats y avisa del avance; devuelve los que fallaron. */
  deleteMany: (ids: readonly SessionId[], progress: (done: number) => void) => Promise<string[]>
}

type CheckboxProps = PropsRuntime<'sidebar.session.row.leading'> & PropsLocale<'workspace'> & InjectFace<BulkSelectInjected>
type BarProps = PropsRuntime<'shell.overlay'> & PropsLocale<'workspace'>
  & Omit<BulkDeleteBarInjected, 'hooks'> & PropsHooks<BulkDeleteBarInjected['hooks']>

/**
 * Fila «Seleccionar varios» del menú del chat.
 * @param props - identidad del chat, estado del menú y la acción inyectada.
 * @returns la fila.
 */
export function BulkSelectMenuItem({
  sessionId, useMenuOpenState, startSelection, t,
}: SessionMenuItemProps<BulkSelectInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconChecklistOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        startSelection(sessionId)
      }}
    >
      {t('local.bulk.menu')}
    </MenuItemButton>
  )
}

/**
 * Casilla de un chat en modo selección; fuera de él no ocupa nada.
 * @param props - identidad del chat y el estado de la selección.
 * @returns la casilla, o null.
 */
export function BulkSelectCheckbox({ sessionId, useSelection, toggleSelected, t }: CheckboxProps) {
  const active = useSelection(selection => selection.active)
  const checked = useSelection(selection => selection.ids.includes(sessionId))
  if (!active) return null
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={t('local.bulk.select')}
      className={css.checkbox}
      data-checked={checked ? '' : undefined}
      // La fila abre el chat al pulsarla; la casilla solo marca.
      onClick={(event) => {
        event.stopPropagation()
        toggleSelected(sessionId)
      }}
    >
      {checked && <IconCheckOutlineRegular size={12} />}
    </button>
  )
}

/**
 * Barra flotante del modo selección y su confirmación.
 * @param props - estado de la selección y las acciones inyectadas.
 * @returns la barra, o null fuera del modo selección.
 */
export function BulkDeleteBar({
  useSelection, toggleAll, cancelSelection, titlesOf, deleteMany, t,
}: BarProps) {
  const selection = useSelection(state => state)
  const [confirming, setConfirming] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!selection.active) return null
  const count = selection.ids.length
  const deleting = progress !== null
  const titles = confirming ? titlesOf(selection.ids) : []
  const confirm = () => {
    setProgress(0)
    setError(null)
    deleteMany(selection.ids, setProgress).then((failed) => {
      setProgress(null)
      if (failed.length > 0) {
        setError(t('local.bulk.failed', { titles: failed.join(', ') }))
        return
      }
      setConfirming(false)
      cancelSelection()
    }).catch((reason: unknown) => {
      setProgress(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <>
      <div className={css.bar} role="toolbar" aria-label={t('local.bulk.menu')}>
        <span className={css.count}>{t('local.bulk.count', { n: count })}</span>
        <Button variant="outline" size="sm" onClick={toggleAll}>{t('local.bulk.all')}</Button>
        <Button
          variant="outline"
          size="sm"
          className={browserCss.deleteAction}
          disabled={count === 0}
          onClick={() => { setConfirming(true) }}
        >
          {t('local.deleteSession.action')}
        </Button>
        <Button variant="outline" size="sm" onClick={cancelSelection}>{t('cancel')}</Button>
      </div>
      {confirming && (
        <Modal
          open
          onClose={() => { if (!deleting) setConfirming(false) }}
          closeLabel={t('close')}
          title={t('local.bulk.title', { n: count })}
          description={t('local.bulk.desc')}
          footer={(
            <>
              <Button variant="outline" disabled={deleting} onClick={() => { setConfirming(false) }}>{t('cancel')}</Button>
              <Button variant="outline" className={browserCss.deleteAction} disabled={deleting} onClick={confirm}>
                {t('local.bulk.confirm', { n: count })}
              </Button>
            </>
          )}
        >
          <ul className={css.titles}>
            {titles.slice(0, 8).map((title, i) => <li key={`${String(i)}-${title}`}>{title}</li>)}
            {titles.length > 8 && <li>{t('local.bulk.more', { n: titles.length - 8 })}</li>}
          </ul>
          {deleting && (
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

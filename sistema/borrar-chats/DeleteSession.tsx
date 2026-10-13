/**
 * «Eliminar sesión» (añadido por dpseek-local-updater): una fila más en el menú
 * de cada chat de la barra lateral, también en los de «Sin agrupar», y el
 * diálogo de confirmación en `shell.overlay`. El borrado lo hace el Host
 * (`session.deletePermanently`); esto solo pide confirmación y refresca la lista.
 */
import { useState } from 'react'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionMenuItemProps } from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/** Chat cuyo borrado espera confirmación. */
export interface SessionDeleteRequest {
  sessionId: SessionId
  displayTitle: string
}

/** Lo que recibe la fila del menú. */
export interface DeleteSessionInjected {
  /** Abre el diálogo de confirmación para ese chat. */
  requestSessionDelete: (sessionId: SessionId) => void
}

/** Lo que recibe el diálogo. */
export interface SessionDeleteDialogInjected {
  hooks: {
    deleteRequest: HostObservable<SessionDeleteRequest | null>
  }
  /** Cierra el diálogo (confirmado o cancelado). */
  settleSessionDelete: () => void
  /** Detiene, archiva y borra el chat; termina cuando la lista ya no lo muestra. */
  deleteSession: (sessionId: SessionId) => Promise<void>
}

export type SessionDeleteDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'workspace'>
  & Omit<SessionDeleteDialogInjected, 'hooks'>
  & PropsHooks<SessionDeleteDialogInjected['hooks']>

/**
 * Fila del menú (orden 500, tras «Archivar»).
 * @param props - identidad del chat, estado del menú y la acción inyectada.
 * @returns la fila.
 */
export function DeleteSessionMenuItem({
  sessionId, useMenuOpenState, requestSessionDelete, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      danger
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        requestSessionDelete(sessionId)
      }}
    >
      {t('local.deleteSession.menu')}
    </MenuItemButton>
  )
}

/**
 * Entrada de `shell.overlay`: nada mientras no hay petición; si la hay, un
 * diálogo por chat.
 * @param props - la petición pendiente, su cierre y el borrado.
 * @returns el diálogo abierto, o null.
 */
export function SessionDeleteDialog({
  useDeleteRequest, settleSessionDelete, deleteSession, t,
}: SessionDeleteDialogProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return (
    <DeleteConfirmForm
      key={request.sessionId}
      request={request}
      deleteSession={deleteSession}
      onSettle={settleSessionDelete}
      t={t}
    />
  )
}

function DeleteConfirmForm({ request, deleteSession, onSettle, t }: {
  request: SessionDeleteRequest
  deleteSession: SessionDeleteDialogInjected['deleteSession']
  onSettle: () => void
  t: SessionDeleteDialogProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (deleting) return
    onSettle()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    deleteSession(request.sessionId).then(() => {
      setDeleting(false)
      onSettle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('local.deleteSession.title')}
      description={t('local.deleteSession.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={browserCss.deleteAction} disabled={deleting} onClick={confirm}>
            {t('local.deleteSession.action')}
          </Button>
        </>
      )}
    >
      {deleting && <div className={browserCss.deleteStatus} role="status">{t('local.deleteSession.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}


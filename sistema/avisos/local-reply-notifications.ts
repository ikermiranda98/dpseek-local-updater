/**
 * Aviso de Windows al terminar una respuesta (añadido por dpseek-local-updater).
 *
 * Cuando un chat deja de estar en marcha y la ventana no tiene el foco (otra app
 * delante o minimizada), sale una notificación con el título del chat; al
 * pulsarla se abre ese chat. Los subagentes no avisan.
 */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const TEXT: Readonly<Record<string, string>> = {
  es: 'Respuesta terminada',
  zh: '回复已完成',
  en: 'Reply finished',
}

function bodyText(): string {
  const lang = document.documentElement.lang.toLowerCase()
  return TEXT[lang.slice(0, 2)] ?? TEXT.en ?? ''
}

/**
 * Vigila la lista de chats y avisa de los que terminan en segundo plano.
 * @param sessions - lista de chats del cliente.
 * @param open - abre un chat al pulsar el aviso.
 * @returns la función que deja de vigilar.
 */
export function installLocalReplyNotifications(sessions: ISessions, open: (sessionId: SessionId) => void): () => void {
  if (typeof Notification === 'undefined') return () => undefined
  let running = new Set<SessionId>()
  const check = (): void => {
    const list = sessions.list.getSnapshot()
    const now = new Set(list.ids.filter(id => list.byId[id]?.running === true))
    const background = document.visibilityState !== 'visible' || !document.hasFocus()
    for (const id of running) {
      if (now.has(id) || !background || Notification.permission === 'denied') continue
      const row = list.byId[id]
      if (row === undefined || row.parentId !== undefined || row.origin === 'subagent') continue
      const notification = new Notification(row.displayTitle, { body: bodyText() })
      notification.onclick = () => {
        window.focus()
        open(id)
        notification.close()
      }
    }
    running = now
  }
  check()
  return sessions.list.subscribe(check)
}

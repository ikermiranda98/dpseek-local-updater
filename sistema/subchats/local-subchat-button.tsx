/**
 * Subchats, lado del chat (añadido por dpseek-local-updater).
 *
 * «Open in subchat» bajo cada respuesta: pide la tarea y abre un subchat que
 * empieza con toda la conversación (subagente «fork» oficial), trabaja con
 * esfuerzo alto y con subagentes si le hacen falta, y devuelve al chat principal
 * solo su respuesta final (localStartSubchat en el Host). El subchat se abre a la
 * derecha y queda anidado bajo el chat en la barra lateral.
 */
import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, IconTreeCornerRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { startLocalSubchat } from './local-subchat-start.ts'
import { setSubchatStarter } from './local-subchat-store.ts'
import css from './local-subchat-button.module.css'

let localCtx: Context | undefined

/** @param ctx - contexto de ui-chat, o nada al descargarse. */
export function setLocalSubchat(ctx: Context | undefined): void {
  localCtx = ctx
  setSubchatStarter(ctx === undefined ? undefined : (sessionId, task) => startLocalSubchat(ctx, sessionId, task))
}

const SubchatSession = createContext<string | undefined>(undefined)

/**
 * Da el chat a los botones «Open in subchat» de dentro.
 * @param props - chat y contenido.
 * @returns el contenido.
 */
export function LocalSubchatSession({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  return <SubchatSession.Provider value={sessionId}>{children}</SubchatSession.Provider>
}

/** Si el chat es un subagente (también los subchats), según la lista de sesiones. */
function isSubagent(sessionId: string): boolean {
  const sessions = localCtx?.get('sessions') as
    { list: { getSnapshot(): { byId: Record<string, { origin?: string } | undefined> } } } | undefined
  return sessions?.list.getSnapshot().byId[sessionId]?.origin === 'subagent'
}

/**
 * «Open in subchat» en las acciones de una respuesta.
 * @returns el botón y, al pulsarlo, el cuadro para escribir la tarea.
 */
export function LocalSubchatButton(): ReactNode {
  const sessionId = useContext(SubchatSession)
  const [open, setOpen] = useState(false)
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Dentro de un subchat (o de cualquier subagente) no se abre otro: el servicio de
  // subagentes solo los lanza desde un chat principal.
  if (sessionId === undefined || localCtx === undefined || isSubagent(sessionId)) return null
  const start = async (): Promise<void> => {
    const ctx = localCtx
    const text = task.trim()
    if (ctx === undefined || text === '') return
    setBusy(true)
    setError(null)
    try {
      await startLocalSubchat(ctx, sessionId, text)
      setOpen(false)
      setTask('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Tooltip label="Open in subchat" side="bottom">
        <button type="button" className={css.action} aria-label="Open in subchat" data-local-subchat
          onClick={() => { setOpen(true); setError(null) }}>
          <IconTreeCornerRegular />
        </button>
      </Tooltip>
      {open && (
        <Modal
          open
          onClose={() => { if (!busy) setOpen(false) }}
          closeLabel="Close"
          title="Open in subchat"
          description="The subchat starts with this whole conversation, works on its own with high effort (and subagents if it needs them) and sends only its final answer back here. It does not fill this chat's context."
          footer={(
            <>
              <Button variant="outline" disabled={busy} onClick={() => { setOpen(false) }}>Cancel</Button>
              <Button variant="primary" disabled={busy || task.trim() === ''} onClick={() => { void start() }}>
                {busy ? 'Starting…' : 'Start subchat'}
              </Button>
            </>
          )}
        >
          <textarea className={css.task} value={task} autoFocus rows={5} disabled={busy}
            placeholder="What should the subchat do? E.g. Review calc.py, find the bugs and give me the fixed code."
            onChange={(event) => { setTask(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void start() }
            }} />
          {error !== null && <p className={css.error}>{error}</p>}
          <p className={css.hint}>Ctrl+Enter to start</p>
        </Modal>
      )}
    </>
  )
}

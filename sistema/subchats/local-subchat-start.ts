/**
 * Abrir un subchat (añadido por dpseek-local-updater): lo usan el botón «Open in
 * subchat» de las respuestas y la sugerencia junto al medidor de contexto.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { addSubchat } from './local-subchat-store.ts'

/** Nombre corto del subchat: la primera línea de la tarea. */
function labelOf(task: string): string {
  const line = task.trim().split('\n')[0] ?? ''
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

/** Abre el subchat a la derecha, en una pestaña, como el catálogo oficial de subagentes. */
function openAside(ctx: Context, parentId: string, childId: string): void {
  const right = ctx.get('sidebarRight') as { openResource(address: string, options: object): void } | undefined
  const query = new URLSearchParams({ parent: parentId, mode: 'continuable' })
  try {
    right?.openResource(`dsh-resource://subagentchat/session/${encodeURIComponent(childId)}?${query}`, { kind: 'subagentchat' })
  } catch (error) {
    console.warn('local subchat:', error)
  }
}

/**
 * Lanza un subchat del chat, lo anota para la barra lateral y lo abre a la derecha.
 * @param ctx - contexto del plugin que lo pide.
 * @param sessionId - chat principal.
 * @param task - lo que debe hacer.
 * @returns la sesión del subchat.
 * @throws Error con el motivo si no se pudo lanzar.
 */
export async function startLocalSubchat(ctx: Context, sessionId: string, task: string): Promise<string> {
  const text = task.trim()
  const label = labelOf(text)
  const result = await ctx.remote.session.localStartSubchat({ sessionId: sessionId as SessionId, task: text, label })
  if (!result.ok) throw new Error(result.error.message)
  const childId = result.value.childSessionId
  addSubchat({ childId, parentId: sessionId, label, createdAt: Date.now() })
  openAside(ctx, sessionId, childId)
  return childId
}

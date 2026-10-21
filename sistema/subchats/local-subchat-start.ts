/**
 * Abrir un subchat y devolver su resultado (añadido por dpseek-local-updater).
 * Lo usan el botón «Open in subchat», el texto seleccionado, la sugerencia junto al
 * medidor de contexto y «Send to main chat».
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { addSubchat, subchatOf, updateSubchat } from './local-subchat-store.ts'

/** Nombre corto del subchat: la primera línea de la tarea (sin la cita de un texto seleccionado). */
function labelOf(task: string): string {
  const lines = task.trim().split('\n').map(line => line.trim()).filter(line => line !== '')
  const line = lines.find(candidate => !candidate.startsWith('>')) ?? lines[0]?.replace(/^>\s*/, '') ?? ''
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

/** Ancho del panel del subchat al abrirse: parte de la zona de chat (ventana menos barra lateral). */
const ASIDE_SHARE = 0.4

/**
 * Abre un subchat a la derecha, en una pestaña, como el catálogo oficial de subagentes.
 * @param ctx - contexto del plugin que lo pide.
 * @param parentId - chat principal.
 * @param childId - subchat.
 */
export function openSubchatAside(ctx: Context, parentId: string, childId: string): void {
  const right = ctx.get('sidebarRight') as { openResource(address: string, options: object): void } | undefined
  const query = new URLSearchParams({ parent: parentId, mode: 'continuable' })
  try {
    right?.openResource(`dsh-resource://subagentchat/session/${encodeURIComponent(childId)}?${query}`, { kind: 'subagentchat' })
    // Al 40 % de la zona de chat (sección 23 de aplicar-cambios.mjs); luego se redimensiona a mano.
    const layout = ctx.get('layout') as { localSetRightbarShare?: (share: number) => void } | undefined
    layout?.localSetRightbarShare?.(ASIDE_SHARE)
  } catch (error) {
    console.warn('local subchat:', error)
  }
}

/**
 * Lanza un subchat del chat, lo anota para la barra lateral y lo abre a la derecha.
 * @param ctx - contexto del plugin que lo pide.
 * @param sessionId - chat principal.
 * @param task - lo que debe hacer.
 * @param options - si el resultado espera a que el usuario lo revise.
 * @returns la sesión del subchat.
 * @throws Error con el motivo si no se pudo lanzar.
 */
export async function startLocalSubchat(ctx: Context, sessionId: string, task: string,
  options: { readonly review: boolean }): Promise<string> {
  const text = task.trim()
  const label = labelOf(text)
  const result = await ctx.remote.session.localStartSubchat({
    sessionId: sessionId as SessionId, task: text, label, ...options.review ? { review: true } : {},
  })
  if (!result.ok) throw new Error(result.error.message)
  const childId = result.value.childSessionId
  addSubchat({ childId, parentId: sessionId, label, createdAt: Date.now(), ...options.review ? { review: true } : {} })
  openSubchatAside(ctx, sessionId, childId)
  return childId
}

/**
 * Manda al chat principal una respuesta del subchat (o la última, sin texto).
 * @param ctx - contexto del plugin que lo pide.
 * @param childId - subchat.
 * @param text - respuesta a mandar.
 * @throws Error con el motivo si no se pudo.
 */
export async function deliverLocalSubchat(ctx: Context, childId: string, text?: string): Promise<void> {
  const subchat = subchatOf(childId)
  if (subchat === undefined) throw new Error('This subchat is not known to this app.')
  const result = await ctx.remote.session.localSubchatDeliver({
    sessionId: subchat.parentId as SessionId, childSessionId: childId as SessionId, label: subchat.label,
    ...text === undefined ? {} : { text },
  })
  if (!result.ok) throw new Error(result.error.message)
  updateSubchat(childId, { delivered: true })
}

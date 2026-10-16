/**
 * Puente para mejorar mensajes (añadido por dpseek-local-updater).
 *
 * El chat (ui-chat) tiene acceso a las llamadas del Host y las publica aquí; el
 * botón «Improve» del cuadro de texto (ui-conversation) las usa. Son paquetes
 * distintos y comparten un símbolo global.
 */

/** Llamadas al Host. */
export interface LocalImprover {
  /** La versión mejorada del borrador y lo que tardó (con el modelo del chat, salvo que se diga otro). */
  improve: (sessionId: string, draft: string, model?: string) => Promise<{ readonly text: string; readonly ms: number }>
}

interface Bridge {
  improver: LocalImprover | undefined
  readonly listeners: Set<() => void>
}

const KEY = Symbol.for('dpseek-local-updater.improver')
const bridge = ((globalThis as Record<symbol, unknown>)[KEY] ??= { improver: undefined, listeners: new Set() }) as Bridge

/** @param improver - llamadas al Host, o nada al descargarse el chat. */
export function setImprover(improver: LocalImprover | undefined): void {
  bridge.improver = improver
  for (const listener of bridge.listeners) listener()
}

/** @returns las llamadas al Host, si ya están. */
export function improver(): LocalImprover | undefined {
  return bridge.improver
}

/** @returns cómo dejar de escuchar. */
export function subscribeImprover(listener: () => void): () => void {
  bridge.listeners.add(listener)
  return () => { bridge.listeners.delete(listener) }
}

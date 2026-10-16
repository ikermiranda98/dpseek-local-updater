/**
 * Puente para mejorar mensajes (añadido por dpseek-local-updater).
 *
 * El chat (ui-chat) tiene acceso a las llamadas del Host y las publica aquí; el
 * botón «Improve» del cuadro de texto (ui-conversation) las usa. Son paquetes
 * distintos y comparten un símbolo global.
 */

/** Un documento adjunto, ya en texto. */
export interface LocalImproveDocument {
  readonly name: string
  readonly text: string
  readonly pages?: number
}

/** Lo que se pide además del borrador. */
export interface LocalImproveOptions {
  readonly document?: LocalImproveDocument
  readonly answers?: readonly { readonly question: string; readonly answer: string }[]
}

/** La sugerencia: el prompt, las preguntas si falta algo, una nota sobre el documento y lo que tardó. */
export interface LocalImproveSuggestion {
  readonly text: string
  readonly questions: readonly string[]
  readonly note?: string
  readonly ms: number
}

/** Llamadas al Host. */
export interface LocalImprover {
  /** El prompt mejorado (con el modelo del chat). */
  improve: (sessionId: string, draft: string, options?: LocalImproveOptions) => Promise<LocalImproveSuggestion>
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

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
  /** Otra versión: más corta, más detallada o en pasos. */
  readonly style?: LocalImproveStyle
  /** Con el razonamiento del modelo (más lento). */
  readonly think?: boolean
  /** Para seguirla (progress) y cancelarla (cancel). */
  readonly jobId?: string
  /** Qué hacer con el documento: implement, review, plan, explain u otra cosa con tus palabras. */
  readonly intent?: string
  /** Solo copiar las partes clave del documento, literalmente. */
  readonly keyParts?: boolean
  /** Corregir la sugerencia anterior con una frase. */
  readonly refine?: { readonly previous: string; readonly request: string }
  /** Traducir al inglés, corregir la gramática o pasar al idioma principal las frases en otro idioma. */
  readonly transform?: { readonly kind: 'english' | 'grammar' | 'unify'; readonly text: string }
}

/** Versiones además de la sugerida. */
export type LocalImproveStyle = 'short' | 'detailed' | 'steps'

/** Cómo va el documento debajo del prompt: sus títulos y, si se pidieron, sus partes clave. */
export interface LocalImproveDocumentBlock {
  readonly heading: string
  readonly keyHeading: string
  readonly key?: string
}

/** La sugerencia: el prompt, las preguntas si falta algo, una nota, cómo va el documento y lo que tardó. */
export interface LocalImproveSuggestion {
  readonly text: string
  readonly questions: readonly string[]
  readonly note?: string
  readonly document?: LocalImproveDocumentBlock
  readonly ms: number
}

/**
 * Prompt largo (el Host lo reorganiza entero en dos pasos y tarda minutos): el mismo criterio
 * que localIsLongPrompt en local-improve.ts.
 */
export function isLongPrompt(draft: string): boolean {
  const text = draft.trim()
  return text.length > 1200 || text.split('\n').filter(line => line.trim() !== '').length > 20
}

/** Llamadas al Host. */
export interface LocalImprover {
  /** El prompt mejorado (con el modelo del chat). */
  improve: (sessionId: string, draft: string, options?: LocalImproveOptions) => Promise<LocalImproveSuggestion>
  /** Lo que lleva escrito una petición en curso (fase vacía si ya acabó). */
  progress: (jobId: string) => Promise<{ readonly phase: string; readonly text: string }>
  /** Corta una petición en curso, también en Ollama. */
  cancel: (jobId: string) => Promise<void>
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

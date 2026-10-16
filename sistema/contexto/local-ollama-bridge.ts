/**
 * Puente para las actualizaciones de Ollama y de la app (añadido por dpseek-local-updater).
 *
 * El selector de modelos (ui-model-selection) tiene acceso a las llamadas del
 * Host y las publica aquí; el aviso de actualizaciones de abajo a la izquierda
 * (ui-settings-general) las usa. Son paquetes distintos y comparten un símbolo global.
 */

/** Estado de la actualización, como lo da el Host. */
export interface LocalOllamaUpdateState {
  readonly phase: 'idle' | 'waiting' | 'downloading' | 'installing' | 'starting' | 'done' | 'error'
  readonly percent?: number
  readonly waitingFor?: number
  readonly message?: string
  readonly version?: string
}

/** Versiones, novedades y estado. */
export interface LocalOllamaUpdateInfo {
  readonly installed: string | null
  readonly latest: string | null
  readonly available: boolean
  readonly highlights: readonly string[]
  readonly url: string | null
  readonly state: LocalOllamaUpdateState
}

/** Lo que cambia la versión nueva de la app para las funciones locales. */
export interface LocalAppUpdateNotes {
  readonly version: string
  readonly level: 'green' | 'amber' | 'red'
  readonly headline: string
  readonly detail: string
}

/** Llamadas al Host. */
export interface LocalOllamaUpdater {
  info: (force: boolean) => Promise<LocalOllamaUpdateInfo>
  start: () => Promise<{ readonly started: boolean }>
  /** Novedades de la versión nueva de la app (null si no se pueden leer). */
  appNotes: (version: string) => Promise<LocalAppUpdateNotes | null>
}

interface Bridge {
  updater: LocalOllamaUpdater | undefined
  readonly listeners: Set<() => void>
}

const KEY = Symbol.for('dpseek-local-updater.ollama-updater')
const bridge = ((globalThis as Record<symbol, unknown>)[KEY] ??= { updater: undefined, listeners: new Set() }) as Bridge

/** @param updater - llamadas al Host, o nada al descargarse el selector. */
export function setOllamaUpdater(updater: LocalOllamaUpdater | undefined): void {
  bridge.updater = updater
  for (const listener of bridge.listeners) listener()
}

/** @returns las llamadas al Host, si ya están. */
export function ollamaUpdater(): LocalOllamaUpdater | undefined {
  return bridge.updater
}

/** @returns cómo dejar de escuchar. */
export function subscribeOllamaUpdater(listener: () => void): () => void {
  bridge.listeners.add(listener)
  return () => { bridge.listeners.delete(listener) }
}

/**
 * Código en vivo (añadido por dpseek-local-updater): lo que el modelo está
 * escribiendo en el turno actual de cada chat.
 *
 * El chat (ui-chat) lo publica mientras llegan las llamadas a write/edit y la
 * pestaña «Live code» del panel derecho (ui-deliverables) lo dibuja. Son paquetes
 * distintos, así que comparten el estado por un símbolo global.
 */

/** Una escritura o edición de un fichero, tal y como va llegando. */
export interface LiveEdit {
  readonly callId: string
  /** `write` sustituye el fichero entero; `edit` cambia un trozo. */
  readonly kind: 'write' | 'edit'
  readonly status: 'writing' | 'running' | 'done' | 'failed'
  /** Contenido completo (write) o texto nuevo (edit), parcial mientras se escribe. */
  readonly text: string
  /** Texto sustituido (edit). */
  readonly oldText?: string
}

/** Un fichero tocado en el turno, con sus escrituras en orden. */
export interface LiveFile {
  readonly path: string
  readonly edits: readonly LiveEdit[]
}

/** El turno actual de un chat. */
export interface LiveTurn {
  readonly sessionId: string
  readonly turn: number
  readonly running: boolean
  readonly files: readonly LiveFile[]
  /** Evento `workspace/changes` del turno, cuando ya ha terminado y hay cambios que revisar. */
  readonly changesSeq?: number
  /** Pasos del turno con el navegador del agente (abrir, leer, escribir, pulsar…), en orden. */
  readonly browser?: readonly LiveBrowserStep[]
}

/** Un paso del agente con el navegador. */
export interface LiveBrowserStep {
  readonly callId: string
  /** Nombre de la herramienta sin el prefijo del servidor: «navigate», «click»… */
  readonly action: string
  /** Qué hace, en pocas palabras (la dirección, el elemento…); nunca lo que escribe en un campo. */
  readonly detail: string
  readonly status: 'running' | 'done' | 'failed'
}

interface LiveStore {
  readonly turns: Map<string, LiveTurn>
  readonly listeners: Set<() => void>
  readonly openers: Set<(sessionId: string) => void>
  browserOpeners?: Set<(sessionId: string) => void>
}

const KEY = Symbol.for('dpseek-local-updater.live-code')
const store = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  turns: new Map(), listeners: new Set(), openers: new Set(),
}) as LiveStore
store.browserOpeners ??= new Set()
const browserOpeners = store.browserOpeners

/** El chat pide abrir la pestaña «Agent browser». */
export function requestBrowserOpen(sessionId: string): void {
  for (const opener of browserOpeners) opener(sessionId)
}

/** @returns cómo dejar de atender las peticiones de abrir la pestaña «Agent browser». */
export function onBrowserOpen(opener: (sessionId: string) => void): () => void {
  browserOpeners.add(opener)
  return () => { browserOpeners.delete(opener) }
}

/** @param turn - estado nuevo del turno de un chat. */
export function publishLive(turn: LiveTurn): void {
  store.turns.set(turn.sessionId, turn)
  for (const listener of store.listeners) listener()
}

/** @returns el turno publicado de ese chat. */
export function liveSnapshot(sessionId: string): LiveTurn | undefined {
  return store.turns.get(sessionId)
}

/** @returns cómo dejar de escuchar. */
export function subscribeLive(listener: () => void): () => void {
  store.listeners.add(listener)
  return () => { store.listeners.delete(listener) }
}

/** El chat pide abrir la pestaña: el modelo ha empezado a escribir un fichero. */
export function requestLiveOpen(sessionId: string): void {
  for (const opener of store.openers) opener(sessionId)
}

/** @returns cómo dejar de atender las peticiones de abrir la pestaña. */
export function onLiveOpen(opener: (sessionId: string) => void): () => void {
  store.openers.add(opener)
  return () => { store.openers.delete(opener) }
}
